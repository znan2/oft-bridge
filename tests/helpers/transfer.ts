import { pad } from 'viem';
import { vi } from 'vitest';
import type { TransferInput } from '../../shared/transfer';
import { combinedOptions, receiveOption } from '../../src/lib/transfer-options';
import { routeHarness, routeInput } from './route';
import { TOKEN, BRIDGE, OTHER } from './discovery';
export const SENDER = '0x0000000000000000000000000000000000000091';
export const RECIPIENT = '0x0000000000000000000000000000000000000092';
export const REFUND = '0x0000000000000000000000000000000000000093';
export const transferInput: TransferInput = { route: routeInput, sender: SENDER, recipient: RECIPIENT, refundAddress: REFUND, amount: '1.123456789', slippagePercent: '0', extraReceiveGas: '0', walletChainId: 56, providerUid: 'mock-rabby', rpcRevision: 2 };
export function transferHarness(pair: [number, number] = [56, 1]) {
  const h = routeHarness(pair);
  const values = { nativeFee: 1000000000000000n, tokenBalance: 10n ** 20n, nativeBalance: 10n ** 18n, allowance: 0n, gas: 200000n, gasPrice: 10n ** 9n, receivedDelta: 0n };
  for (const [chain, address, token] of [[pair[0], TOKEN, TOKEN], [pair[1], BRIDGE, OTHER]] as const) {
    const bridge = h.contracts[chain][address];
    bridge.enforcedOptions = receiveOption('100000');
    bridge.decimalConversionRate = 10n ** 12n;
    bridge.combineOptions = (args: readonly unknown[]) => combinedOptions(String(bridge.enforcedOptions), String(args[2]));
    bridge.quoteOFT = (args: readonly unknown[]) => {
      const p = args[0] as { amountLD: bigint };
      const sent = p.amountLD / BigInt(String(bridge.decimalConversionRate)) * BigInt(String(bridge.decimalConversionRate));
      return [{ minAmountLD: 0n, maxAmountLD: (1n << 256n) - 1n }, [], { amountSentLD: sent, amountReceivedLD: sent + values.receivedDelta }];
    };
    bridge.quoteSend = () => ({ nativeFee: values.nativeFee, lzTokenFee: 0n });
    bridge.send = (args: readonly unknown[]) => {
      const quote = (bridge.quoteOFT as (a: readonly unknown[]) => unknown[])(args);
      return [{ guid: pad('0x12'), nonce: 1n, fee: args[1] }, quote[2]];
    };
    const original = h.contracts[chain][token].balanceOf;
    h.contracts[chain][token].balanceOf = (args: readonly unknown[]) => String(args[0]).toLowerCase() === SENDER ? values.tokenBalance : original ?? 10n ** 24n;
    h.contracts[chain][token].allowance = () => values.allowance;
  }
  const originalRpc = h.io.rpc;
  h.io.rpc = vi.fn(async (chain, method, params) => {
    if (method === 'eth_getTransactionCount') return '0x4';
    if (method === 'eth_getBlockByNumber') return { number: '0x10', hash: pad('0x11') };
    if (method === 'eth_getBalance') return `0x${values.nativeBalance.toString(16)}`;
    if (method === 'eth_estimateGas') return `0x${values.gas.toString(16)}`;
    if (method === 'eth_gasPrice') return `0x${values.gasPrice.toString(16)}`;
    return originalRpc(chain, method, params);
  });
  return { ...h, values };
}
