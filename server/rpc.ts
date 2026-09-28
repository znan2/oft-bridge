import { chainById, type ChainId } from '../shared/chains';
import type { NetworkHealth, RpcRequest, RpcResponse } from '../shared/api';
import { redactSecrets } from '../shared/redact';
import { AppError, rpcError } from './errors';
import { SettingsStore, validateRpcUrl } from './settings';

export const READ_METHODS = new Set([
  'eth_chainId', 'eth_blockNumber', 'eth_getBalance', 'eth_getCode', 'eth_call',
  'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
  'eth_getTransactionCount', 'eth_getTransactionByHash', 'eth_getTransactionReceipt',
  'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getLogs', 'eth_getStorageAt',
]);
export function parseRpcRequest(body: unknown): RpcRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('INVALID_REQUEST', '잘못된 RPC 요청입니다.');
  const r = body as Record<string, unknown>;
  if (r.jsonrpc !== '2.0' || !['number', 'string'].includes(typeof r.id) || typeof r.method !== 'string' || !Array.isArray(r.params)) {
    throw new AppError('INVALID_REQUEST', '잘못된 RPC 요청입니다.');
  }
  if (!READ_METHODS.has(r.method)) throw new AppError('METHOD_NOT_ALLOWED', '조회 서버에서 허용하지 않는 RPC 메서드입니다.', 403);
  return r as unknown as RpcRequest;
}

class TransportError extends Error {}
async function boundedJson(response: Response, limit = 2_000_000): Promise<unknown> {
  if (!response.body) throw new TransportError();
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new TransportError();
      chunks.push(value);
    }
  } catch (e) { await reader.cancel(); throw e; }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export class RpcGateway {
  // endpoints: public RPC list override (checks/tests). envEndpoints: private RPCs from OFT_RPC_URL_<chainId>.
  constructor(private store: SettingsStore, private options: { fetch?: typeof fetch; timeoutMs?: number; endpoints?: Partial<Record<ChainId, readonly string[]>>; envEndpoints?: Partial<Record<ChainId, readonly string[]>> } = {}) {}
  private async call(url: string, request: RpcRequest): Promise<RpcResponse> {
    try {
      const response = await (this.options.fetch ?? fetch)(url, {
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request), signal: AbortSignal.timeout(this.options.timeoutMs ?? 6000),
      });
      if (!response.ok) { await response.body?.cancel(); throw new TransportError(); }
      const result = await boundedJson(response) as RpcResponse;
      if (!result || result.jsonrpc !== '2.0' || result.id !== request.id || (!('result' in result) && !result.error)) throw new TransportError();
      if (result.error) {
        if (typeof result.error.code !== 'number' || typeof result.error.message !== 'string') throw new TransportError();
        if ([-32601, -32603, -32005, -32016].includes(result.error.code) || /rate limit|too many requests|quota|capacity|temporarily unavailable|method not supported/i.test(result.error.message)) throw new TransportError();
        // Load-balanced public nodes can report a new tip then serve a lagging backend for the fixed-block read.
        // Retry only provider block/state availability errors; preserve actual EVM reverts as contract errors.
        if (result.error.code !== 3 && !/execution reverted/i.test(result.error.message) && /^(?:block not found|header not found|unknown block|missing trie node|historical state unavailable|state is not available)(?:\b|:)/i.test(result.error.message)) throw new TransportError();
        // Contract execution errors remain JSON-RPC errors; they are not transport failures.
        return { jsonrpc: '2.0', id: request.id, error: { code: result.error.code, message: redactSecrets(result.error.message).slice(0, 600), ...(typeof result.error.data === 'string' && /^0x[0-9a-f]*$/i.test(result.error.data) ? { data: result.error.data } : {}) } };
      }
      return { jsonrpc: '2.0', id: request.id, result: result.result };
    } catch (error) {
      if (error instanceof TransportError) throw error;
      throw new TransportError();
    }
  }
  private async checkedCall(url: string, chainId: ChainId, request: RpcRequest) {
    const probe = await this.call(url, { jsonrpc: '2.0', id: 'oft-chain-check', method: 'eth_chainId', params: [] });
    if (probe.error || typeof probe.result !== 'string' || !/^0x[0-9a-f]+$/i.test(probe.result)) throw new TransportError();
    if (BigInt(probe.result) !== BigInt(chainId)) throw new AppError('RPC_CHAIN_MISMATCH', `RPC 오류 — 선택한 ${chainById(chainId).shortName} 네트워크와 일치하지 않습니다.`, 503);
    if (request.method === 'eth_chainId') return { ...probe, id: request.id };
    const response = await this.call(url, request);
    if (!response.error && ['eth_blockNumber', 'eth_getBalance', 'eth_gasPrice', 'eth_getTransactionCount', 'eth_estimateGas', 'eth_maxPriorityFeePerGas'].includes(request.method)) {
      if (typeof response.result !== 'string' || !/^0x[0-9a-f]+$/i.test(response.result)) throw new TransportError();
    }
    return response;
  }
  async request(chainId: ChainId, request: RpcRequest) {
    parseRpcRequest(request);
    const snapshot = this.store.snapshot(chainId);
    // Priority: RPC saved from the dashboard > OFT_RPC_URL_<chainId> > public registry RPCs.
    const env = this.options.envEndpoints?.[chainId];
    const endpoints = snapshot.url ? [snapshot.url] : (env ?? this.options.endpoints?.[chainId] ?? chainById(chainId).rpcs);
    if (!endpoints.length) throw new AppError('RPC_ERROR', `RPC 오류 — ${chainById(chainId).shortName}에 등록된 공개 RPC가 없습니다. RPC 주소를 직접 입력하세요.`, 503);
    let mismatch: AppError | undefined;
    for (const [index, url] of endpoints.entries()) {
      const started = performance.now();
      try {
        const response = await this.checkedCall(url, chainId, request);
        return { response, revision: snapshot.revision, mode: snapshot.url ? 'custom' as const : env ? 'env' as const : 'public' as const, host: new URL(url).hostname, latencyMs: Math.round(performance.now() - started), fallbackUsed: index > 0 };
      } catch (error) {
        if (error instanceof AppError) mismatch = error;
      }
    }
    if (snapshot.url && mismatch) throw mismatch;
    throw rpcError(chainById(chainId).shortName);
  }
  async health(chainId: ChainId): Promise<NetworkHealth> {
    const { response, ...info } = await this.request(chainId, { jsonrpc: '2.0', id: 'oft-health', method: 'eth_blockNumber', params: [] });
    if (response.error || typeof response.result !== 'string' || !/^0x[0-9a-f]+$/i.test(response.result)) throw rpcError(chainById(chainId).shortName);
    return { ...info, chainId, blockNumber: BigInt(response.result).toString(), checkedAt: new Date().toISOString() };
  }
  async setCustom(chainId: ChainId, input: unknown) {
    const url = validateRpcUrl(input);
    try {
      const result = await this.checkedCall(url, chainId, { jsonrpc: '2.0', id: 'oft-custom-check', method: 'eth_blockNumber', params: [] });
      if (result.error || typeof result.result !== 'string' || !/^0x[0-9a-f]+$/i.test(result.result)) throw new TransportError();
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw rpcError(chainById(chainId).shortName);
    }
    return this.store.set(chainId, url);
  }
}
