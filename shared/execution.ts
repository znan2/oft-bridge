import type { TransferPlan } from './transfer';
export type ActionKind = 'approve-reset' | 'approve' | 'send';
export interface WalletTransaction {
  chainId: number; from: string; to: string; data: `0x${string}`; value: string; gas: string; gasPrice: string;
}
export interface ExecutionReview {
  gasBudget?: NonNullable<TransferPlan['gas']>; kind: ActionKind; plan: TransferPlan; transaction: WalletTransaction; expiresAt: string;
}
export type ExecutionStatus = 'wallet-pending' | 'unknown' | 'pending' | 'rejected' | 'source-failed' | 'approval-confirmed' | 'source-confirmed' | 'destination-pending' | 'destination-failed' | 'destination-confirming' | 'delivered' | 'replaced';
export interface ExecutionRecord {
  version: 1; id: string; createdAt: string; updatedAt: string; review: ExecutionReview;
  storageRevision?: number;
  nonce: string; hash?: string; originalHash?: string; status: ExecutionStatus; detail: string;
  sourceFinalized?: boolean; guid?: string; actualSentLD?: string; actualReceivedLD?: string;
  destinationHash?: string; destinationHashSource?: 'manual' | 'scan'; destinationAmountLD?: string; scanStatus?: string; trackingError?: string;
}
export interface ExecutionStore {
  list(): Promise<ExecutionRecord[]>;
  reserve(row: ExecutionRecord): Promise<void>;
  put(row: ExecutionRecord, expected?: ExecutionRecord): Promise<boolean | void>;
}
export const terminalStatus = (status: ExecutionStatus) => ['rejected', 'source-failed', 'approval-confirmed', 'delivered', 'replaced'].includes(status);
export const locksAccount = (row: ExecutionRecord) => !terminalStatus(row.status) && !row.sourceFinalized;
export const blockingExecution = (rows: ExecutionRecord[], chainId: number, account: string) => rows.find(row => row.review.transaction.chainId === chainId && row.review.transaction.from.toLowerCase() === account.toLowerCase() && locksAccount(row));
export function pendingExecutionMessage(row: ExecutionRecord) {
  const approval = row.review.kind !== 'send';
  return `${approval ? '토큰 승인' : '이전 전송'} 요청이 아직 미확정입니다. ${row.detail} ${approval ? '전송 이력에서 승인 확정 후 다시 검증하세요.' : '전송 이력에서 해당 요청을 먼저 확인하세요.'}`;
}
export interface ScanMessage {
  guid: string; srcEid: number; dstEid: number; sender: string; receiver: string; sourceHash: string;
  status: string; destinationHash?: string;
}
export interface ScanResult { messages: ScanMessage[]; checkedAt: string }
