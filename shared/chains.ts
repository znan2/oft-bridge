import mainnet from './chain-registry.json';
import testnet from './chain-registry.testnet.json';
import { NETWORK_MODE } from './network';
export type ChainId = number;
export type FeeModel = 'standard' | 'op-stack' | 'arbitrum' | 'unreviewed';
export interface BridgeChain {
  id: ChainId; eid: number; key: string; name: string; shortName: string; symbol: string; decimals: number;
  explorer: string; rpcs: readonly string[]; feeModel: FeeModel; sourceRestriction?: string;
}
export interface RegistryChain extends BridgeChain {
  protocol: { endpoint: string; sendLibrary: string; receiveLibrary: string; blockedLibrary: string; deadDvn: string; executors: string[] };
}
// Mainnet chains are only reachable when OFT_NETWORK=mainnet is chosen explicitly.
export const REGISTRY = (NETWORK_MODE === 'mainnet' ? mainnet : testnet) as { sourceUrl: string; generatedAt: string; chains: RegistryChain[] };
export const CHAINS: readonly BridgeChain[] = REGISTRY.chains;
const byId = new Map(CHAINS.map(c => [c.id, c]));
export function isChainId(value: unknown): value is ChainId { return typeof value === 'number' && Number.isSafeInteger(value) && byId.has(value); }
export function chainById(id: ChainId): BridgeChain {
  const chain = byId.get(id);
  if (!chain) throw new Error(`지원 목록에 없는 Chain ID: ${id}`);
  return chain;
}
export const CHAIN_REGISTRY_SOURCE = { url: REGISTRY.sourceUrl, generatedAt: REGISTRY.generatedAt, network: NETWORK_MODE };
