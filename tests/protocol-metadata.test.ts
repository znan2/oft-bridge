import { describe, it, expect, vi } from 'vitest';
import { ProtocolMetadataService, normalizeProtocolMetadata } from '../server/protocol-metadata';
import { routeHarness } from './helpers/route';
import { chainById } from '../shared/chains';
function raw() {
  return Object.fromEntries(routeHarness().catalog.chains.map(c => [chainById(c.chainId).key, { chainDetails: { nativeChainId: c.chainId }, deployments: [{ version: 2, eid: String(c.eid), stage: 'mainnet', endpointV2: { address: c.endpoint }, sendUln302: { address: c.sendLibrary }, receiveUln302: { address: c.receiveLibrary }, blockedMessageLib: { address: c.blockedLibrary }, deadDVN: { address: c.deadDvn }, executor: { address: c.executors[0] } }], dvns: Object.fromEntries(c.dvns.map(d => [d.address, { canonicalName: d.name, id: d.id, version: d.version, deprecated: d.deprecated, lzReadCompatible: d.lzReadCompatible }])) }]));
}
describe('protocol deployment and DVN metadata', () => {
  it('keeps operator ids, version and deprecation flags with verified chain/EID pairs', () => {
    const data = raw(); Object.values(data.bsc.dvns)[0].deprecated = true;
    const normalized = normalizeProtocolMetadata(data);
    expect(normalized.find(c => c.chainId === 56)?.dvns[0]).toMatchObject({ id: 'operator-0', deprecated: true, version: 2 });
    data.bsc.chainDetails.nativeChainId = 1;
    expect(() => normalizeProtocolMetadata(data)).toThrow();
  });
  it('rejects missing or ambiguous deployments instead of using the first apparent match', () => {
    const data = raw(); data.bsc.deployments.push(data.bsc.deployments[0]);
    expect(() => normalizeProtocolMetadata(data)).toThrow();
    expect(() => normalizeProtocolMetadata({ bsc: {} })).toThrow();
  });
  it('deduplicates concurrent requests, caches, and preserves stale evidence without calling it fresh', async () => {
    let now = Date.parse('2026-09-06T00:00:00Z');
    const fetcher = vi.fn(async () => Response.json(raw()));
    const service = new ProtocolMetadataService(fetcher, () => now);
    await Promise.all([service.get(), service.get()]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 300001; fetcher.mockRejectedValueOnce(new Error('offline'));
    const stale = await service.get(); expect(stale.status).toBe('stale'); expect(stale.chains).toHaveLength(2);
    await service.get(); expect(fetcher).toHaveBeenCalledTimes(2);
    now += 30001; expect((await service.get()).status).toBe('fresh');
  });
  it('returns an explicit metadata failure on initial outage or schema mismatch', async () => {
    const service = new ProtocolMetadataService(vi.fn(async () => Response.json({ error: 'maintenance' })));
    expect(await service.get()).toMatchObject({ status: 'unavailable', chains: [], warnings: [expect.stringContaining('메타데이터 조회 오류')] });
  });
});
