import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, pad, type Address } from 'viem';
import { vi } from 'vitest';
import { OFT_READ_ABI, OFT_QUOTE_ABI, OFT_SEND_ABI } from '../../shared/oft-abi';
import { ROUTE_ABI, ULN_CONFIG_ABI, EXECUTOR_CONFIG_ABI } from '../../shared/route-abi';
import { PROTOCOL } from '../../shared/protocol';
import { chainById, type ChainId } from '../../shared/chains';
import type { ProtocolCatalog, UlnConfig } from '../../shared/route';
import { RpcCallError } from '../../src/lib/discovery';
import type { RouteIO } from '../../src/lib/route';
import { TOKEN, BRIDGE, OTHER, erc20, oft } from './discovery';
export const combinedAbi = [...OFT_READ_ABI, ...ROUTE_ABI, ...OFT_QUOTE_ABI, ...OFT_SEND_ABI];
export const S1 = '0x0000000000000000000000000000000000000050';
export const S2 = '0x0000000000000000000000000000000000000060';
export const D1 = '0x0000000000000000000000000000000000000070';
export const D2 = '0x0000000000000000000000000000000000000080';
export const routeInput = { sourceChain: 56 as const, destinationChain: 1 as const, bridgeAddress: TOKEN, tokenAddress: TOKEN };
export function uln(dvns = [S1, S2]): UlnConfig { return { confirmations: '20', requiredDVNCount: dvns.length, requiredDVNs: dvns, optionalDVNCount: 0, optionalDVNs: [], optionalDVNThreshold: 0 }; }
export function encodeUln(value: UlnConfig) { return encodeAbiParameters(ULN_CONFIG_ABI, [{ ...value, confirmations: BigInt(value.confirmations), requiredDVNs: value.requiredDVNs as Address[], optionalDVNs: value.optionalDVNs as Address[] }]); }
export function routeHarness(pair: [ChainId, ChainId] = [56, 1]) {
  const [src, dst] = pair;
  const configs: Record<ChainId, UlnConfig> = { [src]: uln(), [dst]: uln([D1, D2]) };
  const executors = Object.fromEntries(pair.map(id => [id, { executor: PROTOCOL[id].executors[0] as string, maxMessageSize: 10000 }]));
  const catalog: ProtocolCatalog = { status: 'fresh', fetchedAt: new Date().toISOString(), sourceUrl: 'https://metadata.layerzero-api.com/v1/metadata', chains: pair.map(chainId => ({ chainId, eid: chainById(chainId).eid, ...PROTOCOL[chainId], executors: [...PROTOCOL[chainId].executors], dvns: (chainId === src ? [S1, S2] : [D1, D2]).map((address, i) => ({ address, id: `operator-${i}`, name: `Operator ${i}`, version: 2, deprecated: false, lzReadCompatible: false })) })), warnings: [] };
  type Values = Record<string, unknown | ((args: readonly unknown[]) => unknown)>;
  const contracts: Record<ChainId, Record<string, Values>> = { [src]: {}, [dst]: {} };
  for (const chainId of pair) {
    const protocol = PROTOCOL[chainId];
    contracts[chainId][protocol.endpoint] = { eid: chainById(chainId).eid, getSendLibrary: protocol.sendLibrary, isDefaultSendLibrary: true, getReceiveLibrary: [protocol.receiveLibrary, true], isRegisteredLibrary: true,
      getConfig: (args: readonly unknown[]) => args[3] === 1 ? encodeAbiParameters(EXECUTOR_CONFIG_ABI, [{ ...executors[chainId], executor: executors[chainId].executor as Address }]) : encodeUln(configs[chainId]),
    };
    for (const lib of [protocol.sendLibrary, protocol.receiveLibrary]) contracts[chainId][lib] = { version: [3n, 0, 2], isSupportedEid: true };
    contracts[chainId][protocol.executors[0]] = { dstConfig: [5000n, 12000, 0n, 1000000000000000000n] };
    for (const dvn of (chainId === src ? [S1, S2] : [D1, D2])) contracts[chainId][dvn] = {};
  }
  contracts[src][TOKEN] = { ...oft(), endpoint: PROTOCOL[src].endpoint, peers: pad(BRIDGE), enforcedOptions: '0x0003', paused: false };
  contracts[dst][BRIDGE] = { ...oft(OTHER), endpoint: PROTOCOL[dst].endpoint, approvalRequired: true, peers: pad(TOKEN), enforcedOptions: '0x0003' };
  contracts[dst][OTHER] = { ...erc20(), paused: false, balanceOf: 10n ** 24n };
  const io: RouteIO = {
    rpc: vi.fn(async (chainId: ChainId, method: string, params: unknown[]) => {
      if (method === 'eth_blockNumber') return chainId === src ? '0x100' : '0x200';
      if (method === 'eth_getCode') return contracts[chainId][String(params[0]).toLowerCase()] ? '0x6001' : '0x';
      if (method === 'eth_call') {
        const call = params[0] as { to: string; data: `0x${string}` };
        const decoded = decodeFunctionData({ abi: combinedAbi, data: call.data });
        const getter = contracts[chainId][call.to.toLowerCase()]?.[decoded.functionName];
        const value = typeof getter === 'function' ? getter(decoded.args ?? []) : getter;
        if (value instanceof Error) throw value;
        if (value === undefined) throw new RpcCallError(3, 'execution reverted');
        return encodeFunctionResult({ abi: combinedAbi, functionName: decoded.functionName, result: value as never });
      }
      throw new Error(`Unexpected method ${method}`);
    }), protocol: vi.fn(async () => catalog), store: { list: vi.fn(async () => []), save: vi.fn(async () => {}) },
  };
  return { io, contracts, configs, catalog, executors };
}
