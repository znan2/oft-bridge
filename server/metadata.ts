import { getAddress, isAddress } from 'viem';
import { CHAINS } from '../shared/chains';
import type { Catalog, DeploymentRecord } from '../shared/discovery';

export const OFT_METADATA_URL = 'https://metadata.layerzero-api.com/v1/metadata/experiment/ofts/list';
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function address(value: unknown) { return typeof value === 'string' && isAddress(value, { strict: false }) ? getAddress(value.toLowerCase()) : null; }
function text(value: unknown, fallback = '') { return typeof value === 'string' ? value.slice(0, 100) : fallback; }
export function normalizeMetadata(data: unknown): { deployments: DeploymentRecord[]; warnings: string[] } {
  if (!record(data) || !Object.keys(data).length) throw new Error('Invalid metadata');
  const deployments: DeploymentRecord[] = [];
  let invalid = 0;
  for (const [symbol, entries] of Object.entries(data)) {
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      if (!record(entry) || !record(entry.deployments)) { invalid++; continue; }
      for (const chain of CHAINS) {
        const dep = entry.deployments[chain.key];
        if (dep == null) continue;
        if (!record(dep) || !address(dep.address) || (dep.innerTokenAddress != null && !address(dep.innerTokenAddress))) { invalid++; continue; }
        deployments.push({ chainId: chain.id, address: address(dep.address)!, tokenAddress: address(dep.innerTokenAddress), symbol: symbol.slice(0, 60), name: text(entry.name, symbol), declaredType: text(dep.type, 'UNKNOWN'), endpointVersion: typeof entry.endpointVersion === 'string' ? entry.endpointVersion : null });
      }
    }
  }
  if (!deployments.length) throw new Error('No recognizable deployments');
  return { deployments, warnings: invalid ? [`메타데이터 ${invalid}개 항목을 해석하지 못했습니다. 검색 결과가 불완전할 수 있습니다.`] : [] };
}
export class MetadataService {
  private cached?: Catalog;
  private inflight?: Promise<Catalog>;
  private attemptedAt = 0;
  constructor(private fetcher: typeof fetch = fetch, private now: () => number = Date.now) {}
  async get(force = false): Promise<Catalog> {
    if (!force && this.cached && this.cached.fetchedAt && this.now() - Date.parse(this.cached.fetchedAt) < 300000 && this.cached.status === 'fresh') return this.cached;
    if (!force && this.cached && this.now() - this.attemptedAt < 30000) return this.cached;
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }
  private async refresh(): Promise<Catalog> {
    this.attemptedAt = this.now();
    try {
      const response = await this.fetcher(OFT_METADATA_URL, { redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!response.ok || !response.body) throw new Error('Metadata request failed');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.length; if (size > 5_000_000) throw new Error('Metadata too large');
          chunks.push(next.value);
        }
      } catch (error) { await reader.cancel(); throw error; }
      const parsed = normalizeMetadata(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      this.cached = { ...parsed, status: 'fresh', sourceUrl: OFT_METADATA_URL, fetchedAt: new Date(this.now()).toISOString() };
    } catch {
      this.cached = { status: this.cached?.deployments.length ? 'stale' : 'unavailable', sourceUrl: OFT_METADATA_URL, fetchedAt: this.cached?.fetchedAt ?? null, deployments: this.cached?.deployments ?? [], warnings: ['메타데이터 조회 오류입니다. 브릿지 주소를 직접 입력하거나 성공 거래 해시로 보완할 수 있습니다.'] };
    }
    return this.cached;
  }
}
