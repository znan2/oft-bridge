import { getAddress, isAddress } from 'viem';
import { CHAINS } from '../shared/chains';
import { NETWORK_MODE } from '../shared/network';
import type { ProtocolCatalog, ProtocolChain } from '../shared/route';
export const PROTOCOL_METADATA_URL = 'https://metadata.layerzero-api.com/v1/metadata';
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
function address(x: unknown) { if (typeof x !== 'string' || !isAddress(x, { strict: false })) throw new Error('Invalid deployment address'); return getAddress(x.toLowerCase()); }
export function normalizeProtocolMetadata(data: unknown): ProtocolChain[] {
  if (!object(data)) throw new Error('Invalid protocol metadata');
  const present = CHAINS.filter(chain => chain.key in data);
  if (!present.length) throw new Error('Missing chain metadata');
  return present.map(chain => {
    const entry = data[chain.key];
    if (!object(entry) || !Array.isArray(entry.deployments) || !object(entry.dvns) || !object(entry.chainDetails) || entry.chainDetails.nativeChainId !== chain.id) throw new Error('Missing chain metadata');
    if ((entry.chainDetails.chainStatus != null && entry.chainDetails.chainStatus !== 'ACTIVE') || (entry.chainDetails.chainType != null && entry.chainDetails.chainType !== 'evm')) throw new Error('Chain no longer active EVM');
    const matches = entry.deployments.filter(x => object(x) && x.version === 2 && x.stage === NETWORK_MODE && String(x.eid) === String(chain.eid));
    if (matches.length !== 1) throw new Error('Ambiguous endpoint metadata');
    const deployment = matches[0];
    const get = (key: string) => { const value = deployment[key]; if (!object(value)) throw new Error('Missing deployment'); return address(value.address); };
    const dvns = Object.entries(entry.dvns).map(([a, value]) => {
      if (!object(value) || typeof value.id !== 'string' || !value.id || typeof value.canonicalName !== 'string' || !Number.isInteger(value.version)) throw new Error('Invalid DVN metadata');
      return { address: address(a), id: value.id.slice(0, 100), name: value.canonicalName.slice(0, 100), version: Number(value.version), deprecated: value.deprecated === true, lzReadCompatible: value.lzReadCompatible === true };
    });
    return { chainId: chain.id, eid: chain.eid, endpoint: get('endpointV2'), sendLibrary: get('sendUln302'), receiveLibrary: get('receiveUln302'), blockedLibrary: get('blockedMessageLib'), deadDvn: get('deadDVN'), executors: ['executor', 'lzExecutor'].filter(k => deployment[k] != null).map(get), dvns };
  });
}
export class ProtocolMetadataService {
  private cached?: ProtocolCatalog;
  private inflight?: Promise<ProtocolCatalog>;
  private attemptedAt = 0;
  constructor(private fetcher: typeof fetch = fetch, private now: () => number = Date.now) {}
  async get(): Promise<ProtocolCatalog> {
    if (this.cached && ((this.cached.status === 'fresh' && this.now() - Date.parse(this.cached.fetchedAt!) < 300000) || this.now() - this.attemptedAt < 30000)) return this.cached;
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }
  private async refresh(): Promise<ProtocolCatalog> {
    this.attemptedAt = this.now();
    try {
      const response = await this.fetcher(PROTOCOL_METADATA_URL, { redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Metadata unavailable'); }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 10_000_000) throw new Error('Metadata too large'); chunks.push(next.value); } }
      catch (error) { await reader.cancel(); throw error; }
      const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!object(data)) throw new Error('Invalid metadata');
      const chains: ProtocolChain[] = [], invalid: string[] = [];
      for (const chain of CHAINS) {
        // A broken/missing chain must not invalidate unrelated routes. Missing rows cannot pass route matching.
        if (!(chain.key in data)) continue;
        try { chains.push(...normalizeProtocolMetadata({ [chain.key]: data[chain.key] })); }
        catch { invalid.push(chain.shortName); }
      }
      if (!chains.length) throw new Error('No usable metadata');
      this.cached = { status: 'fresh', fetchedAt: new Date(this.now()).toISOString(), sourceUrl: PROTOCOL_METADATA_URL, chains, warnings: invalid.length ? [`일부 체인의 배포 메타데이터 형식 오류 — ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? ` 외 ${invalid.length - 5}개` : ''}. 해당 체인은 최신 대조에서 제외했습니다.`] : [] };
    } catch { this.cached = { status: this.cached?.chains.length ? 'stale' : 'unavailable', fetchedAt: this.cached?.fetchedAt ?? null, sourceUrl: PROTOCOL_METADATA_URL, chains: this.cached?.chains ?? [], warnings: ['프로토콜 메타데이터 조회 오류 — DVN 운영자와 배포 정보를 최신 자료로 확인하지 못했습니다.'] }; }
    return this.cached;
  }
}
