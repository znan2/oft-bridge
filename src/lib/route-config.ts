import { decodeAbiParameters, getAddress, type Hex } from 'viem';
import { ULN_CONFIG_ABI } from '../../shared/route-abi';
import type { CheckStatus, ProtocolCatalog, UlnConfig } from '../../shared/route';
import type { ChainId } from '../../shared/chains';
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export function decodeUln(data: Hex): UlnConfig {
  const [value] = decodeAbiParameters(ULN_CONFIG_ABI, data);
  const config = { ...value, confirmations: value.confirmations.toString(), requiredDVNs: [...value.requiredDVNs], optionalDVNs: [...value.optionalDVNs] };
  const sorted = (addresses: readonly string[]) => addresses.every((a, i) => BigInt(a) > 0n && (i === 0 || BigInt(a) > BigInt(addresses[i - 1])));
  if (config.requiredDVNCount !== config.requiredDVNs.length || config.optionalDVNCount !== config.optionalDVNs.length || config.requiredDVNCount > 127 || config.optionalDVNCount > 127 || config.optionalDVNThreshold > config.optionalDVNCount || (config.optionalDVNCount === 0) !== (config.optionalDVNThreshold === 0) || (!config.requiredDVNCount && !config.optionalDVNThreshold) || !sorted(config.requiredDVNs) || !sorted(config.optionalDVNs) || BigInt(config.confirmations) === (1n << 64n) - 1n) throw new Error('유효한 실효 ULN 설정이 아닙니다. 기본값/NIL 표식·DVN 개수·정렬·임계값을 확인하세요.');
  return config;
}
export function peerAddress(peer: string) {
  if (!/^0x0{24}[0-9a-f]{40}$/i.test(peer) || BigInt(peer) === 0n) throw new Error('peer가 비어 있거나 EVM 주소로 해석할 수 없습니다.');
  return getAddress(`0x${peer.slice(-40)}`);
}
export function matchDvns(send: UlnConfig, receive: UlnConfig, source: ChainId, destination: ChainId, catalog: ProtocolCatalog): { status: CheckStatus; detail: string } {
  if (catalog.status !== 'fresh') return { status: 'UNKNOWN', detail: '프로토콜 메타데이터 조회 오류 — 최신 DVN 운영자 관계를 확인하지 못했습니다.' };
  try {
    function ids(chainId: ChainId, addresses: string[]) {
      const chain = catalog.chains.find(c => c.chainId === chainId);
      if (!chain) throw new Error('체인의 DVN 목록을 찾지 못했습니다.');
      return addresses.map(address => {
        const match = chain.dvns.find(d => same(d.address, address));
        if (!match || match.deprecated || match.lzReadCompatible || match.version !== 2) throw new Error(`DVN 운영자 매핑 미확인: ${address}`);
        const alternatives = chain.dvns.filter(d => d.id === match.id && d.version === 2 && !d.deprecated && !d.lzReadCompatible);
        if (alternatives.length !== 1) throw new Error(`DVN 운영자의 활성 주소가 여러 개입니다: ${match.name}`);
        return match.id;
      });
    }
    // ULN302 assigns jobs to every source required AND optional DVN.
    const assigned = new Set(ids(source, [...send.requiredDVNs, ...send.optionalDVNs]));
    const required = ids(destination, receive.requiredDVNs);
    const optional = ids(destination, receive.optionalDVNs);
    const absent = required.filter(id => !assigned.has(id));
    const optionalMatches = optional.filter(id => assigned.has(id)).length;
    if (absent.length || optionalMatches < receive.optionalDVNThreshold) return { status: 'FAIL', detail: `목적지 검증 조건을 충족하지 못합니다. 누락 필수 DVN: ${absent.join(', ') || '없음'} · 선택 DVN ${optionalMatches}/${receive.optionalDVNThreshold}` };
    return { status: 'PASS', detail: `공식 운영자 ID 기준: ${[...assigned].join(', ')}. 목적지 필수 DVN과 선택 임계값 ${optionalMatches}/${receive.optionalDVNThreshold}을 포함합니다. 운영자의 실제 가동 상태는 별도입니다.` };
  } catch (error) { return { status: 'UNKNOWN', detail: error instanceof Error ? error.message : 'DVN 매핑 미확인' }; }
}
