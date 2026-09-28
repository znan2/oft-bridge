import type { ChainId } from './chains';

export type CandidateSource = 'direct' | 'metadata' | 'manual' | 'transaction' | 'saved';
export interface DeploymentRecord {
  chainId: ChainId; address: string; tokenAddress: string | null; symbol: string; name: string;
  declaredType: string; endpointVersion: string | null;
}
export interface Catalog {
  status: 'fresh' | 'stale' | 'unavailable' | 'skipped'; fetchedAt: string | null;
  sourceUrl: string; deployments: DeploymentRecord[]; warnings: string[];
}
export interface TokenIdentity { address: string; symbol: string | null; name: string | null; decimals: number | null }
export interface BridgeIdentity {
  bridgeAddress: string; token: TokenIdentity; kind: 'OFT' | 'OFTAdapter';
  endpoint: string; interfaceId: string; messageVersion: string;
  sharedDecimals: number; approvalRequired: boolean;
}
export interface CandidateEvidence { source: CandidateSource; detail: string; transactionHash?: string }
export interface CandidateCheck {
  address: string; status: 'identified' | 'unsupported' | 'mismatch' | 'no-code' | 'not-oft' | 'rpc-error';
  reason: string; sources: CandidateEvidence[]; identity?: BridgeIdentity;
}
export interface SavedCandidate {
  id: string; chainId: ChainId; tokenAddress: string; bridgeAddress: string;
  source: 'manual' | 'transaction' | 'peer'; transactionHash?: string; savedAt: string;
}
export interface CandidateStore {
  list(chainId: ChainId, tokenAddress: string): Promise<SavedCandidate[]>;
  save(candidate: SavedCandidate): Promise<void>;
}
export type TransactionEvidence = { hash: string; bridgeAddress: string; blockNumber: string; guid: string } & (
  { kind: 'send'; dstEid: number } | { kind: 'receive'; srcEid: number; recipient: string; endpoint: string }
);
export interface DiscoveryInput { chainId: ChainId; tokenAddress: string; manualAddress?: string; transactionHash?: string }
export interface DiscoveryResult {
  status: 'found' | 'multiple' | 'not-found' | 'no-code' | 'unsupported' | 'rpc-error' | 'metadata-error' | 'input-error' | 'transaction-error';
  inputAddress: string; chainId: ChainId; blockNumber: string | null; checkedAt: string;
  token: TokenIdentity | null; candidates: CandidateCheck[]; message: string; warnings: string[];
  catalog: Pick<Catalog, 'status' | 'fetchedAt' | 'sourceUrl'> | null; transaction?: TransactionEvidence; transactions?: TransactionEvidence[];
}
