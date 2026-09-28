import { decodeFunctionResult, encodeFunctionData, toHex, type Address, type Hex } from 'viem';
import type { ExecutionRecord, ExecutionReview, ExecutionStore } from '../../shared/execution';
import type { TransferInput } from '../../shared/transfer';
import type { ExecutionMode } from '../../shared/network';
import { OFT_QUOTE_ABI, OFT_SEND_ABI } from '../../shared/oft-abi';
import { prepareTransfer, encodeSend } from './transfer';
import { fail } from './transfer-math';
import type { RouteIO } from './route';
import { additionalNetworkFee, assertFinalityAvailable, assertSourceSupported, estimateNetworkGas } from './network-execution';
import { walletError } from './wallet';
export interface RabbySession {
  uid: string; assertCurrent(): void;
  /** Only 'live' (server started with --live) may open a wallet signature request. */
  executionMode: ExecutionMode;
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const uint = (x: unknown) => { if (typeof x !== 'string' || !/^0x[0-9a-f]+$/i.test(x)) fail('RPC 수량 응답을 확인하지 못했습니다.', 'RPC_ERROR'); return BigInt(x); };
export function reviewCall(review: ExecutionReview) {
  const t = review.transaction;
  return { from: t.from, to: t.to, data: t.data, value: toHex(BigInt(t.value)) };
}
function checkApprove(raw: unknown) {
  if (raw === '0x') return; // ERC-20s that return no value are supported.
  try { if (decodeFunctionResult({ abi: OFT_QUOTE_ABI, functionName: 'approve', data: raw as Hex })) return; } catch { /* Fail closed below. */ }
  fail('approve 시뮬레이션이 성공 값을 반환하지 않았습니다.', 'APPROVAL_FAILED');
}
export async function prepareExecution(input: TransferInput, io: RouteIO, signal?: AbortSignal): Promise<ExecutionReview> {
  const plan = await prepareTransfer(input, io, signal);
  const relevant = plan.blockers.filter(b => b.code !== 'APPROVAL_REQUIRED');
  if (relevant.length) fail(relevant.map(b => b.message).join(' / '), relevant[0].code);
  await Promise.all([input.route.sourceChain, input.route.destinationChain].map(chain => assertFinalityAvailable(chain, io)));
  if (plan.approval.needed) {
    const reset = BigInt(plan.approval.allowanceLD ?? '0') > 0n;
    const data = encodeFunctionData({ abi: OFT_QUOTE_ABI, functionName: 'approve', args: [plan.approval.spender as Address, reset ? 0n : BigInt(plan.approval.amountLD)] });
    const call = { from: input.sender, to: plan.approval.token, data, value: '0x0' };
    checkApprove(await io.rpc(input.route.sourceChain, 'eth_call', [call, 'latest']));
    const [gasBudget, balance] = await Promise.all([
      estimateNetworkGas(input.route.sourceChain, call, io), io.rpc(input.route.sourceChain, 'eth_getBalance', [input.sender, 'latest']).then(uint),
    ]);
    const buffered = BigInt(gasBudget.limitWithBuffer), price = BigInt(gasBudget.priceWei);
    if (balance < BigInt(gasBudget.budgetWithBufferWei) + BigInt(plan.fee.nativeFee)) fail('승인 가스비·추가 수수료와 브릿지 수수료를 위한 네이티브 잔액이 부족합니다.', 'GAS_BALANCE');
    signal?.throwIfAborted();
    return { gasBudget, kind: reset ? 'approve-reset' : 'approve', plan, expiresAt: plan.expiresAt, transaction: { chainId: input.route.sourceChain, from: input.sender, to: plan.approval.token, data, value: '0', gas: buffered.toString(), gasPrice: price.toString() } };
  }
  if (plan.simulation.status !== 'passed' || !plan.gas) fail('출발 시뮬레이션과 가스 추정을 완료해야 합니다.', 'SIMULATION_REQUIRED');
  return { gasBudget: plan.gas, kind: 'send', plan, expiresAt: plan.expiresAt, transaction: { ...plan.transaction, gas: plan.gas.limitWithBuffer, gasPrice: plan.gas.priceWei } };
}
function validateReview(review: ExecutionReview) {
  const p = review.plan, t = review.transaction;
  assertSourceSupported(t.chainId);
  if (Date.now() >= Date.parse(review.expiresAt) || !Number.isFinite(Date.parse(review.expiresAt))) fail('검토 견적이 만료되었습니다. 전송 직전 재검증을 다시 실행하세요.', 'QUOTE_EXPIRED');
  if (t.chainId !== p.input.route.sourceChain || !same(t.from, p.input.sender)) fail('검토 내용과 지갑 요청이 일치하지 않습니다.', 'WALLET_CONTEXT');
  if (review.kind === 'send') {
    if (p.blockers.length || p.simulation.status !== 'passed' || !same(t.to, p.input.route.bridgeAddress) || t.value !== p.fee.nativeFee || t.data !== encodeSend(p.sendParam, p.fee, p.refundAddress)) fail('전송 요청이 검증한 견적과 다릅니다.', 'REQUEST_MISMATCH');
  } else {
    const expected = encodeFunctionData({ abi: OFT_QUOTE_ABI, functionName: 'approve', args: [p.input.route.bridgeAddress as Address, review.kind === 'approve-reset' ? 0n : BigInt(p.approval.amountLD)] });
    if (!p.approval.needed || !same(t.to, p.input.route.tokenAddress) || t.value !== '0' || t.data !== expected) fail('승인 요청이 검토 내용과 다릅니다.', 'REQUEST_MISMATCH');
  }
}
async function checkSession(review: ExecutionReview, wallet: RabbySession, signal?: AbortSignal) {
  signal?.throwIfAborted(); wallet.assertCurrent();
  if (wallet.uid !== review.plan.input.providerUid) fail('Rabby 연결이 변경되었습니다. 다시 검증하세요.', 'WALLET_CONTEXT');
  const [accounts, chain] = await Promise.all([wallet.request({ method: 'eth_accounts' }), wallet.request({ method: 'eth_chainId' })]);
  signal?.throwIfAborted(); wallet.assertCurrent();
  if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || !same(accounts[0], review.transaction.from) || uint(chain) !== BigInt(review.transaction.chainId)) fail('Rabby 계정 또는 네트워크가 바뀌었습니다. 다시 검증하세요.', 'WALLET_CONTEXT');
}
function rejected(error: unknown) {
  const seen = new Set(); let e = error;
  while (e && typeof e === 'object' && !seen.has(e)) { seen.add(e); const v = e as { code?: number; cause?: unknown; name?: string }; if (v.code === 4001 || v.name === 'UserRejectedRequestError') return true; e = v.cause; }
  return false;
}
// One explicit click submits exactly one transaction. No retries around eth_sendTransaction.
export async function submitExecution(reviewInput: ExecutionReview, wallet: RabbySession, io: RouteIO, store: ExecutionStore, signal?: AbortSignal): Promise<ExecutionRecord> {
  // Fail closed before touching the wallet or the history store.
  if (wallet.executionMode !== 'live') fail('dry-run 모드입니다. 경로와 예상 수수료만 확인하며 서명·전송하지 않습니다. 실제 전송은 서버를 --live로 시작해야 합니다.', 'DRY_RUN');
  const review = structuredClone(reviewInput);
  validateReview(review); await checkSession(review, wallet, signal);
  const chain = review.plan.input.route.sourceChain, call = reviewCall(review);
  await Promise.all([chain, review.plan.input.route.destinationChain].map(id => assertFinalityAvailable(id, io)));
  const raw = await io.rpc(chain, 'eth_call', [call, 'latest']);
  if (review.kind !== 'send') checkApprove(raw);
  else {
    const [msg, receipt] = decodeFunctionResult({ abi: OFT_SEND_ABI, functionName: 'send', data: raw as Hex });
    if (receipt.amountSentLD.toString() !== review.plan.amounts.sentLD || receipt.amountReceivedLD.toString() !== review.plan.amounts.receivedLD || msg.fee.nativeFee.toString() !== review.plan.fee.nativeFee || msg.fee.lzTokenFee !== 0n) fail('최신 시뮬레이션 수량·수수료가 달라졌습니다. 다시 검토하세요.', 'SIMULATION_MISMATCH');
  }
  const [gas, balance, nonce] = await Promise.all([
    io.rpc(chain, 'eth_estimateGas', [call]).then(uint), io.rpc(chain, 'eth_getBalance', [call.from, 'latest']).then(uint), io.rpc(chain, 'eth_getTransactionCount', [call.from, 'pending']).then(uint),
  ]);
  const extra = await additionalNetworkFee(chain, call, BigInt(review.transaction.gas), BigInt(review.transaction.gasPrice), io, 'latest', nonce);
  if (BigInt(extra.dataFeeWei) + BigInt(extra.operatorFeeWei) > BigInt(review.gasBudget?.additionalBudgetWei ?? '0')) fail('최신 추가 수수료가 검토한 예산을 초과했습니다. 다시 검토하세요.', 'NETWORK_FEE_CHANGED');
  if (gas > BigInt(review.transaction.gas) || balance < BigInt(review.transaction.value) + BigInt(review.transaction.gas) * BigInt(review.transaction.gasPrice) + BigInt(extra.additionalBudgetWei)) fail('최신 가스 요구량 또는 잔액이 달라졌습니다. 다시 검토하세요.', 'GAS_BALANCE');
  await checkSession(review, wallet, signal); validateReview(review);
  const row: ExecutionRecord = { version: 1, id: crypto.randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), review, nonce: nonce.toString(), status: 'wallet-pending', detail: 'Rabby 확인 대기 · 자동 재요청하지 않습니다.' };
  await store.reserve(row); // Atomic cross-tab duplicate guard; persist intent before opening the wallet.
  const reserved = structuredClone(row);
  let requested = false;
  try {
    signal?.throwIfAborted(); wallet.assertCurrent(); validateReview(review);
    requested = true;
    const hash = await wallet.request({ method: 'eth_sendTransaction', params: [{ ...call, chainId: toHex(chain), gas: toHex(BigInt(review.transaction.gas)), gasPrice: toHex(BigInt(review.transaction.gasPrice)), nonce: toHex(nonce) }] });
    if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error('Rabby hash unavailable');
    row.hash = hash; row.status = 'pending'; row.detail = '출발 거래 전파됨 · 영수증 확인 대기';
  } catch (error) {
    row.status = !requested || rejected(error) ? 'rejected' : 'unknown';
    row.detail = row.status === 'rejected' ? (!requested ? '서명 요청 전 입력·연결이 변경되어 중단했습니다.' : walletError(error)) : 'Rabby 전파 결과 미확인 — 자동으로 재전송하지 않습니다. 지갑 활동에서 해시를 확인해 아래 이력에 연결하세요.';
  }
  row.updatedAt = new Date().toISOString();
  // Even if the component unmounted or the account changed during signing, retain the returned hash.
  try {
    if (await store.put(row, reserved) === false) {
      // A manual replacement/recovery may have finished before this wallet promise returned.
      const newer = (await store.list()).find(r => r.id === row.id);
      if (newer) return newer;
      row.trackingError = '요청 이력이 변경되어 결과를 저장하지 못했습니다. 표시된 거래 해시를 보관하세요.';
    }
  } catch { row.trackingError = '전송 이력 저장 실패 — 이 화면의 거래 해시를 복사해 보관하세요. 새로고침 후 수동 해시 연결이 필요할 수 있습니다.'; }
  return row;
}
