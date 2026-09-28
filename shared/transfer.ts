import type { RouteInput, RouteResult } from './route';
export interface TransferInput {
  route: RouteInput; sender: string; recipient: string; refundAddress: string;
  amount: string; slippagePercent: string; extraReceiveGas: string;
  walletChainId: number; providerUid: string; rpcRevision: number;
}
export interface SendParam {
  dstEid: number; to: `0x${string}`; amountLD: string; minAmountLD: string;
  extraOptions: `0x${string}`; composeMsg: '0x'; oftCmd: '0x';
}
export interface TransferIssue { code: string; message: string; data?: string }
export interface TransferPlan {
  input: TransferInput; fingerprint: string; createdAt: string; expiresAt: string;
  route: RouteResult; executionReady: false;
  amounts: { requestedLD: string; sentLD: string; receivedLD: string; dustLD: string; sourceRemainderLD: string; destinationLD: string; destinationMinimumLD: string; sourceDecimals: number; destinationDecimals: number; sharedDecimals: number; slippageBps: string };
  options: { enforced: string; extra: string; combined: string; receiveGas: string; ordered: boolean };
  limits: { minAmountLD: string; maxAmountLD: string };
  tokenFees: { feeAmountLD: string; description: string }[];
  sendParam: SendParam; fee: { nativeFee: string; lzTokenFee: '0' }; refundAddress: string;
  transaction: { chainId: number; from: string; to: string; data: `0x${string}`; value: string };
  balances: { tokenLD: string; nativeWei: string; destinationLD?: string };
  approval: { required: boolean; allowanceLD?: string; amountLD: string; needed: boolean; token: string; spender: string; data?: string };
  blockers: TransferIssue[]; warnings: string[];
  simulation: { status: 'passed' | 'blocked' | 'failed'; detail: string; issue?: TransferIssue };
  gas?: { model?: string; dataFeeWei?: string; operatorFeeWei?: string; additionalBudgetWei?: string; estimate: string; limitWithBuffer: string; priceWei: string; estimatedCostWei: string; budgetWithBufferWei: string; totalNativeBudgetWei: string };
}
