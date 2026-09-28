import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore } from '../server/settings';
import { RpcGateway } from '../server/rpc';
import { createApp } from '../server/app';

let directory: string;
let store: SettingsStore;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'oft-rpc-test-')); store = new SettingsStore(join(directory, 'rpc.json')); await store.load(); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const request = { jsonrpc: '2.0' as const, id: 7, method: 'eth_blockNumber', params: [] };
function upstream(handler: (url: string, method: string) => unknown | Promise<unknown>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string);
    const value = await handler(String(input), body.method);
    if (value instanceof Response) return value;
    return Response.json({ jsonrpc: '2.0', id: body.id, ...(value && typeof value === 'object' && 'error' in value ? value : { result: value }) });
  }) as ReturnType<typeof vi.fn> & typeof fetch;
}

describe('RPC gateway', () => {
  it('falls back from a failed public RPC and checks chain identity before reading', async () => {
    const mock = upstream((url, method) => { if (url.includes('bad')) throw new Error('offline'); return method === 'eth_chainId' ? '0x38' : '0x64'; });
    const gateway = new RpcGateway(store, { fetch: mock, endpoints: { 56: ['https://bad.test', 'https://good.test'] } });
    expect(await gateway.health(56)).toMatchObject({ chainId: 56, blockNumber: '100', fallbackUsed: true, host: 'good.test', mode: 'public' });
    expect(mock.mock.calls.map(([, init]) => JSON.parse(init!.body as string).method)).toEqual(['eth_chainId', 'eth_chainId', 'eth_blockNumber']);
  });
  it('does not accept a response from the wrong chain', async () => {
    const mock = upstream((url, method) => method === 'eth_chainId' ? (url.includes('wrong') ? '0x1' : '0x38') : '0x80');
    const gateway = new RpcGateway(store, { fetch: mock, endpoints: { 56: ['https://wrong.test', 'https://bsc.test'] } });
    expect(await gateway.health(56)).toMatchObject({ blockNumber: '128', fallbackUsed: true });
    await expect(gateway.setCustom(56, 'https://wrong.test/key')).rejects.toMatchObject({ code: 'RPC_CHAIN_MISMATCH' });
    expect(store.snapshot(56).url).toBeUndefined();
  });
  it('reports RPC error after public providers fail instead of returning a zero balance', async () => {
    const mock = upstream(() => { throw new Error('secret API key in underlying error'); });
    const gateway = new RpcGateway(store, { fetch: mock, endpoints: { 1: ['https://offline.test'] } });
    await expect(gateway.health(1)).rejects.toMatchObject({ code: 'RPC_ERROR', message: expect.stringContaining('RPC 오류 — Ethereum') });
  });
  it('keeps a contract revert distinct from a network failure', async () => {
    const mock = upstream((_, method) => method === 'eth_chainId' ? '0x38' : { error: { code: 3, message: 'execution reverted', data: '0x12345678' } });
    const gateway = new RpcGateway(store, { fetch: mock, endpoints: { 56: ['https://one.test', 'https://two.test'] } });
    expect((await gateway.request(56, { ...request, method: 'eth_call', params: [{ to: '0x0000000000000000000000000000000000000001' }, 'latest'] })).response.error).toEqual({ code: 3, message: 'execution reverted', data: '0x12345678' });
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it('rejects JSON-RPC responses with unrelated ids', async () => {
    const mock = vi.fn(async () => Response.json({ jsonrpc: '2.0', id: 'unrelated', result: '0x38' })) as unknown as typeof fetch;
    await expect(new RpcGateway(store, { fetch: mock, endpoints: { 56: ['https://bad.test'] } }).health(56)).rejects.toMatchObject({ code: 'RPC_ERROR' });
  });
  it('never forwards broadcast or signing methods', async () => {
    const mock = upstream(() => '0x38');
    const gateway = new RpcGateway(store, { fetch: mock });
    for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'personal_sign', 'eth_sign', 'wallet_switchEthereumChain']) {
      await expect(gateway.request(56, { ...request, method })).rejects.toMatchObject({ code: 'METHOD_NOT_ALLOWED' });
    }
    expect(mock).not.toHaveBeenCalled();
  });
  it('persists validated custom RPCs for each chain without exposing URL secrets', async () => {
    const mock = upstream((url, method) => method === 'eth_chainId' ? (url.includes('bsc') ? '0x38' : '0x1') : '0x64');
    const gateway = new RpcGateway(store, { fetch: mock });
    await Promise.all([gateway.setCustom(56, 'https://bsc.test/private-key?token=secret'), gateway.setCustom(1, 'https://eth.test/key')]);
    expect(JSON.stringify(store.summary())).not.toMatch(/private-key|secret/);
    const restored = new SettingsStore(join(directory, 'rpc.json')); await restored.load();
    expect(restored.snapshot(56).url).toContain('private-key');
    expect(restored.snapshot(1).url).toBe('https://eth.test/key');
    expect(restored.summary().revision).toBe(store.summary().revision);
    expect((await stat(join(directory, 'rpc.json'))).mode & 0o777).toBe(0o600);
    expect((await gateway.health(56)).mode).toBe('custom');
    await store.set(56, null);
    expect(JSON.parse(await readFile(join(directory, 'rpc.json'), 'utf8')).custom['56']).toBeUndefined();
    expect(store.snapshot(1).url).toBeDefined();
  });
  it('does not silently replace a failing custom RPC with a public RPC', async () => {
    await store.set(56, 'https://offline.test/key');
    const mock = upstream(() => { throw new Error('offline'); });
    await expect(new RpcGateway(store, { fetch: mock }).health(56)).rejects.toMatchObject({ code: 'RPC_ERROR' });
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid custom URLs before connecting', async () => {
    const mock = upstream(() => '0x38');
    const gateway = new RpcGateway(store, { fetch: mock });
    for (const url of ['hello', 'file:///etc/passwd', 'http://public.test', 'https://user:password@rpc.test', 'http://127.0.0.1:4318/api/rpc/56']) {
      await expect(gateway.setCustom(56, url)).rejects.toMatchObject({ code: 'RPC_INVALID_URL' });
    }
    expect(mock).not.toHaveBeenCalled();
  });
});

describe('local API boundary', () => {
  it('allows same-origin read requests and rejects foreign origins and broadcast requests', async () => {
    const mock = upstream((_, method) => method === 'eth_chainId' ? '0x38' : '0x64');
    const app = createApp(store, new RpcGateway(store, { fetch: mock }));
    const headers = { host: '127.0.0.1:5173', 'x-oft-client': 'local-dashboard', 'content-type': 'application/json' };
    const healthy = await app.request('http://127.0.0.1:5173/api/chains/56/health', { headers });
    expect(healthy.status).toBe(200);
    const invalidHeaders: Record<string, string>[] = [{ origin: 'https://evil.example' }, { host: 'evil.example' }, { 'sec-fetch-site': 'cross-site' }];
    for (const extra of invalidHeaders) {
      expect((await app.request('http://127.0.0.1:5173/api/settings/rpc', { headers: { ...headers, ...extra } })).status).toBe(403);
    }
    const broadcast = await app.request('http://127.0.0.1:5173/api/rpc/56', { method: 'POST', headers, body: JSON.stringify({ ...request, method: 'eth_sendRawTransaction' }) });
    expect(broadcast.status).toBe(403);
    expect((await broadcast.json()).code).toBe('METHOD_NOT_ALLOWED');
    expect((await app.request('http://127.0.0.1:5173/api/chains/1000000/health', { headers })).status).toBe(400);
    expect((await app.request('http://127.0.0.1:5173/api/settings/rpc', { headers: { host: headers.host } })).status).toBe(403);
  });
  it('falls back on a malformed block result instead of treating the endpoint as healthy', async () => {
    const mock = upstream((url, method) => method === 'eth_chainId' ? '0x38' : url.includes('broken') ? 'not-a-block' : '0x2a');
    const gateway = new RpcGateway(store, { fetch: mock, endpoints: { 56: ['https://broken.test', 'https://healthy.test'] } });
    expect(await gateway.health(56)).toMatchObject({ blockNumber: '42', fallbackUsed: true });
  });
});

describe('discovery RPC revision guard', () => {
  it('rejects an old revision before reading and invalidates a response if RPC settings changed in flight', async () => {
    const mock = upstream(async (_, method) => {
      if (method === 'eth_chainId') return '0x38';
      await store.set(56, null);
      return '0x64';
    });
    const app = createApp(store, new RpcGateway(store, { fetch: mock }));
    const headers = { host: '127.0.0.1:5173', 'x-oft-client': 'local-dashboard', 'content-type': 'application/json', 'x-oft-rpc-revision': '99' };
    const stale = await app.request('http://127.0.0.1:5173/api/rpc/56', { method: 'POST', headers, body: JSON.stringify(request) });
    expect(stale.status).toBe(409); expect(mock).not.toHaveBeenCalled();
    const inFlight = await app.request('http://127.0.0.1:5173/api/rpc/56', { method: 'POST', headers: { ...headers, 'x-oft-rpc-revision': '0' }, body: JSON.stringify(request) });
    expect(inFlight.status).toBe(409);
    expect((await inFlight.json()).code).toBe('STALE_CONTEXT');
  });
});

describe('fixed-block RPC availability', () => {
  it('falls back when a load-balanced public node cannot read its own recent block', async () => {
    const mock = upstream((url, method) => method === 'eth_chainId' ? '0x38' : url.includes('lagging') ? { error: { code: -32000, message: 'block not found: 0x100' } } : '0x6001');
    const gateway = new RpcGateway(store, { fetch: mock, endpoints: { 56: ['https://lagging.test', 'https://current.test'] } });
    const result = await gateway.request(56, { ...request, method: 'eth_getCode', params: ['0x0000000000000000000000000000000000000001', '0x100'] });
    expect(result).toMatchObject({ fallbackUsed: true, host: 'current.test', response: { result: '0x6001' } });
  });
  it('reports RPC error if every node lacks the block rather than returning a contract error', async () => {
    const mock = upstream((_, method) => method === 'eth_chainId' ? '0x38' : { error: { code: -32000, message: 'header not found' } });
    const gateway = new RpcGateway(store, { fetch: mock, endpoints: { 56: ['https://lagging.test', 'https://offline.test'] } });
    await expect(gateway.request(56, { ...request, method: 'eth_getCode', params: ['0x0000000000000000000000000000000000000001', '0x100'] })).rejects.toMatchObject({ code: 'RPC_ERROR' });
  });
});
