import { decodeFunctionResult, encodeFunctionData, getAddress, isAddress, isHex, zeroAddress, type Address, type Hex } from 'viem';
import type { CandidateCheck, CandidateEvidence, CandidateStore, Catalog, DiscoveryInput, DiscoveryResult, TokenIdentity } from '../../shared/discovery';
import { OFT_READ_ABI, type GetterName } from '../../shared/oft-abi';

import { transactionCandidates, transactionHash, TransactionError } from './transaction-candidates';

export interface DiscoveryIO {
  rpc(method: string, params: unknown[]): Promise<unknown>;
  catalog(): Promise<Catalog>;
  store: CandidateStore;
}
export class RpcCallError extends Error {
  constructor(public code: number, message: string, public data?: string) { super(message); }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const address = (value: unknown): value is Address => typeof value === 'string' && isAddress(value, { strict: false });
const quantity = (value: unknown): value is Hex => typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value);
const shortText = (value: unknown) => typeof value === 'string' && value.trim() ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120) : null;
const validDecimals = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255;
function transportMessage(error: unknown) {
  const message = error instanceof Error ? error.message : '응답을 확인할 수 없습니다.';
  return /로컬 조회 서버|RPC/.test(message) ? message : `RPC 오류 — ${message}`;
}

// Discovery is read-only. A matching interface is evidence of compatibility, not project authenticity or route readiness.
export async function discover(input: DiscoveryInput, io: DiscoveryIO, signal?: AbortSignal): Promise<DiscoveryResult> {
  const result: DiscoveryResult = {
    status: 'not-found', inputAddress: input.tokenAddress.trim(), chainId: input.chainId,
    blockNumber: null, checkedAt: new Date().toISOString(), token: null, candidates: [],
    message: 'Pool 컨트랙트를 찾지 못했습니다.', warnings: [], catalog: null,
  };
  const checkAbort = () => signal?.throwIfAborted();
  const rpc = async (method: string, params: unknown[]) => { checkAbort(); const value = await io.rpc(method, params); checkAbort(); return value; };
  const finish = (status: DiscoveryResult['status'], message: string) => ({ ...result, status, message });
  if (!isAddress(result.inputAddress)) return finish('input-error', '유효한 토큰 CA를 입력하세요. 혼합 대소문자 주소는 체크섬도 확인합니다.');
  if (input.manualAddress && !isAddress(input.manualAddress.trim())) return finish('input-error', '유효한 브릿지 컨트랙트 주소를 입력하세요.');
  let txHash: string | undefined;
  if (input.transactionHash) {
    try { txHash = transactionHash(input.transactionHash, input.chainId); }
    catch (error) { return finish('input-error', (error as Error).message); }
  }
  if (input.manualAddress && input.transactionHash) return finish('input-error', '수동 주소 또는 거래 해시 중 하나를 입력하세요.');
  const ca = getAddress(result.inputAddress);
  result.inputAddress = ca;
  const readCache = new Map<string, Promise<unknown>>();
  const codeCache = new Map<string, Promise<boolean>>();
  async function hasCode(target: string) {
    const key = target.toLowerCase();
    if (!codeCache.has(key)) codeCache.set(key, (async () => {
      const code = await rpc('eth_getCode', [target, result.blockNumber]);
      if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(code)) throw new Error('컨트랙트 코드 응답이 잘못되었습니다.');
      return code !== '0x';
    })());
    return codeCache.get(key)!;
  }
  function read(target: string, name: GetterName): Promise<unknown> {
    const key = `${target.toLowerCase()}:${name}`;
    if (!readCache.has(key)) readCache.set(key, (async () => {
      let raw: unknown;
      try { raw = await rpc('eth_call', [{ to: target, data: encodeFunctionData({ abi: OFT_READ_ABI, functionName: name }) }, result.blockNumber]); }
      catch (error) {
        // Transport/provider failures must never become "getter not present".
        if (error instanceof RpcCallError && (error.code === 3 || /execution reverted|\brevert(?:ed)?\b/i.test(error.message))) return undefined;
        throw error;
      }
      if (typeof raw !== 'string' || !isHex(raw) || raw.length % 2 !== 0) throw new Error('컨트랙트 호출 응답이 잘못되었습니다.');
      if (raw === '0x') return undefined;
      try { return decodeFunctionResult({ abi: OFT_READ_ABI, functionName: name, data: raw }); }
      catch { return undefined; }
    })());
    return readCache.get(key)!;
  }
  async function tokenInfo(target: string): Promise<TokenIdentity> {
    // Symbols/names are optional; decimals are required for later amount conversion.
    const decimals = await read(target, 'decimals');
    return { address: getAddress(target), decimals: validDecimals(decimals) ? decimals : null,
      symbol: shortText(await read(target, 'symbol')), name: shortText(await read(target, 'name')) };
  }
  async function probe(target: string, sources: CandidateEvidence[], expectedToken?: string): Promise<CandidateCheck> {
    const candidate: CandidateCheck = { address: getAddress(target), sources, status: 'not-oft', reason: '표준 OFT V2 인터페이스를 확인하지 못했습니다.' };
    try {
      if (!await hasCode(target)) return { ...candidate, status: 'no-code', reason: '해당 주소에 컨트랙트 코드가 없습니다.' };
      const token = await read(target, 'token');
      const endpoint = await read(target, 'endpoint');
      const version = await read(target, 'oftVersion');
      if (token === undefined && endpoint === undefined && version === undefined) return candidate;
      const unsupported = (reason: string): CandidateCheck => ({ ...candidate, status: 'unsupported', reason });
      if (!address(token) || !address(endpoint) || endpoint === zeroAddress || !Array.isArray(version)) return unsupported('OFT 필수 인터페이스가 불완전하거나 지원하지 않는 형식입니다.');
      if (token === zeroAddress) return unsupported('네이티브 토큰 어댑터는 현재 지원 범위에 포함되지 않습니다.');
      if (version[0] !== '0x02e49c2c' || version[1] !== 1n) return unsupported(`지원 대상인 OFT V2 인터페이스 / 메시지 버전 1과 일치하지 않습니다. 조회값: ${version[0]} / ${version[1]}`);
      const stargateType = await read(target, 'stargateType');
      if (stargateType === 0 || stargateType === 1) return unsupported('Stargate 자체 Pool / OFT 구현은 이번 버전의 지원 범위에 포함되지 않습니다.');
      if (expectedToken && !same(token, expectedToken)) return { ...candidate, status: 'mismatch', reason: `token()이 입력 CA와 다릅니다: ${token}` };
      if (!await hasCode(token)) return unsupported('token()이 가리키는 주소에 컨트랙트 코드가 없습니다.');
      const sharedDecimals = await read(target, 'sharedDecimals');
      const approvalRequired = await read(target, 'approvalRequired');
      const identity = await tokenInfo(token);
      if (!validDecimals(sharedDecimals) || typeof approvalRequired !== 'boolean' || identity.decimals === null || identity.decimals < sharedDecimals) return unsupported('토큰 정밀도 또는 승인 방식이 지원하는 OFT 형식과 일치하지 않습니다.');
      return { ...candidate, status: 'identified', reason: 'OFT 인터페이스와 token() 관계를 확인했습니다.', identity: {
        bridgeAddress: getAddress(target), token: identity, kind: same(token, target) ? 'OFT' : 'OFTAdapter',
        endpoint: getAddress(endpoint), interfaceId: version[0], messageVersion: String(version[1]), sharedDecimals, approvalRequired,
      } };
    } catch (error) { checkAbort(); return { ...candidate, status: 'rpc-error', reason: transportMessage(error) }; }
  }
  try {
    const block = await rpc('eth_blockNumber', []);
    if (!quantity(block)) throw new Error('조회 블록 응답이 잘못되었습니다.');
    result.blockNumber = block;
    if (!await hasCode(ca)) return finish('no-code', '출발 네트워크의 해당 CA에 컨트랙트 코드가 없습니다. 주소와 네트워크를 확인하세요.');
    const direct = await probe(ca, [{ source: 'direct', detail: '입력 CA의 온체인 인터페이스' }]);
    if (direct.status === 'rpc-error') { result.candidates.push(direct); return finish('rpc-error', direct.reason); }
    result.token = direct.identity?.token ?? await tokenInfo(ca);
    const expectedToken = direct.identity?.token.address ?? ca;
    const candidates = new Map<string, { address: string; sources: CandidateEvidence[] }>();
    const add = (target: string, evidence: CandidateEvidence) => {
      const key = target.toLowerCase();
      const existing = candidates.get(key);
      if (existing) existing.sources.push(evidence);
      else candidates.set(key, { address: getAddress(target), sources: [evidence] });
    };
    // Explicit recovery checks only the requested candidate, without depending on the catalog.
    if (input.manualAddress || input.transactionHash) {
      result.catalog = { status: 'skipped', fetchedAt: null, sourceUrl: '' };
      if (input.manualAddress) add(input.manualAddress.trim(), { source: 'manual', detail: '직접 입력한 주소' });
      else {
        result.transactions = await transactionCandidates(txHash!, input.chainId, expectedToken, rpc);
        if (result.transactions.length === 1) result.transaction = result.transactions[0];
        for (const evidence of result.transactions) add(evidence.bridgeAddress, { source: 'transaction', detail: evidence.kind === 'send' ? '성공한 직접 send + OFTSent 이벤트' : '성공한 수신 · OFTReceived + 공식 Endpoint 전달/GUID + 입력 토큰 Transfer 대조', transactionHash: evidence.hash });
        result.warnings.push('과거 OFT 전송·수신 성공은 현재 선택한 방향의 전송 가능 여부를 보장하지 않습니다. 현재 경로를 별도로 검증합니다.');
      }
    } else {
      if (direct.status !== 'not-oft') result.candidates.push(direct);
      let catalog: Catalog;
      try { catalog = await io.catalog(); checkAbort(); }
      catch { checkAbort(); catalog = { status: 'unavailable', fetchedAt: null, sourceUrl: '', deployments: [], warnings: ['OFT 목록 API 오류 — 자동 후보 목록을 가져오지 못했습니다.'] }; }
      result.catalog = { status: catalog.status, fetchedAt: catalog.fetchedAt, sourceUrl: catalog.sourceUrl };
      result.warnings.push(...catalog.warnings);
      for (const row of catalog.deployments) {
        if (row.chainId === input.chainId && (same(row.address, ca) || (row.tokenAddress && same(row.tokenAddress, expectedToken)))) add(row.address, { source: 'metadata', detail: `공식 OFT 목록 · ${row.name} · ${row.declaredType} · ${row.endpointVersion ?? '버전 미상'}` });
      }
      try {
        for (const saved of await io.store.list(input.chainId, expectedToken)) add(saved.bridgeAddress, { source: 'saved', detail: saved.source === 'peer' ? '이전에 양쪽 peer로 확인한 후보 · 이번 조회에서 재검증' : '이 브라우저에 저장한 후보 · 이번 조회에서 재검증', transactionHash: saved.transactionHash });
      } catch { result.warnings.push('브라우저의 저장된 후보를 읽지 못했습니다. 현재 조회는 계속합니다.'); }
    }
    if (candidates.size > 20) result.warnings.push('후보가 많아 최대 20개만 조회했습니다. 필요한 주소를 직접 입력할 수 있습니다.');
    for (const entry of [...candidates.values()].slice(0, 20)) {
      checkAbort();
      const existing = result.candidates.find(c => same(c.address, entry.address));
      if (existing) { existing.sources.push(...entry.sources); continue; }
      const checked = same(entry.address, ca) ? { ...direct, sources: entry.sources } : await probe(entry.address, entry.sources, expectedToken);
      result.candidates.push(checked);
      if (checked.status === 'identified' && (input.manualAddress || input.transactionHash)) {
        try {
          await io.store.save({ id: `${input.chainId}:${expectedToken.toLowerCase()}:${checked.address.toLowerCase()}`,
            chainId: input.chainId, tokenAddress: expectedToken, bridgeAddress: checked.address,
            source: input.transactionHash ? 'transaction' : 'manual', transactionHash: txHash, savedAt: new Date().toISOString() });
        } catch { result.warnings.push('확인한 후보를 브라우저에 저장하지 못했습니다. 현재 조회 결과는 유효합니다.'); }
      }
    }
    checkAbort();
    const identified = result.candidates.filter(c => c.status === 'identified');
    if (identified.length) {
      if (result.candidates.some(c => c.status === 'rpc-error')) result.warnings.push('RPC 오류로 일부 후보를 확인하지 못했습니다.');
      return finish(identified.length === 1 ? 'found' : 'multiple', identified.length === 1 ? '브릿지 컨트랙트 후보를 확인했습니다.' : `${identified.length}개의 브릿지 후보를 확인했습니다. 사용할 후보를 선택하세요.`);
    }
    const rpcFailure = result.candidates.find(c => c.status === 'rpc-error');
    if (rpcFailure) return finish('rpc-error', rpcFailure.reason);
    if (result.candidates.some(c => c.status === 'unsupported')) return finish('unsupported', '현재 지원하는 표준 OFT V2 형식으로 확인하지 못했습니다. 후보별 사유를 확인하세요.');
    if (result.catalog?.status === 'unavailable' || result.catalog?.status === 'stale') return finish('metadata-error', 'OFT 목록 API 오류 — 자동 탐색을 완료하지 못했습니다. 브릿지 주소나 성공한 거래 해시로 확인할 수 있습니다.');
    return result;
  } catch (error) {
    checkAbort();
    return finish(error instanceof TransactionError ? 'transaction-error' : 'rpc-error', error instanceof TransactionError ? error.message : transportMessage(error));
  }
}
