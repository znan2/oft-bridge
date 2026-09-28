import { describe, expect, it } from 'vitest';
import { parseExecutionMode, parseNetworkMode } from '../shared/network';
import { redactSecrets } from '../shared/redact';
import { rpcOverrides } from '../server/settings';
import { createApp } from '../server/app';
import { SettingsStore } from '../server/settings';
import { RpcGateway } from '../server/rpc';
import testnet from '../shared/chain-registry.testnet.json';
import { currentRuntime, toRuntime } from '../src/lib/runtime';

describe('safe defaults', () => {
  it('defaults to testnet and dry-run; mainnet and live must be chosen explicitly', () => {
    expect(parseNetworkMode(undefined)).toBe('testnet'); expect(parseNetworkMode('')).toBe('testnet');
    expect(parseNetworkMode('mainnet')).toBe('mainnet');
    expect(parseExecutionMode(undefined)).toBe('dry-run'); expect(parseExecutionMode('live')).toBe('live');
  });
  it.each(['Mainnet', 'main', '1', 'true', 'yes'])('fails closed on ambiguous values (%s)', value => {
    expect(() => parseNetworkMode(value)).toThrow(); expect(() => parseExecutionMode(value)).toThrow();
  });
  it('testnet registry holds only testnet endpoint IDs with pinned protocol profiles', () => {
    expect(testnet.chains.map(c => c.id)).toEqual([11155111, 84532, 421614]);
    for (const chain of testnet.chains) {
      expect(chain.eid).toBeGreaterThanOrEqual(40000); expect(chain.eid).toBeLessThan(50000);
      expect(Object.values(chain.protocol).flat().every(a => /^0x[0-9a-f]{40}$/.test(a))).toBe(true);
    }
  });
  it('health reports dry-run by default and never claims server-side signing', async () => {
    const store = new SettingsStore('/tmp/oft-safe-defaults-unused.json');
    const app = createApp(store, new RpcGateway(store, { fetch: async () => { throw new Error('no network'); } }));
    const body = await (await app.request('http://127.0.0.1:4318/api/health', { headers: { host: '127.0.0.1:4318' } })).json();
    expect(body).toMatchObject({ ok: true, signing: false, executionMode: 'dry-run', walletExecution: false });
  });
});

describe('UI runtime gate', () => {
  // vitest.config.ts builds this suite for mainnet.
  const health = { ok: true, signing: false, network: 'mainnet', executionMode: 'live', walletExecution: true } as const;
  it('allows live only when the server explicitly reports live for the same network', () => {
    expect(toRuntime(health).executionMode).toBe('live');
    expect(toRuntime({ ...health, walletExecution: false }).executionMode).toBe('dry-run');
    expect(toRuntime({ ...health, executionMode: 'dry-run' }).executionMode).toBe('dry-run');
    expect(toRuntime({ ...health, network: 'testnet' })).toMatchObject({ executionMode: 'dry-run', mismatch: true });
  });
  it('treats an unreachable server as dry-run', async () => {
    expect((await currentRuntime()).executionMode).toBe('dry-run');
  });
});

describe('secret handling', () => {
  it('removes RPC URLs, key assignments and long tokens from messages', () => {
    const text = 'failed https://eth-mainnet.g.alchemy.com/v2/abcDEF1234567890abcDEF1234567890 apiKey=sk_live_123 access_token: "x-y-z" id 0123456789abcdef0123456789abcdef01';
    const out = redactSecrets(text);
    expect(out).toContain('[URL eth-mainnet.g.alchemy.com]');
    expect(out).not.toMatch(/abcDEF|sk_live_123|x-y-z|0123456789abcdef0123456789abcdef01/);
  });
  it('keeps hex data such as revert reasons, addresses and hashes readable', () => {
    const hash = `0x${'ab'.repeat(32)}`;
    expect(redactSecrets(`execution reverted ${hash}`)).toBe(`execution reverted ${hash}`);
    expect(redactSecrets('invalid token: 0xDE00000000000000000000000000000000000001')).toBe('invalid token: 0xDE00000000000000000000000000000000000001');
  });
  it('also removes JSON-escaped URLs with short keys', () => {
    expect(redactSecrets('{"url":"https:\\/\\/eth.example\\/v2\\/shortKey1"}')).not.toContain('shortKey1');
  });
  it('reads RPC overrides only from OFT_RPC_URL_<chainId> and rejects non-HTTPS values without echoing them', () => {
    expect(rpcOverrides({ OFT_RPC_URL_1: 'https://rpc.example/v2/secret' })).toEqual({ 1: ['https://rpc.example/v2/secret'] });
    expect(() => rpcOverrides({ OFT_RPC_URL_1: 'http://rpc.example/v2/secret' })).toThrow(/OFT_RPC_URL_1/);
    try { rpcOverrides({ OFT_RPC_URL_1: 'http://rpc.example/v2/secret' }); } catch (e) { expect((e as Error).message).not.toContain('secret'); }
  });
  it('labels an environment RPC as env and exposes only its host', async () => {
    const store = new SettingsStore('/tmp/oft-safe-defaults-unused.json');
    const fetcher = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'eth_chainId' ? '0x1' : '0x10' }));
    }) as unknown as typeof fetch;
    const health = await new RpcGateway(store, { fetch: fetcher, envEndpoints: { 1: ['https://eth.example/v2/secret-key'] } }).health(1);
    expect(health).toMatchObject({ mode: 'env', host: 'eth.example' }); expect(JSON.stringify(health)).not.toContain('secret-key');
  });
});
