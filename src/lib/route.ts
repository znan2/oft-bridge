import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, isAddress, isHex, zeroAddress, type Hex } from 'viem';
import { chainById, isChainId, type ChainId } from '../../shared/chains';
import { PROTOCOL } from '../../shared/protocol';
import { EXECUTOR_CONFIG_ABI, ROUTE_ABI } from '../../shared/route-abi';
import type { CandidateStore } from '../../shared/discovery';
import type { CheckStatus, ProtocolCatalog, RouteCheck, RouteInput, RouteResult, RouteSide } from '../../shared/route';
import { discover, RpcCallError } from './discovery';
import { decodeUln, matchDvns, peerAddress } from './route-config';

export interface RouteIO { rpc(chainId: ChainId, method: string, params: unknown[]): Promise<unknown>; protocol(): Promise<ProtocolCatalog>; store: CandidateStore }
class Unavailable extends Error {}
class Failure extends Error {}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const quantity = (x: unknown): x is Hex => typeof x === 'string' && /^0x[0-9a-f]+$/i.test(x);
const CHECKS = [
  ['source-identity', '출발 컨트랙트 재검증'], ['source-peer', '목적지 peer'], ['destination-identity', '목적지 토큰·브릿지'],
  ['reciprocal-peer', '목적지의 역방향 peer'], ['endpoints', '공식 Endpoint · EID'], ['message-format', 'OFT 버전 · sharedDecimals'],
  ['libraries', '실효 송신·수신 라이브러리'], ['uln', '실효 DVN 설정'], ['confirmations', '블록 확인 수'], ['dvns', '양쪽 DVN 운영자 대응'],
  ['executor', 'Executor · 메시지 크기'], ['options', '강제 실행 옵션 조회'],
] as const;
function aggregate(checks: RouteCheck[]): CheckStatus { return checks.some(c => c.status === 'FAIL') ? 'FAIL' : checks.some(c => c.status === 'UNKNOWN') ? 'UNKNOWN' : 'PASS'; }
export async function validateRoute(input: RouteInput, io: RouteIO, signal?: AbortSignal): Promise<RouteResult> {
  const result: RouteResult = { input, checkedAt: new Date().toISOString(), status: 'UNKNOWN', configurationStatus: 'UNKNOWN', executionReady: false, checks: [], warnings: [] };
  const abort = () => signal?.throwIfAborted();
  const snapshots = new Map<ChainId, string>();
  const cache = new Map<string, Promise<unknown>>();
  const rpc = async (chainId: ChainId, method: string, params: unknown[]) => { abort(); const response = await io.rpc(chainId, method, params); abort(); return response; };
  const add = (id: string, title: string, status: CheckStatus, detail: string, scope: RouteCheck['scope'] = 'configuration', chainId?: ChainId, address?: string) => result.checks.push({ id, title, status, detail, scope, chainId, address, blockNumber: chainId ? snapshots.get(chainId) : undefined });
  async function check<T>(id: string, title: string, run: () => Promise<T>, scope: RouteCheck['scope'] = 'configuration', chainId?: ChainId, address?: string): Promise<T | undefined> {
    try { return await run(); }
    catch (error) { abort(); add(id, title, error instanceof Failure ? 'FAIL' : 'UNKNOWN', error instanceof Failure || error instanceof Unavailable ? error.message : `RPC 오류 — ${chainId ? chainById(chainId).shortName + ' · ' : ''}${error instanceof Error ? error.message : '응답 미확인'}`, scope, chainId, address); return undefined; }
  }
  async function hasCode(chainId: ChainId, target: string) {
    const value = await rpc(chainId, 'eth_getCode', [target, snapshots.get(chainId)]);
    if (typeof value !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(value)) throw new Error('잘못된 코드 응답');
    return value !== '0x';
  }
  function read(chainId: ChainId, target: string, fn: (typeof ROUTE_ABI)[number]['name'], args: unknown[] = []): Promise<unknown> {
    const key = `${chainId}:${target.toLowerCase()}:${fn}:${JSON.stringify(args)}`;
    if (!cache.has(key)) cache.set(key, (async () => {
      let raw: unknown;
      try { raw = await rpc(chainId, 'eth_call', [{ to: target, data: encodeFunctionData({ abi: ROUTE_ABI, functionName: fn, args: args as never }) }, snapshots.get(chainId)]); }
      catch (error) { if (error instanceof RpcCallError && (error.code === 3 || /execution reverted|\brevert(?:ed)?\b/i.test(error.message))) throw new Unavailable(`${fn} 조회가 revert했습니다. 지원 인터페이스 또는 설정을 확인하지 못했습니다.`); throw error; }
      if (typeof raw !== 'string' || !isHex(raw) || raw.length % 2 !== 0) throw new Error('잘못된 컨트랙트 응답');
      if (fn === 'dstConfig' && ![258, 322].includes(raw.length)) throw new Unavailable('Executor dstConfig의 지원 형식(4/5 word)과 다릅니다.');
      try { return decodeFunctionResult({ abi: ROUTE_ABI, functionName: fn, data: raw }); } catch { throw new Unavailable(`${fn} 응답을 지원 ABI로 해석하지 못했습니다.`); }
    })());
    return cache.get(key)!;
  }
  async function identity(chainId: ChainId, bridgeAddress: string) {
    const found = await discover({ chainId, tokenAddress: bridgeAddress, manualAddress: bridgeAddress }, {
      rpc: (method, params) => method === 'eth_blockNumber' ? Promise.resolve(snapshots.get(chainId)) : rpc(chainId, method, params),
      catalog: async () => { throw new Error('Unused'); }, store: { list: async () => [], save: async () => {} },
    }, signal);
    const candidate = found.candidates.find(c => c.status === 'identified');
    if (!candidate?.identity) {
      if (found.status === 'no-code') throw new Failure('peer 주소에 컨트랙트 코드가 없습니다.');
      throw new Unavailable(found.status === 'rpc-error' ? found.message : `미지원 또는 미확인 OFT: ${found.candidates[0]?.reason ?? found.message}`);
    }
    return candidate.identity;
  }
  function finish() {
    abort();
    for (const [id, title] of CHECKS) if (!result.checks.some(c => c.id === id)) add(id, title, 'UNKNOWN', '선행 검사를 완료하지 못해 아직 확인하지 않았습니다.');
    // A general OFT getter cannot attest to arbitrary mint roles, transfer hooks, rate limits or recipient restrictions.
    if (!result.checks.some(c => c.id === 'custom')) add('custom', '커스텀 발행 권한·한도·수신 제약', 'UNKNOWN', '표준 조회만으로 구현별 제약을 모두 확인할 수 없습니다. 수량을 포함한 견적·시뮬레이션과 구현별 확인이 남아 있습니다.', 'execution');
    result.configurationStatus = aggregate(result.checks.filter(c => c.scope === 'configuration'));
    result.status = aggregate(result.checks);
    return result;
  }
  if (!isChainId(input.sourceChain) || !isChainId(input.destinationChain) || input.sourceChain === input.destinationChain || !isAddress(input.bridgeAddress) || !isAddress(input.tokenAddress)) {
    add('input', '경로 입력', 'FAIL', '지원 목록의 서로 다른 네트워크와 유효한 주소가 필요합니다.'); return finish();
  }
  const src = input.sourceChain, dst = input.destinationChain;
  const blockResults = await Promise.allSettled([src, dst].map(async chainId => {
    const block = await rpc(chainId, 'eth_blockNumber', []);
    if (!quantity(block)) throw new Error('잘못된 조회 블록');
    snapshots.set(chainId, block);
    return { chainId, blockNumber: block } satisfies RouteSide;
  }));
  abort();
  for (const [i, block] of blockResults.entries()) {
    const chainId = i === 0 ? src : dst;
    if (block.status === 'fulfilled') { if (i === 0) result.source = block.value; else result.destination = block.value; }
    else add(`rpc-${chainId}`, `${chainById(chainId).shortName} RPC`, 'UNKNOWN', `RPC 오류 — ${block.reason instanceof Error ? block.reason.message : '블록 조회 실패'}`, 'configuration', chainId);
  }
  if (!result.source || !result.destination) return finish();
  const source = result.source, destination = result.destination;
  source.identity = await check('source-identity', '출발 컨트랙트 재검증', async () => {
    const value = await identity(src, input.bridgeAddress);
    if (!same(value.token.address, input.tokenAddress)) throw new Failure('출발 브릿지의 token()이 선택한 토큰과 다릅니다. CA를 다시 조회하세요.');
    add('source-identity', '출발 컨트랙트 재검증', 'PASS', `${value.kind} · token() 관계 재확인`, 'configuration', src, value.bridgeAddress); return value;
  }, 'configuration', src, input.bridgeAddress);
  if (!source.identity) return finish();
  const target = await check('source-peer', '목적지 peer', async () => {
    const value = await read(src, input.bridgeAddress, 'peers', [chainById(dst).eid]);
    source.peer = String(value);
    if (/^0x0{64}$/i.test(source.peer)) throw new Failure(`${chainById(dst).shortName} 목적지 브릿지가 설정되어 있지 않습니다. peers(${chainById(dst).eid}) = 0x00…00 (미설정). 출발 네트워크의 토큰 CA를 확인하세요.`);
    let target: string; try { target = peerAddress(String(value)); } catch (error) { throw new Failure((error as Error).message); }
    add('source-peer', '목적지 peer', 'PASS', `출발 peers(${chainById(dst).eid}) → ${target}`, 'configuration', src, input.bridgeAddress); return target;
  }, 'configuration', src, input.bridgeAddress);
  if (!target) return finish();
  destination.identity = await check('destination-identity', '목적지 토큰·브릿지', async () => {
    const value = await identity(dst, target);
    add('destination-identity', '목적지 토큰·브릿지', 'PASS', `${value.kind} · token() ${value.token.address}`, 'configuration', dst, target); return value;
  }, 'configuration', dst, target);
  if (!destination.identity) return finish();
  const reciprocal = await check('reciprocal-peer', '목적지의 역방향 peer', async () => {
    const raw = await read(dst, target, 'peers', [chainById(src).eid]); destination.peer = String(raw);
    let peer: string; try { peer = peerAddress(String(raw)); } catch { throw new Failure('목적지에 출발 네트워크의 peer가 없거나 EVM 형식이 아닙니다.'); }
    if (!same(peer, input.bridgeAddress)) throw new Failure(`목적지 peer가 다른 출발 컨트랙트를 가리킵니다: ${peer}`);
    add('reciprocal-peer', '목적지의 역방향 peer', 'PASS', '양쪽 peer가 서로를 가리킵니다. 역방향 전송 설정은 별도로 검사해야 합니다.', 'configuration', dst, target); return true;
  }, 'configuration', dst, target);
  const endpoints = await check('endpoints', '공식 Endpoint · EID', async () => {
    for (const side of [source, destination]) {
      if (!same(side.identity!.endpoint, PROTOCOL[side.chainId].endpoint)) throw new Failure(`${chainById(side.chainId).shortName} Endpoint가 공식 배포 주소와 다릅니다.`);
      if (!await hasCode(side.chainId, side.identity!.endpoint)) throw new Failure('Endpoint 주소에 코드가 없습니다.');
      if (await read(side.chainId, side.identity!.endpoint, 'eid') !== chainById(side.chainId).eid) throw new Failure(`${chainById(side.chainId).shortName} Endpoint EID가 일치하지 않습니다.`);
    }
    add('endpoints', '공식 Endpoint · EID', 'PASS', `공식 배포 주소와 EID ${chainById(src).eid} → ${chainById(dst).eid} 일치`); return true;
  });
  const format = source.identity.messageVersion === destination.identity.messageVersion && source.identity.interfaceId === destination.identity.interfaceId && source.identity.sharedDecimals === destination.identity.sharedDecimals;
  add('message-format', 'OFT 버전 · sharedDecimals', format ? 'PASS' : 'FAIL', `메시지 버전 ${source.identity.messageVersion}/${destination.identity.messageVersion} · sharedDecimals ${source.identity.sharedDecimals}/${destination.identity.sharedDecimals}. localDecimals는 체인별로 다를 수 있습니다.`);
  if (!reciprocal || !endpoints || !format) return finish();
  let catalog: ProtocolCatalog;
  try { catalog = await io.protocol(); abort(); }
  catch { abort(); catalog = { status: 'unavailable', fetchedAt: null, sourceUrl: '', chains: [], warnings: ['프로토콜 메타데이터 조회 오류입니다.'] }; }
  result.catalog = { status: catalog.status, sourceUrl: catalog.sourceUrl, fetchedAt: catalog.fetchedAt }; result.warnings.push(...catalog.warnings);
  const registryMatches = catalog.status === 'fresh' && [src, dst].every(chainId => {
    const row = catalog.chains.find(c => c.chainId === chainId);
    return row && (['endpoint', 'sendLibrary', 'receiveLibrary', 'blockedLibrary', 'deadDvn'] as const).every(key => same(row[key], PROTOCOL[chainId][key]));
  });
  add('protocol-registry', '공식 배포 정보 최신 대조', registryMatches ? 'PASS' : 'UNKNOWN', registryMatches ? '등록한 Endpoint·ULN302 프로필이 최신 공식 배포 목록과 일치합니다.' : '공식 배포 목록 조회 실패 또는 프로필 변경으로 최신 대조를 완료하지 못했습니다.');
  // Store reciprocal address evidence only; this record never stores a PASS or a transfer plan.
  try { await io.store.save({ id: `${dst}:${destination.identity.token.address.toLowerCase()}:${target.toLowerCase()}`, chainId: dst, tokenAddress: destination.identity.token.address, bridgeAddress: target, source: 'peer', savedAt: new Date().toISOString() }); }
  catch { result.warnings.push('목적지 peer 후보를 브라우저에 저장하지 못했습니다.'); }
  abort();
  const libraries = await check('libraries', '실효 송신·수신 라이브러리', async () => {
    source.library = String(await read(src, source.identity!.endpoint, 'getSendLibrary', [input.bridgeAddress, chainById(dst).eid]));
    source.defaultLibrary = await read(src, source.identity!.endpoint, 'isDefaultSendLibrary', [input.bridgeAddress, chainById(dst).eid]) as boolean;
    const receive = await read(dst, destination.identity!.endpoint, 'getReceiveLibrary', [target, chainById(src).eid]) as [string, boolean];
    destination.library = receive[0]; destination.defaultLibrary = receive[1];
    for (const side of [source, destination]) {
      const remote = side === source ? dst : src;
      const expected = side === source ? PROTOCOL[side.chainId].sendLibrary : PROTOCOL[side.chainId].receiveLibrary;
      if (same(side.library!, zeroAddress) || same(side.library!, PROTOCOL[side.chainId].blockedLibrary)) throw new Failure('비어 있거나 차단된 메시지 라이브러리입니다.');
      if (!await hasCode(side.chainId, side.library!)) throw new Failure('라이브러리 주소에 코드가 없습니다.');
      if (await read(side.chainId, side.identity!.endpoint, 'isRegisteredLibrary', [side.library!]) !== true) throw new Failure('Endpoint에 등록되지 않은 라이브러리입니다.');
      if (!same(side.library!, expected)) throw new Unavailable(`현재 지원하는 공식 ULN302와 다른 라이브러리입니다: ${side.library}`);
      const version = await read(side.chainId, side.library!, 'version') as [bigint, number, number];
      if (version[0] !== 3n || version[1] !== 0 || version[2] !== 2) throw new Unavailable('검증한 ULN302 버전 (3,0,2)과 다릅니다.');
      if (await read(side.chainId, side.library!, 'isSupportedEid', [chainById(remote).eid]) !== true) throw new Failure('라이브러리가 상대 네트워크 EID를 지원하지 않습니다.');
    }
    add('libraries', '실효 송신·수신 라이브러리', 'PASS', `공식 SendUln302 → ReceiveUln302 · 송신 ${source.defaultLibrary ? '기본 설정' : '개별 설정'} / 수신 ${destination.defaultLibrary ? '기본 설정' : '개별 설정'}`); return true;
  });
  if (libraries) {
    const uln = await check('uln', '실효 DVN 설정', async () => {
      for (const side of [source, destination]) {
        const remote = side === source ? dst : src;
        const raw = await read(side.chainId, side.identity!.endpoint, 'getConfig', [side.identity!.bridgeAddress, side.library, chainById(remote).eid, 2]);
        try { side.uln = decodeUln(raw as Hex); } catch (error) { throw new Unavailable((error as Error).message); }
        for (const dvn of new Set([...side.uln.requiredDVNs, ...side.uln.optionalDVNs])) {
          if (same(dvn, PROTOCOL[side.chainId].deadDvn)) throw new Failure('실효 설정에 Dead DVN이 포함되어 있습니다.');
          if (!await hasCode(side.chainId, dvn)) throw new Failure(`DVN 주소에 코드가 없습니다: ${dvn}`);
        }
      }
      add('uln', '실효 DVN 설정', 'PASS', 'Endpoint getConfig로 기본값 상속이 적용된 DVN 설정을 조회했습니다.'); return true;
    });
    if (uln) {
      add('confirmations', '블록 확인 수', BigInt(source.uln!.confirmations) >= BigInt(destination.uln!.confirmations) ? 'PASS' : 'FAIL', `출발 요청 ${source.uln!.confirmations} ≥ 목적지 요구 ${destination.uln!.confirmations} 여부`);
      const dvns = matchDvns(source.uln!, destination.uln!, src, dst, catalog); add('dvns', '양쪽 DVN 운영자 대응', dvns.status, dvns.detail);
    }
    await check('executor', 'Executor · 메시지 크기', async () => {
      const raw = await read(src, source.identity!.endpoint, 'getConfig', [input.bridgeAddress, source.library, chainById(dst).eid, 1]);
      let decoded: { maxMessageSize: number; executor: string };
      try { [decoded] = decodeAbiParameters(EXECUTOR_CONFIG_ABI, raw as Hex); } catch { throw new Unavailable('Executor 설정 응답을 해석하지 못했습니다.'); }
      result.executor = { address: decoded.executor, maxMessageSize: decoded.maxMessageSize };
      if (same(decoded.executor, zeroAddress) || !await hasCode(src, decoded.executor)) throw new Failure('Executor가 비어 있거나 코드가 없습니다.');
      if (decoded.maxMessageSize < 40) throw new Failure('기본 OFT SEND 메시지 40바이트를 수용하지 못합니다.');
      if (!(PROTOCOL[src].executors as readonly string[]).some(a => same(a, decoded.executor))) throw new Unavailable('커스텀 Executor입니다. 자동 실행 조건은 구현별 확인이 필요합니다.');
      const config = await read(src, decoded.executor, 'dstConfig', [chainById(dst).eid]) as [bigint, number, bigint, bigint];
      result.executor.baseGas = config[0].toString(); result.executor.nativeCap = config[3].toString();
      if (config[0] === 0n || config[3] === 0n) throw new Failure('Executor의 목적지 기본 가스 또는 nativeCap이 0입니다. 실행 경로 설정을 확인하세요.');
      add('executor', 'Executor · 메시지 크기', 'PASS', `공식 Executor · 최대 ${decoded.maxMessageSize} bytes · 목적지 baseGas ${config[0]} / nativeCap ${config[3]}. 실제 fee·가스 충분성은 M4에서 확인합니다.`, 'configuration', src, decoded.executor);
    }, 'configuration', src);
  }
  await check('options', '강제 실행 옵션 조회', async () => {
    result.enforcedOptions = String(await read(src, input.bridgeAddress, 'enforcedOptions', [chainById(dst).eid, 1]));
    if (result.enforcedOptions !== '0x' && !/^0x0003(?:[0-9a-f]{2})*$/i.test(result.enforcedOptions)) throw new Unavailable('지원하는 Type 3 강제 옵션 형식과 다릅니다.');
    add('options', '강제 실행 옵션 조회', 'PASS', result.enforcedOptions === '0x' ? '강제 옵션 없음. 필요한 caller 옵션은 M4에서 결정합니다.' : 'SEND(msgType 1) 강제 옵션을 읽었습니다. 옵션 내용·가스 충분성은 M4에서 검증합니다.', 'configuration', src, input.bridgeAddress);
  }, 'configuration', src, input.bridgeAddress);
  for (const side of [source, destination]) {
    for (const [role, targetAddress] of new Map([[side.identity!.bridgeAddress.toLowerCase(), '브릿지'], [side.identity!.token.address.toLowerCase(), '토큰']]).entries()) {
      const id = `pause-${side.chainId}-${role}`;
      await check(id, `${chainById(side.chainId).shortName} ${targetAddress} 일시정지`, async () => {
        const paused = await read(side.chainId, role, 'paused');
        add(id, `${chainById(side.chainId).shortName} ${targetAddress} 일시정지`, paused ? 'FAIL' : 'PASS', `paused() = ${paused}. 다른 제한의 부재를 뜻하지 않습니다.`, 'execution', side.chainId, role);
      }, 'execution', side.chainId, role);
    }
  }
  if (destination.identity.kind === 'OFTAdapter') {
    await check('liquidity', '목적지 어댑터 보관 잔액', async () => {
      result.destinationBalanceLD = String(await read(dst, destination.identity!.token.address, 'balanceOf', [target]));
      add('liquidity', '목적지 어댑터 보관 잔액', BigInt(result.destinationBalanceLD) === 0n ? 'FAIL' : 'UNKNOWN', BigInt(result.destinationBalanceLD) === 0n ? '현재 보관 잔액이 0이므로 기본 lock/unlock 경로의 양수 전송을 해제할 수 없습니다.' : `현재 잔액 ${result.destinationBalanceLD} LD. 전송 수량이 정해진 뒤 충분한지 비교해야 합니다.`, 'execution', dst, target);
    }, 'execution', dst, target);
  } else add('liquidity', '목적지 어댑터 보관 잔액', 'NOT_APPLICABLE', '목적지가 self-OFT입니다. 어댑터 해제 잔액 검사를 적용하지 않으며 커스텀 민팅 제약은 별도로 남깁니다.', 'execution', dst, target);
  add('workers-live', 'DVN·Executor 실제 가동 상태', 'UNKNOWN', '온체인 설정만으로 운영자의 현재 가동 상태·작업 수락·향후 실행을 보장할 수 없습니다.', 'execution');
  return finish();
}
