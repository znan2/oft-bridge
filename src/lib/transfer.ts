import { decodeErrorResult, decodeFunctionResult, encodeFunctionData, isAddress, keccak256, pad, stringToHex, toHex, zeroAddress, type Address, type ContractFunctionReturnType, type Hex } from 'viem';
import { chainById } from '../../shared/chains';
import { OFT_ERROR_ABI, OFT_QUOTE_ABI, OFT_SEND_ABI } from '../../shared/oft-abi';
import type { SendParam, TransferInput, TransferIssue, TransferPlan } from '../../shared/transfer';
import { RpcCallError } from './discovery';
import { validateRoute, type RouteIO } from './route';
import { conversionRate, decimalAmount, destinationAmount, fail, slippageBps, TransferError } from './transfer-math';
import { assertSourceSupported, estimateNetworkGas } from './network-execution';
import { combinedOptions, inspectOptions, receiveOption } from './transfer-options';

export const QUOTE_TTL_MS = 60_000;
export function transferIssue(error: unknown): TransferIssue {
  if (error instanceof TransferError) return { code: error.code, message: error.message, data: error.data };
  if (error instanceof RpcCallError && /insufficient funds|insufficient balance for transfer/i.test(error.message) && error.code !== 3 && !/revert/i.test(error.message)) {
    return { code: 'NATIVE_BALANCE', message: `네이티브 잔액 부족 — ${error.message}`, data: error.data };
  }
  if (error instanceof RpcCallError && (error.code === 3 || /revert/i.test(error.message))) {
    let reason = error.message;
    if (error.data && /^0x(?:[0-9a-f]{2})+$/i.test(error.data)) {
      try { const decoded = decodeErrorResult({ abi: OFT_ERROR_ABI, data: error.data as Hex }); reason = `${decoded.errorName}(${(decoded.args ?? []).map(String).join(', ')})`; }
      catch { reason = `${error.message} · 미해석 오류 ${error.data.slice(0, 10)}`; }
    }
    return { code: 'CONTRACT_REVERT', message: `컨트랙트 실행 실패 — ${reason}`, data: error.data };
  }
  return { code: 'RPC_ERROR', message: `RPC 오류 — ${error instanceof Error ? error.message : '응답 미확인'}` };
}
export function bigintParam(param: SendParam) { return { ...param, amountLD: BigInt(param.amountLD), minAmountLD: BigInt(param.minAmountLD) }; }
export function encodeSend(param: SendParam, fee: { nativeFee: string; lzTokenFee: string }, refund: string) {
  return encodeFunctionData({ abi: OFT_SEND_ABI, functionName: 'send', args: [bigintParam(param), { nativeFee: BigInt(fee.nativeFee), lzTokenFee: BigInt(fee.lzTokenFee) }, refund as Address] });
}
function uint(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) fail('RPC 수량 응답 형식이 잘못되었습니다.', 'RPC_ERROR');
  return BigInt(value);
}
type QuoteName = (typeof OFT_QUOTE_ABI)[number]['name'];

// Every request is read-only, with the real sender and no state overrides.
// A fresh route is obtained here; a previously displayed M3 report is never authority for a plan.
export async function prepareTransfer(input: TransferInput, io: RouteIO, signal?: AbortSignal): Promise<TransferPlan> {
  signal?.throwIfAborted();
  assertSourceSupported(input.route.sourceChain);
  for (const [label, value] of [['보내는 주소', input.sender], ['받는 주소', input.recipient], ['환불 주소', input.refundAddress]]) {
    if (!isAddress(value) || value.toLowerCase() === zeroAddress) fail(`${label}가 올바른 0x EVM 주소인지 확인하세요.`);
  }
  if (input.walletChainId !== input.route.sourceChain || !input.providerUid) fail('Rabby를 연결하고 지갑 네트워크를 출발 네트워크로 맞춰주세요.', 'WALLET_CONTEXT');
  const startedAt = Date.now();
  const bps = slippageBps(input.slippagePercent);
  const extra = receiveOption(input.extraReceiveGas);
  const route = await validateRoute(input.route, io, signal);
  signal?.throwIfAborted();
  if (route.configurationStatus !== 'PASS') {
    const issues = route.checks.filter(c => c.scope === 'configuration' && (c.status === 'FAIL' || c.status === 'UNKNOWN'));
    fail(`경로 재검증을 완료하지 못했습니다. ${issues.map(c => `${c.title}: ${c.detail}`).join(' / ')}`, issues.some(c => /RPC 오류/.test(c.detail)) ? 'RPC_ERROR' : 'ROUTE_UNVERIFIED');
  }
  const source = route.source!, destination = route.destination!;
  const src = source.identity!, dst = destination.identity!;
  const sourceDecimals = src.token.decimals, destinationDecimals = dst.token.decimals;
  if (sourceDecimals === null || destinationDecimals === null) fail('토큰 decimals를 확인하지 못했습니다.', 'UNSUPPORTED');
  const rate = conversionRate(sourceDecimals, src.sharedDecimals), destinationRate = conversionRate(destinationDecimals, dst.sharedDecimals);
  const amount = decimalAmount(input.amount, sourceDecimals);
  if (amount === 0n) fail('전송 수량은 0보다 커야 합니다. 0개 테스트는 필수 과정이 아닙니다.');
  const dust = amount % rate;
  if (amount - dust === 0n) fail(`수량이 최소 공유 단위보다 작습니다. 소수점 ${src.sharedDecimals}자리까지 전송할 수 있습니다.`);
  destinationAmount(amount - dust, rate, destinationRate);
  const rpc = async (method: string, params: unknown[]) => {
    signal?.throwIfAborted();
    const result = await io.rpc(input.route.sourceChain, method, params);
    signal?.throwIfAborted(); return result;
  };
  async function read<N extends QuoteName>(target: string, name: N, args: unknown[] = []) {
    const raw = await rpc('eth_call', [{ from: input.sender, to: target, data: encodeFunctionData({ abi: OFT_QUOTE_ABI, functionName: name as QuoteName, args: args as never }) }, source.blockNumber]);
    try { return decodeFunctionResult({ abi: OFT_QUOTE_ABI, functionName: name as QuoteName, data: raw as Hex }) as ContractFunctionReturnType<typeof OFT_QUOTE_ABI, 'view' | 'nonpayable', N>; }
    catch { return fail(`${name} 응답을 지원 ABI로 해석하지 못했습니다.`, 'UNSUPPORTED'); }
  }
  const combined = combinedOptions(route.enforcedOptions ?? '0x', extra);
  const options = inspectOptions(combined);
  if (options.gas === 0n) fail('강제 수신 gas가 없습니다. 고급 설정에서 확인된 추가 수신 gas를 입력하세요.', 'OPTIONS_REQUIRED');
  const [onchainRate, onchainOptions] = await Promise.all([
    read(src.bridgeAddress, 'decimalConversionRate'),
    read(src.bridgeAddress, 'combineOptions', [chainById(input.route.destinationChain).eid, 1, extra]),
  ]);
  if (onchainRate !== rate) fail('컨트랙트의 decimalConversionRate가 decimals 계산과 다릅니다.', 'UNSUPPORTED');
  if (onchainOptions.toLowerCase() !== combined.toLowerCase()) fail('컨트랙트의 combineOptions 결과가 표준 Type 3 조합과 다릅니다.', 'UNSUPPORTED_OPTIONS');
  const sendParam: SendParam = { dstEid: chainById(input.route.destinationChain).eid, to: pad(input.recipient as Address), amountLD: amount.toString(), minAmountLD: '0', extraOptions: extra, composeMsg: '0x', oftCmd: '0x' };
  const initial = await read(src.bridgeAddress, 'quoteOFT', [bigintParam(sendParam)]);
  const minimum = initial[2].amountReceivedLD * (10000n - bps) / 10000n;
  sendParam.minAmountLD = minimum.toString();
  const [limit, tokenFees, receipt] = await read(src.bridgeAddress, 'quoteOFT', [bigintParam(sendParam)]);
  if (receipt.amountSentLD !== initial[2].amountSentLD || receipt.amountReceivedLD !== initial[2].amountReceivedLD) fail('최소 수령량 적용 후 견적이 달라졌습니다. 해당 구현을 추가 확인해야 합니다.', 'UNSTABLE_QUOTE');
  if (amount < limit.minAmountLD || amount > limit.maxAmountLD) fail(`수량이 quoteOFT 한도 밖입니다. LD 범위: ${limit.minAmountLD}~${limit.maxAmountLD}`, 'AMOUNT_LIMIT');
  if (receipt.amountSentLD <= 0n || receipt.amountSentLD > amount || receipt.amountReceivedLD <= 0n || receipt.amountReceivedLD < minimum) fail('견적의 차감량·수령량이 지원 범위와 맞지 않습니다.', 'UNSUPPORTED_QUOTE');
  const destinationLD = destinationAmount(receipt.amountReceivedLD, rate, destinationRate);
  // The wire amount is discrete; ceil the source minimum to express its destination equivalent.
  const destinationMinimumLD = ((minimum + rate - 1n) / rate) * destinationRate;
  const quotedFee = await read(src.bridgeAddress, 'quoteSend', [bigintParam(sendParam), false]);
  if (quotedFee.lzTokenFee !== 0n) fail('네이티브 수수료 견적에 lzTokenFee가 포함되었습니다.', 'UNSUPPORTED_FEE');
  const fee = { nativeFee: quotedFee.nativeFee.toString(), lzTokenFee: '0' as const };
  const data = encodeSend(sendParam, fee, input.refundAddress);
  const [balance, native, allowance] = await Promise.all([
    read(src.token.address, 'balanceOf', [input.sender]),
    rpc('eth_getBalance', [input.sender, source.blockNumber]).then(uint),
    src.approvalRequired ? read(src.token.address, 'allowance', [input.sender, src.bridgeAddress]) : Promise.resolve(undefined),
  ]);
  const approvalNeeded = allowance !== undefined && allowance < receipt.amountSentLD;
  const blockers: TransferIssue[] = route.checks.filter(c => c.scope === 'execution' && c.status === 'FAIL' && c.id !== 'liquidity').map(c => ({ code: 'ROUTE_FAILED', message: `${c.title}: ${c.detail}` }));
  if (balance < receipt.amountSentLD) blockers.push({ code: 'TOKEN_BALANCE', message: '출발 토큰 잔액이 실제 차감 예정량보다 부족합니다.' });
  if (native < quotedFee.nativeFee) blockers.push({ code: 'NATIVE_BALANCE', message: '네이티브 잔액이 브릿지 수수료보다 부족합니다. 출발 가스비도 별도로 필요합니다.' });
  if (approvalNeeded) blockers.push({ code: 'APPROVAL_REQUIRED', message: '토큰 승인이 필요합니다. 정확한 필요 승인량을 계산했으며, 승인 후 send를 다시 시뮬레이션해야 합니다.' });
  if (dst.kind === 'OFTAdapter') {
    if (route.destinationBalanceLD === undefined) blockers.push({ code: 'DESTINATION_BALANCE_UNKNOWN', message: '목적지 어댑터 잔액을 확인하지 못했습니다. 경로의 RPC 오류 또는 조회 결과를 확인하세요.' });
    else if (BigInt(route.destinationBalanceLD) < destinationLD) blockers.push({ code: 'DESTINATION_BALANCE', message: '목적지 어댑터 잔액이 예상 수령량보다 부족합니다.' });
  }
  const warnings = [...route.warnings, ...route.checks.filter(c => c.scope === 'execution' && c.status === 'UNKNOWN' && c.id !== 'liquidity').map(c => `${c.title}: ${c.detail}`),
    '출발 eth_call 성공은 목적지 실행·최종 수령 성공을 보장하지 않습니다.',
    '견적과 시뮬레이션은 표시된 관찰 블록 기준입니다. 서명 직전 재검증이 필요합니다.',
    '수신 gas는 강제 옵션과 추가 옵션의 합입니다. 목적지 실행에 충분한지는 실제 구현에 따라 달라집니다.'];
  if (minimum === 0n) warnings.push('최소 수령량이 0입니다. 수령량 감소에 대한 보호가 없습니다.');
  const plan: TransferPlan = {
    input, fingerprint: '', createdAt: new Date(startedAt).toISOString(), expiresAt: new Date(startedAt + QUOTE_TTL_MS).toISOString(), route, executionReady: false,
    amounts: { requestedLD: amount.toString(), sentLD: receipt.amountSentLD.toString(), receivedLD: receipt.amountReceivedLD.toString(), dustLD: dust.toString(), sourceRemainderLD: (amount - receipt.amountSentLD).toString(), destinationLD: destinationLD.toString(), destinationMinimumLD: destinationMinimumLD.toString(), sourceDecimals, destinationDecimals, sharedDecimals: src.sharedDecimals, slippageBps: bps.toString() },
    options: { enforced: route.enforcedOptions ?? '0x', extra, combined, receiveGas: options.gas.toString(), ordered: options.ordered },
    limits: { minAmountLD: limit.minAmountLD.toString(), maxAmountLD: limit.maxAmountLD.toString() },
    tokenFees: tokenFees.map(f => ({ feeAmountLD: f.feeAmountLD.toString(), description: f.description.slice(0, 500) })),
    sendParam, fee, refundAddress: input.refundAddress,
    transaction: { chainId: input.route.sourceChain, from: input.sender, to: src.bridgeAddress, data, value: fee.nativeFee },
    balances: { tokenLD: balance.toString(), nativeWei: native.toString(), destinationLD: route.destinationBalanceLD },
    approval: { required: src.approvalRequired, allowanceLD: allowance?.toString(), amountLD: receipt.amountSentLD.toString(), needed: approvalNeeded, token: src.token.address, spender: src.bridgeAddress, ...(approvalNeeded ? { data: encodeFunctionData({ abi: OFT_QUOTE_ABI, functionName: 'approve', args: [src.bridgeAddress as Address, receipt.amountSentLD] }) } : {}) },
    blockers, warnings, simulation: { status: 'blocked', detail: '전송 조건을 먼저 해결해야 하므로 send 시뮬레이션을 실행하지 않았습니다.' },
  };
  if (blockers.length === 0) {
    const call = { from: input.sender, to: src.bridgeAddress, data, value: toHex(quotedFee.nativeFee) };
    try {
      const raw = await rpc('eth_call', [call, source.blockNumber]);
      let simulated;
      try { simulated = decodeFunctionResult({ abi: OFT_SEND_ABI, functionName: 'send', data: raw as Hex }); }
      catch { fail('send 응답을 표준 OFT 영수증으로 해석하지 못했습니다.', 'UNSUPPORTED'); }
      if (simulated[1].amountSentLD !== receipt.amountSentLD || simulated[1].amountReceivedLD !== receipt.amountReceivedLD || simulated[0].fee.nativeFee !== quotedFee.nativeFee || simulated[0].fee.lzTokenFee !== 0n) fail('send 시뮬레이션 결과가 견적과 다릅니다.', 'SIMULATION_MISMATCH');
      // Simulated GUID/nonce are intentionally discarded: no transaction was submitted.
      plan.simulation = { status: 'passed', detail: '출발 eth_call 성공 · 실제 전송은 실행하지 않았습니다.' };
      try {
        plan.gas = await estimateNetworkGas(input.route.sourceChain, call, io, source.blockNumber);
        if (native < BigInt(plan.gas.totalNativeBudgetWei)) blockers.push({ code: 'GAS_BALANCE', message: '출발 가스비와 추가 수수료 예산(20% 여유 포함)까지 합하면 네이티브 잔액이 부족합니다.' });
      } catch (error) { signal?.throwIfAborted(); const issue = transferIssue(error); blockers.push({ ...issue, message: `출발 가스 추정 미완료 — ${issue.message}` }); }
    } catch (error) { signal?.throwIfAborted(); const issue = transferIssue(error); plan.simulation = { status: 'failed', detail: issue.message, issue }; blockers.push(issue); }
  }
  signal?.throwIfAborted();
  if (Date.now() >= startedAt + QUOTE_TTL_MS) blockers.push({ code: 'QUOTE_EXPIRED', message: '조회 중 견적 유효 시간이 지났습니다. 다시 계산하세요.' });
  plan.fingerprint = keccak256(stringToHex(JSON.stringify(plan)));
  return plan;
}
