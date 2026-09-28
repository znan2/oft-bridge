// Replaces the local Hono server in the static demo. Any request that is not same-origin is refused,
// so the published page never talks to an RPC, metadata API or Scan.
import { CHAINS, isChainId } from '../../shared/chains';
import type { HealthResponse, NetworkHealth, RpcRequest, SettingsResponse } from '../../shared/api';
import { demoCatalog, demoProtocol, demoRpc, DemoRpcError } from './world';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const wait = () => new Promise(resolve => setTimeout(resolve, 60 + Math.random() * 90));

async function handle(url: URL, init?: RequestInit): Promise<Response> {
  await wait();
  const path = url.pathname.replace(/^\/api/, ''), method = (init?.method ?? 'GET').toUpperCase();
  if (path === '/health') return json({ ok: true, signing: false, network: 'testnet', executionMode: 'dry-run', walletExecution: false } satisfies HealthResponse);
  if (path === '/settings/rpc' && method === 'GET') return json({ revision: 0, chains: CHAINS.map(c => ({ chainId: c.id, custom: false, host: null })) } satisfies SettingsResponse);
  if (path.startsWith('/settings/rpc/')) return json({ code: 'INVALID_REQUEST', message: '데모에서는 RPC 설정을 바꿀 수 없습니다.' }, 400);
  if (path === '/metadata/ofts') return json(demoCatalog());
  if (path === '/metadata/protocol') return json(demoProtocol());
  const health = path.match(/^\/chains\/(\d+)\/health$/);
  if (health && isChainId(Number(health[1]))) {
    return json({ chainId: Number(health[1]), blockNumber: String(BigInt(demoRpc(Number(health[1]), 'eth_blockNumber', []) as string)), latencyMs: 42, checkedAt: new Date().toISOString(), mode: 'public', host: 'mock-rpc.demo', fallbackUsed: false, revision: 0 } satisfies NetworkHealth);
  }
  const rpc = path.match(/^\/rpc\/(\d+)$/);
  if (rpc && isChainId(Number(rpc[1])) && method === 'POST') {
    const request = JSON.parse(String(init?.body)) as RpcRequest;
    try { return json({ jsonrpc: '2.0', id: request.id, result: demoRpc(Number(rpc[1]), request.method, request.params) }); }
    catch (error) { const e = error as DemoRpcError; return json({ jsonrpc: '2.0', id: request.id, error: { code: e.code ?? -32000, message: e.message } }); }
  }
  if (path.startsWith('/scan/')) return json({ code: 'SCAN_ERROR', message: '데모에서는 LayerZero Scan을 조회하지 않습니다.' }, 503);
  return json({ code: 'INVALID_REQUEST', message: '데모에서 지원하지 않는 요청입니다.' }, 404);
}

export function installDemoBackend() {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.href);
    if (url.origin !== window.location.origin) throw new TypeError('demo: external network disabled');
    return url.pathname.startsWith('/api/') ? handle(url, init) : nativeFetch(input, init);
  };
}
