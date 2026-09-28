// An in-memory "chain" for the static demo: the same contract reads the app performs against a real RPC,
// answered with ABI-encoded mock values. Mirrors tests/helpers/{route,transfer}.ts without vitest.
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, getAddress, pad, type Address, type Hex } from 'viem';
import { CHAINS, chainById, type ChainId } from '../../shared/chains';
import { OFT_QUOTE_ABI, OFT_READ_ABI, OFT_SEND_ABI } from '../../shared/oft-abi';
import { PROTOCOL } from '../../shared/protocol';
import { EXECUTOR_CONFIG_ABI, ROUTE_ABI, ULN_CONFIG_ABI } from '../../shared/route-abi';
import type { Catalog } from '../../shared/discovery';
import type { ProtocolCatalog } from '../../shared/route';
import { OP_FEE_ABI, OP_ORACLE } from '../lib/network-execution';
import { combinedOptions, receiveOption } from '../lib/transfer-options';
import { DEMO_ACCOUNT, DEMO_TOKEN } from './constants';

const ABI = [...OFT_READ_ABI, ...ROUTE_ABI, ...OFT_QUOTE_ABI, ...OFT_SEND_ABI, ...OP_FEE_ABI];
type Getter = unknown | ((args: readonly unknown[]) => unknown);
export class DemoRpcError extends Error { constructor(public code: number, message: string) { super(message); } }

const token = DEMO_TOKEN.toLowerCase(), account = DEMO_ACCOUNT.toLowerCase();
const dvns = (chainId: ChainId) => [1, 2].map(i => `0x${'d'.repeat(4)}${chainId.toString(16).padStart(8, '0')}${'0'.repeat(27)}${i}`.toLowerCase());
const blockOf = (chainId: ChainId) => 0x6a0000 + (chainId % 0x1000);
const RATE = 10n ** 12n; // 18 local decimals, 6 shared decimals
const enforced = receiveOption('100000');

function contracts(chainId: ChainId): Record<string, Record<string, Getter>> {
  const p = PROTOCOL[chainId], eid = chainById(chainId).eid;
  const uln = (list: string[]) => encodeAbiParameters(ULN_CONFIG_ABI, [{ confirmations: 20n, requiredDVNCount: list.length, optionalDVNCount: 0, optionalDVNThreshold: 0, requiredDVNs: list as Address[], optionalDVNs: [] }]);
  const quote = (args: readonly unknown[]) => {
    const sent = (args[0] as { amountLD: bigint }).amountLD / RATE * RATE;
    return [{ minAmountLD: 0n, maxAmountLD: (1n << 256n) - 1n }, [], { amountSentLD: sent, amountReceivedLD: sent }];
  };
  const world: Record<string, Record<string, Getter>> = {
    [p.endpoint]: { eid, getSendLibrary: p.sendLibrary, isDefaultSendLibrary: true, getReceiveLibrary: [p.receiveLibrary, true], isRegisteredLibrary: true,
      getConfig: (args: readonly unknown[]) => args[3] === 1 ? encodeAbiParameters(EXECUTOR_CONFIG_ABI, [{ maxMessageSize: 10000, executor: p.executors[0] as Address }]) : uln(dvns(chainId)) },
    [p.sendLibrary]: { version: [3n, 0, 2], isSupportedEid: true },
    [p.receiveLibrary]: { version: [3n, 0, 2], isSupportedEid: true },
    [p.executors[0]]: { dstConfig: [5000n, 12000, 0n, 10n ** 18n] },
    [token]: {
      token: DEMO_TOKEN, endpoint: p.endpoint, oftVersion: ['0x02e49c2c', 1n], sharedDecimals: 6, approvalRequired: false,
      decimals: 18, symbol: 'DEMO', name: 'Demo OFT', paused: false, peers: pad(DEMO_TOKEN as Hex), enforcedOptions: enforced,
      decimalConversionRate: RATE, combineOptions: (args: readonly unknown[]) => combinedOptions(enforced, String(args[2])),
      quoteOFT: quote, quoteSend: () => ({ nativeFee: 180_000_000_000_000n, lzTokenFee: 0n }),
      send: (args: readonly unknown[]) => [{ guid: pad('0x01'), nonce: 1n, fee: args[1] }, quote(args)[2]],
      balanceOf: (args: readonly unknown[]) => String(args[0]).toLowerCase() === account ? 1_250n * 10n ** 18n : 10n ** 24n,
      allowance: 0n,
    },
  };
  for (const dvn of dvns(chainId)) world[dvn] = {};
  if (chainById(chainId).feeModel === 'op-stack') world[OP_ORACLE.toLowerCase()] = { getL1FeeUpperBound: 21_000_000_000n, getOperatorFee: 0n };
  return world;
}
const worlds = new Map(CHAINS.map(c => [c.id, contracts(c.id)]));
const hex = (n: bigint | number) => `0x${n.toString(16)}`;

export function demoRpc(chainId: ChainId, method: string, params: unknown[]): unknown {
  const world = worlds.get(chainId);
  if (!world) throw new DemoRpcError(-32000, 'unknown chain');
  const block = blockOf(chainId);
  switch (method) {
    case 'eth_chainId': return hex(chainId);
    case 'eth_blockNumber': return hex(block);
    case 'eth_gasPrice': return hex(1_500_000_000n);
    case 'eth_maxPriorityFeePerGas': return hex(1_000_000n);
    case 'eth_estimateGas': return hex(210_000n);
    case 'eth_getTransactionCount': return '0x7';
    case 'eth_getBalance': return String(params[0]).toLowerCase() === account ? hex(5n * 10n ** 17n) : '0x0';
    case 'eth_getCode': return world[String(params[0]).toLowerCase()] ? '0x6001' : '0x';
    case 'eth_getBlockByNumber': {
      const number = params[0] === 'finalized' || params[0] === 'latest' ? hex(block - 64) : String(params[0]);
      return { number, hash: pad(hex(BigInt(number) + BigInt(chainId)) as Hex) };
    }
    case 'eth_call': {
      const call = params[0] as { to: string; data: Hex };
      let decoded;
      try { decoded = decodeFunctionData({ abi: ABI, data: call.data }); } catch { throw new DemoRpcError(3, 'execution reverted'); }
      const getter = world[call.to.toLowerCase()]?.[decoded.functionName];
      const value = typeof getter === 'function' ? getter(decoded.args ?? []) : getter;
      if (value === undefined) throw new DemoRpcError(3, 'execution reverted');
      return encodeFunctionResult({ abi: ABI, functionName: decoded.functionName, result: value as never });
    }
    default: throw new DemoRpcError(-32601, `demo: ${method} not available`);
  }
}

export function demoCatalog(): Catalog {
  return { status: 'fresh', sourceUrl: 'demo://ofts', fetchedAt: new Date().toISOString(), warnings: [],
    deployments: CHAINS.map(c => ({ chainId: c.id, address: getAddress(DEMO_TOKEN), tokenAddress: null, symbol: 'DEMO', name: 'Demo OFT', declaredType: 'OFT', endpointVersion: 'v2' })) };
}
export function demoProtocol(): ProtocolCatalog {
  return { status: 'fresh', fetchedAt: new Date().toISOString(), sourceUrl: 'demo://protocol', warnings: [],
    chains: CHAINS.map(c => ({ chainId: c.id, eid: c.eid, ...PROTOCOL[c.id], executors: [...PROTOCOL[c.id].executors],
      dvns: dvns(c.id).map((address, i) => ({ address, id: `demo-dvn-${i + 1}`, name: `Demo DVN ${i + 1}`, version: 2, deprecated: false, lzReadCompatible: false })) })) };
}
