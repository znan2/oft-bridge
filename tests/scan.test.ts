import { describe, expect, it, vi } from 'vitest';
import { ScanService, parseScan } from '../server/scan';
const hash = `0x${'a'.repeat(64)}`;
const message = { guid: hash, pathway: { srcEid: 30102, dstEid: 30101, sender: { address: `0x${'1'.repeat(40)}` }, receiver: { address: `0x${'2'.repeat(40)}` } }, source: { tx: { txHash: hash } }, destination: { tx: { txHash: `0x${'b'.repeat(64)}` } }, status: { name: 'DELIVERED' } };
describe('LayerZero Scan fixed read-only proxy', () => {
  it('returns bounded fields and retains all messages for strict client matching', () => { expect(parseScan({ data: [message, { ...message, guid: `0x${'c'.repeat(64)}` }] })).toHaveLength(2); });
  it('allows indexing delays but rejects malformed shape', () => { expect(parseScan({ data: [] })).toEqual([]); expect(() => parseScan({ data: [null] })).toThrow(); expect(() => parseScan({})).toThrow(); });
  it('uses a fixed URL, coalesces requests and keeps network errors distinct', async () => {
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ data: [message] })); const service = new ScanService(fetcher);
    const [a,b] = await Promise.all([service.get(hash), service.get(hash)]); expect(a).toEqual(b); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(`https://scan.layerzero-api.com/v1/messages/tx/${hash}`);
    expect(() => service.get('https://arbitrary.example')).toThrow();
    await expect(new ScanService(async () => { throw new Error('offline'); }).get(hash)).rejects.toMatchObject({ code: 'SCAN_ERROR' });
  });
  it('enforces upstream response size limits', async () => { await expect(new ScanService(async () => new Response('x'.repeat(2_000_001))).get(hash)).rejects.toMatchObject({ code: 'SCAN_ERROR' }); });
});
