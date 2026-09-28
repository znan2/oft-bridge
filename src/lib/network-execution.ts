import { decodeFunctionResult, encodeFunctionData, parseAbi, serializeTransaction, type Address, type Hex } from 'viem';
import { chainById, type ChainId } from '../../shared/chains';
import type { TransferPlan } from '../../shared/transfer';
import type { RouteIO } from './route';
import { fail } from './transfer-math';
export const OP_ORACLE = '0x420000000000000000000000000000000000000F';
export const OP_FEE_ABI = parseAbi(['function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)', 'function getOperatorFee(uint256 gasUsed) view returns (uint256)']);
type Call = { from: string; to: string; data: Hex; value: string };
const uint = (x: unknown) => { if (typeof x !== 'string' || !/^0x[\da-f]+$/i.test(x)) fail('RPC 오류 — 잘못된 수량 응답입니다.', 'RPC_ERROR'); return BigInt(x); };
export const bufferGas = (n: bigint) => (n * 120n + 99n) / 100n;
export function assertSourceSupported(chainId: ChainId) {
  const chain = chainById(chainId);
  if (chain.sourceRestriction || chain.feeModel === 'unreviewed') fail(`${chain.shortName}: ${chain.sourceRestriction ?? '출발 전송 방식을 아직 지원하지 않습니다.'}`, 'UNSUPPORTED_NETWORK');
}
// Additional fees are a balance budget, never added to OFT msg.value.
// Arbitrum's eth_estimateGas already accounts for its L1 component; do not double-count it.
export async function additionalNetworkFee(chainId: ChainId, call: Call, gas: bigint, price: bigint, io: Pick<RouteIO, 'rpc'>, block = 'latest', knownNonce?: bigint) {
  assertSourceSupported(chainId);
  if (chainById(chainId).feeModel !== 'op-stack') return { dataFeeWei: '0', operatorFeeWei: '0', additionalBudgetWei: '0' };
  try {
    const nonce = knownNonce ?? uint(await io.rpc(chainId, 'eth_getTransactionCount', [call.from, 'pending']));
    if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('nonce 범위 초과');
    // Matches our actual legacy wallet request. Oracle accounts for signature bytes itself.
    const unsigned = serializeTransaction({ type: 'legacy', chainId, to: call.to as Address, data: call.data, value: BigInt(call.value), gas, gasPrice: price, nonce: Number(nonce) });
    async function read(functionName: 'getL1FeeUpperBound' | 'getOperatorFee', value: bigint) {
      const raw = await io.rpc(chainId, 'eth_call', [{ to: OP_ORACLE, data: encodeFunctionData({ abi: OP_FEE_ABI, functionName, args: [value] }) }, block]);
      return decodeFunctionResult({ abi: OP_FEE_ABI, functionName, data: raw as Hex });
    }
    const [data, operator] = await Promise.all([read('getL1FeeUpperBound', BigInt((unsigned.length - 2) / 2)), read('getOperatorFee', gas)]);
    return { dataFeeWei: data.toString(), operatorFeeWei: operator.toString(), additionalBudgetWei: bufferGas(data + operator).toString() };
  } catch (error) {
    fail(`RPC 오류 또는 추가 수수료 조회 미지원 — ${chainById(chainId).shortName}의 L1 데이터·운영자 비용을 확인하지 못했습니다. RPC를 바꿔 다시 확인하세요. (${error instanceof Error ? error.message : '응답 미확인'})`, 'NETWORK_FEE_UNAVAILABLE');
  }
}
export async function estimateNetworkGas(chainId: ChainId, call: Call, io: Pick<RouteIO, 'rpc'>, block?: string): Promise<NonNullable<TransferPlan['gas']>> {
  assertSourceSupported(chainId);
  const [estimate, price] = await Promise.all([io.rpc(chainId, 'eth_estimateGas', block ? [call, block] : [call]).then(uint), io.rpc(chainId, 'eth_gasPrice', []).then(uint)]);
  if (!estimate || !price) fail('가스 추정 응답이 0입니다.', 'RPC_ERROR');
  const limit = bufferGas(estimate), extra = await additionalNetworkFee(chainId, call, limit, price, io, block);
  const budget = limit * price + BigInt(extra.additionalBudgetWei);
  return { model: chainById(chainId).feeModel, estimate: estimate.toString(), limitWithBuffer: limit.toString(), priceWei: price.toString(), estimatedCostWei: (estimate * price + BigInt(extra.dataFeeWei) + BigInt(extra.operatorFeeWei)).toString(), budgetWithBufferWei: budget.toString(), totalNativeBudgetWei: (BigInt(call.value) + budget).toString(), ...extra };
}
function validBlock(value: unknown): value is { number: Hex; hash: Hex } {
  if (!value || typeof value !== 'object') return false;
  const v = value as { number?: unknown; hash?: unknown };
  return typeof v.number === 'string' && /^0x[\da-f]+$/i.test(v.number) && typeof v.hash === 'string' && /^0x[\da-f]{64}$/i.test(v.hash) && !/^0x0{64}$/i.test(v.hash);
}
export async function assertFinalityAvailable(chainId: ChainId, io: Pick<RouteIO, 'rpc'>) {
  try {
    const finalized = await io.rpc(chainId, 'eth_getBlockByNumber', ['finalized', false]);
    if (!validBlock(finalized)) throw new Error('finalized 응답 미확인');
    const canonical = await io.rpc(chainId, 'eth_getBlockByNumber', [finalized.number, false]);
    if (!validBlock(canonical) || canonical.number !== finalized.number || canonical.hash.toLowerCase() !== finalized.hash.toLowerCase()) throw new Error('확정 블록 해시 불일치');
    return finalized;
  } catch (error) {
    fail(`RPC 오류 또는 최종 확정 조회 미지원 — ${chainById(chainId).shortName}. 확정 블록을 확인하지 못했습니다. RPC를 바꿔 다시 확인하세요. (${error instanceof Error ? error.message : '응답 미확인'})`, 'FINALITY_UNAVAILABLE');
  }
}
