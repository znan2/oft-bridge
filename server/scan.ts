import type { ScanMessage, ScanResult } from '../shared/execution';
import { AppError } from './errors';
const HASH = /^0x[0-9a-f]{64}$/i, ADDRESS = /^0x[0-9a-f]{40}$/i;
const obj = (x: unknown): Record<string, any> => x && typeof x === 'object' && !Array.isArray(x) ? x : {};
export function parseScan(value: unknown): ScanMessage[] {
  const data = obj(value).data;
  if (!Array.isArray(data) || data.length > 100) throw new Error('Invalid Scan response');
  return data.map(raw => {
    const m = obj(raw), p = obj(m.pathway), src = obj(obj(m.source).tx), dst = obj(obj(m.destination).tx);
    if (!HASH.test(m.guid) || !HASH.test(src.txHash) || !ADDRESS.test(obj(p.sender).address) || !ADDRESS.test(obj(p.receiver).address) || !Number.isSafeInteger(p.srcEid) || !Number.isSafeInteger(p.dstEid) || typeof obj(m.status).name !== 'string') throw new Error('Invalid Scan message');
    return { guid: m.guid, srcEid: p.srcEid, dstEid: p.dstEid, sender: p.sender.address, receiver: p.receiver.address, sourceHash: src.txHash, status: m.status.name.slice(0, 80), ...(HASH.test(dst.txHash) ? { destinationHash: dst.txHash } : {}) };
  });
}
export class ScanService {
  private cache = new Map<string, { at: number; promise: Promise<ScanResult> }>();
  constructor(private fetcher: typeof fetch = fetch) {}
  get(hash: string): Promise<ScanResult> {
    if (!HASH.test(hash)) throw new AppError('INVALID_REQUEST', '올바른 전송 해시를 입력하세요.');
    const key = hash.toLowerCase(), cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < 15_000) return cached.promise;
    const promise = this.read(key);
    this.cache.set(key, { at: Date.now(), promise });
    if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!);
    return promise;
  }
  private async read(hash: string): Promise<ScanResult> {
    try {
      const response = await this.fetcher(`https://scan.layerzero-api.com/v1/messages/tx/${hash}`, { redirect: 'error', signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
      if (!response.ok || !response.body) throw new Error();
      const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      try {
        for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 2_000_000) throw new Error(); chunks.push(value); }
      } catch (error) { await reader.cancel(); throw error; }
      return { messages: parseScan(JSON.parse(Buffer.concat(chunks).toString('utf8'))), checkedAt: new Date().toISOString() };
    } catch { throw new AppError('SCAN_ERROR', 'LayerZero Scan 조회 오류 — 거래 실패를 의미하지 않습니다. 잠시 후 다시 조회하세요.', 503); }
  }
}
