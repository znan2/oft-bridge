import { describe, it, expect, vi } from 'vitest';
import { MetadataService, normalizeMetadata } from '../server/metadata';
import { TOKEN, BRIDGE, OTHER } from './helpers/discovery';
const rows = { TEST: [
  { name: 'Test', endpointVersion: 'v2', deployments: { ethereum: { address: BRIDGE, innerTokenAddress: TOKEN, type: 'OFT_ADAPTER' }, bsc: { address: TOKEN, type: 'OFT' }, solana: { address: 'non-EVM-address' } } },
  { name: 'Test Alternative', endpointVersion: 'v1', deployments: { ethereum: { address: OTHER, innerTokenAddress: TOKEN, type: 'OFT_ADAPTER' } } },
] };
describe('official catalog boundary', () => {
  it('keeps alternate adapters and version hints, filters unsupported chains, and flags broken records', () => {
    const result = normalizeMetadata({ ...rows, BROKEN: [{ deployments: { bsc: { address: 'invalid' } } }] });
    expect(result.deployments).toHaveLength(3);
    expect(result.deployments.filter(d => d.chainId === 1)).toHaveLength(2);
    expect(result.deployments.find(d => d.address === OTHER)?.endpointVersion).toBe('v1');
    expect(result.warnings).toHaveLength(1);
    expect(() => normalizeMetadata({ error: 'upstream changed schema' })).toThrow();
  });
  it('deduplicates concurrent fetches and caches fresh results', async () => {
    const fetcher = vi.fn(async () => Response.json(rows));
    const service = new MetadataService(fetcher);
    const results = await Promise.all([service.get(), service.get()]);
    expect(results[0].status).toBe('fresh');
    await service.get();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('retains timestamped stale hints after outage and retries after backoff', async () => {
    let now = Date.parse('2026-09-06T00:00:00Z');
    const fetcher = vi.fn(async () => Response.json(rows));
    const service = new MetadataService(fetcher, () => now);
    const first = await service.get();
    now += 300001;
    fetcher.mockRejectedValueOnce(new Error('offline'));
    const stale = await service.get();
    expect(stale).toMatchObject({ status: 'stale', fetchedAt: first.fetchedAt });
    expect(stale.deployments).toHaveLength(3);
    await service.get();
    expect(fetcher).toHaveBeenCalledTimes(2);
    now += 30001;
    expect((await service.get()).status).toBe('fresh');
  });
  it('reports unavailable on initial failure or invalid schema instead of an empty fresh catalog', async () => {
    for (const response of [new Response('rate limit', { status: 429 }), Response.json({})]) {
      const result = await new MetadataService(vi.fn(async () => response)).get();
      expect(result.status).toBe('unavailable');
      expect(result.fetchedAt).toBeNull();
    }
  });
});
