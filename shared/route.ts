import type { ChainId } from './chains';
import type { BridgeIdentity } from './discovery';
export type CheckStatus = 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT_APPLICABLE';
export interface RouteCheck { id: string; title: string; status: CheckStatus; scope: 'configuration' | 'execution'; detail: string; chainId?: ChainId; address?: string; blockNumber?: string }
export interface DvnRecord { address: string; id: string; name: string; version: number; deprecated: boolean; lzReadCompatible: boolean }
export interface ProtocolChain { chainId: ChainId; eid: number; endpoint: string; sendLibrary: string; receiveLibrary: string; blockedLibrary: string; deadDvn: string; executors: string[]; dvns: DvnRecord[] }
export interface ProtocolCatalog { status: 'fresh' | 'stale' | 'unavailable'; fetchedAt: string | null; sourceUrl: string; chains: ProtocolChain[]; warnings: string[] }
export interface UlnConfig { confirmations: string; requiredDVNCount: number; optionalDVNCount: number; optionalDVNThreshold: number; requiredDVNs: string[]; optionalDVNs: string[] }
export interface RouteInput { sourceChain: ChainId; destinationChain: ChainId; bridgeAddress: string; tokenAddress: string }
export interface RouteSide { chainId: ChainId; blockNumber: string; identity?: BridgeIdentity; peer?: string; library?: string; defaultLibrary?: boolean; uln?: UlnConfig }
export interface RouteResult {
  input: RouteInput; checkedAt: string; configurationStatus: CheckStatus; status: CheckStatus; executionReady: false;
  checks: RouteCheck[]; source?: RouteSide; destination?: RouteSide;
  executor?: { address: string; maxMessageSize: number; baseGas?: string; nativeCap?: string };
  enforcedOptions?: string; destinationBalanceLD?: string; catalog?: Pick<ProtocolCatalog, 'status' | 'fetchedAt' | 'sourceUrl'>;
  warnings: string[];
}
