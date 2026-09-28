import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeErrorResult, pad, type Hex } from 'viem';
import { OFT_ERROR_ABI, OFT_QUOTE_ABI, OFT_SEND_ABI } from '../shared/oft-abi';
import historical from './fixtures/dos-bsc-ethereum.json';
import type { SendParam } from '../shared/transfer';
import { prepareTransfer, encodeSend, transferIssue } from '../src/lib/transfer';
import { RpcCallError } from '../src/lib/discovery';
import { TransferError } from '../src/lib/transfer-math';
import { receiveOption } from '../src/lib/transfer-options';
import { transferHarness, transferInput, RECIPIENT, SENDER, REFUND } from './helpers/transfer';
import { TOKEN, BRIDGE, OTHER } from './helpers/discovery';
describe('OFT plan and source simulation', () => {
  it('reproduces the historical calldata without treating the old fee as a quote', () => {
    expect(encodeSend(historical.decodedSend.sendParam as SendParam, historical.decodedSend.fee, historical.decodedSend.refundAddress)).toBe(historical.transaction.input);
  });
  it('uses fresh fees, exact dust, actual sender/value, and fixed blocks; never broadcasts', async () => {
    const h = transferHarness(); const p = await prepareTransfer(transferInput, h.io);
    expect(p.simulation.status).toBe('passed'); expect(p.blockers).toEqual([]); expect(p.executionReady).toBe(false);
    expect(p.sendParam.to).toBe(pad(RECIPIENT)); expect(p.refundAddress).toBe(REFUND);
    expect(p.amounts.sentLD).toBe('1123456000000000000'); expect(p.amounts.dustLD).toBe('789000000000');
    expect(p.sendParam.minAmountLD).toBe(p.amounts.receivedLD); expect(p.fee.nativeFee).toBe('1000000000000000');
    expect(p.gas!.totalNativeBudgetWei).toBe('1240000000000000');
    const calls = vi.mocked(h.io.rpc).mock.calls;
    const send = calls.find(([, method, params]) => method === 'eth_call' && (params[0] as { data: string }).data.startsWith('0xc7c7f5b3'))!;
    expect(send[2]).toEqual([{ from: SENDER, to: TOKEN, data: p.transaction.data, value: '0x38d7ea4c68000' }, '0x100']);
    expect(calls.find(([, method]) => method === 'eth_estimateGas')![2]).toEqual(send[2]);
    expect(calls.every(([, method]) => !/send|sign|wallet|approve/i.test(method))).toBe(true);
    const decoded = decodeFunctionData({ abi: OFT_SEND_ABI, data: p.transaction.data });
    expect(decoded.args?.[1]).toEqual({ nativeFee: h.values.nativeFee, lzTokenFee: 0n });
    expect(JSON.stringify(p)).not.toContain('"guid"');
    h.values.nativeFee *= 2n;
    const next = await prepareTransfer(transferInput, h.io);
    expect(next.fee.nativeFee).not.toBe(p.fee.nativeFee); expect(next.transaction.data).not.toBe(p.transaction.data);
  });
  it('uses destination LD for liquidity and ceil conversion for minimum', async () => {
    const h = transferHarness(); h.contracts[1][OTHER].decimals = 8;
    h.contracts[1][OTHER].balanceOf = 112345600n;
    const p = await prepareTransfer({ ...transferInput, slippagePercent: '0.01' }, h.io);
    expect(p.amounts.destinationLD).toBe('112345600'); expect(p.sendParam.minAmountLD).toBe('1123343654400000000');
    expect(p.amounts.destinationMinimumLD).toBe('112334400'); expect(p.blockers).toEqual([]);
    h.contracts[1][OTHER].balanceOf = 112345599n;
    const blocked = await prepareTransfer(transferInput, h.io);
    expect(blocked.blockers.map(b => b.code)).toContain('DESTINATION_BALANCE'); expect(blocked.simulation.status).toBe('blocked');
  });
  it('quotes an adapter before approval but never fakes allowance to simulate', async () => {
    const h = transferHarness();
    const input = { ...transferInput, route: { sourceChain: 1 as const, destinationChain: 56 as const, bridgeAddress: BRIDGE, tokenAddress: OTHER }, walletChainId: 1 };
    const p = await prepareTransfer(input, h.io);
    expect(p.approval.needed).toBe(true); expect(p.approval.amountLD).toBe(p.amounts.sentLD); expect(p.simulation.status).toBe('blocked');
    expect(decodeFunctionData({ abi: OFT_QUOTE_ABI, data: p.approval.data as Hex }).args).toEqual([BRIDGE, BigInt(p.amounts.sentLD)]);
    expect(vi.mocked(h.io.rpc).mock.calls.some(([, m, a]) => m === 'eth_call' && String((a[0] as { data: string }).data).startsWith('0xc7c7f5b3'))).toBe(false);
    h.values.allowance = BigInt(p.amounts.sentLD);
    expect((await prepareTransfer(input, h.io)).simulation.status).toBe('passed');
  });
  it('distinguishes token, native and source gas balance shortages', async () => {
    const h = transferHarness(); h.values.tokenBalance = 1n; h.values.nativeBalance = 0n;
    const p = await prepareTransfer(transferInput, h.io);
    expect(p.blockers.map(b => b.code)).toEqual(['TOKEN_BALANCE', 'NATIVE_BALANCE']);
    h.values.tokenBalance = 10n ** 20n; h.values.nativeBalance = h.values.nativeFee;
    const gas = await prepareTransfer(transferInput, h.io);
    expect(gas.simulation.status).toBe('passed'); expect(gas.blockers.map(b => b.code)).toEqual(['GAS_BALANCE']);
  });
  it('requires gas instead of guessing and verifies combineOptions on chain', async () => {
    const h = transferHarness(); h.contracts[56][TOKEN].enforcedOptions = '0x';
    await expect(prepareTransfer(transferInput, h.io)).rejects.toMatchObject({ code: 'OPTIONS_REQUIRED' });
    const p = await prepareTransfer({ ...transferInput, extraReceiveGas: '100000' }, h.io);
    expect(p.options.receiveGas).toBe('100000'); expect(p.sendParam.extraOptions).toBe(receiveOption('100000'));
    h.contracts[56][TOKEN].combineOptions = '0x';
    await expect(prepareTransfer({ ...transferInput, extraReceiveGas: '100000' }, h.io)).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTIONS' });
  });
  it('rejects zero, sub-shared dust, overflowing amounts and inconsistent conversion', async () => {
    const h = transferHarness();
    for (const amount of ['0', '0.0000001', '18446744073709.551616']) await expect(prepareTransfer({ ...transferInput, amount }, h.io)).rejects.toBeInstanceOf(TransferError);
    h.contracts[56][TOKEN].decimalConversionRate = 1n;
    await expect(prepareTransfer(transferInput, h.io)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
  it('checks quote limits and rejects unsupported fee payment', async () => {
    const h = transferHarness();
    h.contracts[56][TOKEN].quoteOFT = [{ minAmountLD: 0n, maxAmountLD: 1n }, [], { amountSentLD: 1n, amountReceivedLD: 1n }];
    await expect(prepareTransfer(transferInput, h.io)).rejects.toMatchObject({ code: 'AMOUNT_LIMIT' });
    const h2 = transferHarness(); h2.contracts[56][TOKEN].quoteSend = { nativeFee: 1n, lzTokenFee: 1n };
    await expect(prepareTransfer(transferInput, h2.io)).rejects.toMatchObject({ code: 'UNSUPPORTED_FEE' });
  });
  it('rejects quotes that change when the final minimum is applied', async () => {
    const h = transferHarness();
    h.contracts[56][TOKEN].quoteOFT = (args: readonly unknown[]) => {
      const param = args[0] as { minAmountLD: bigint };
      return [{ minAmountLD: 0n, maxAmountLD: 10n ** 30n }, [], { amountSentLD: 10n ** 18n, amountReceivedLD: param.minAmountLD === 0n ? 10n ** 18n : 9n * 10n ** 17n }];
    };
    await expect(prepareTransfer(transferInput, h.io)).rejects.toMatchObject({ code: 'UNSTABLE_QUOTE' });
  });
  it('preserves custom token fee receipts and computes the minimum from received amount', async () => {
    const h = transferHarness(); h.values.receivedDelta = -100000000000000000n;
    const p = await prepareTransfer(transferInput, h.io);
    expect(p.sendParam.minAmountLD).toBe('1023456000000000000');
    expect(p.approval.amountLD).toBe('1123456000000000000');
    expect(p.simulation.status).toBe('passed');
  });
  it('keeps RPC errors during fresh route validation explicit', async () => {
    const h = transferHarness(); h.io.rpc = async () => { throw new Error('node timeout'); };
    await expect(prepareTransfer(transferInput, h.io)).rejects.toMatchObject({ code: 'RPC_ERROR' });
  });
  it('marks a slow quote expired before returning it', async () => {
    const h = transferHarness(), original = h.io.rpc;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100000);
    try {
      h.io.rpc = async (c, m, p) => { if (m === 'eth_estimateGas') clock.mockReturnValue(160001); return original(c, m, p); };
      const plan = await prepareTransfer(transferInput, h.io);
      expect(plan.blockers.map(b => b.code)).toContain('QUOTE_EXPIRED');
    } finally { clock.mockRestore(); }
  });
  it('detects source simulation/quote mismatch and preserves custom revert data', async () => {
    const h = transferHarness();
    h.contracts[56][TOKEN].send = [{ guid: pad('0x01'), nonce: 1n, fee: { nativeFee: 1n, lzTokenFee: 0n } }, { amountSentLD: 1n, amountReceivedLD: 1n }];
    expect((await prepareTransfer(transferInput, h.io)).simulation.issue?.code).toBe('SIMULATION_MISMATCH');
    const data = encodeErrorResult({ abi: OFT_ERROR_ABI, errorName: 'SlippageExceeded', args: [1n, 2n] });
    h.contracts[56][TOKEN].send = new RpcCallError(3, 'execution reverted', data);
    const p = await prepareTransfer(transferInput, h.io);
    expect(p.simulation.issue).toMatchObject({ code: 'CONTRACT_REVERT', data }); expect(p.simulation.detail).toContain('SlippageExceeded(1, 2)');
    expect(transferIssue(new RpcCallError(-32000, 'upstream timeout')).code).toBe('RPC_ERROR');
    expect(transferIssue(new RpcCallError(-32000, 'insufficient funds for gas * price + value')).code).toBe('NATIVE_BALANCE');
    expect(transferIssue(new RpcCallError(3, 'execution reverted', '0x12345678')).message).toContain('미해석 오류');
  });
  it('keeps gas RPC failure distinct from successful source eth_call', async () => {
    const h = transferHarness(), original = h.io.rpc;
    h.io.rpc = async (c, m, p) => { if (m === 'eth_estimateGas') throw new Error('public RPC unavailable'); return original(c, m, p); };
    const p = await prepareTransfer(transferInput, h.io);
    expect(p.simulation.status).toBe('passed'); expect(p.gas).toBeUndefined(); expect(p.blockers[0].code).toBe('RPC_ERROR');
  });
  it('revalidates changed route settings and observes abort without a plan', async () => {
    const h = transferHarness(); h.contracts[1][BRIDGE].peers = pad(OTHER);
    await expect(prepareTransfer(transferInput, h.io)).rejects.toMatchObject({ code: 'ROUTE_UNVERIFIED' });
    const controller = new AbortController(); controller.abort();
    await expect(prepareTransfer(transferInput, h.io, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(prepareTransfer({ ...transferInput, walletChainId: 1 }, h.io)).rejects.toMatchObject({ code: 'WALLET_CONTEXT' });
  });
});
