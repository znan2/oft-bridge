import type { ApiErrorCode } from '../shared/api';

export class AppError extends Error {
  constructor(public code: ApiErrorCode, message: string, public status = 400) { super(message); }
}
export function rpcError(chainName: string) {
  return new AppError('RPC_ERROR', `RPC 오류 — ${chainName} 조회를 완료하지 못했습니다. 다시 시도하거나 RPC를 직접 입력하세요.`, 503);
}
