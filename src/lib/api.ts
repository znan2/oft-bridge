import type { ApiFailure, RpcResponse } from '../../shared/api';
import type { ChainId } from '../../shared/chains';

export class ApiError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
// Leave room for all 3 public fallbacks, each with a 6s chain probe and a 6s read.
export const API_TIMEOUT_MS = 45_000;

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) abort(); else init.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('API timeout')), API_TIMEOUT_MS);
  try {
    const response = await fetch(`/api${path}`, {
      ...init, signal: controller.signal, headers: { 'x-oft-client': 'local-dashboard', ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    });
    if (!response.ok) {
      const failure: ApiFailure | null = await response.json().catch(error => { if (controller.signal.aborted) throw error; return null; });
      throw new ApiError(failure?.code ?? 'LOCAL_SERVER_ERROR', failure?.message ?? '로컬 조회 서버에서 요청을 처리하지 못했습니다.');
    }
    return await response.json() as T;
  } catch (error) {
    if (init.signal?.aborted) throw error;
    if (controller.signal.aborted) throw new ApiError('LOCAL_SERVER_TIMEOUT', '로컬 조회 서버 응답 시간이 초과됐습니다. 실행 상태를 확인하고 다시 조회하세요.');
    if (error instanceof ApiError) throw error;
    throw new ApiError('LOCAL_SERVER_ERROR', '로컬 조회 서버에 연결할 수 없습니다. 실행 상태를 확인하세요.');
  } finally {
    clearTimeout(timeout); init.signal?.removeEventListener('abort', abort);
  }
}
export async function nativeBalance(chainId: ChainId, address: string, signal: AbortSignal) {
  const response = await api<RpcResponse>(`/rpc/${chainId}`, {
    method: 'POST', signal, body: JSON.stringify({ jsonrpc: '2.0', id: 'balance', method: 'eth_getBalance', params: [address, 'latest'] }),
  });
  if (response.error) throw new Error(`잔액 조회 실패 — ${response.error.message}`);
  if (typeof response.result !== 'string' || !/^0x[0-9a-f]+$/i.test(response.result)) throw new Error('RPC 오류 — 잔액 응답을 확인하지 못했습니다.');
  return BigInt(response.result);
}
