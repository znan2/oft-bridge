import { decodeFunctionData, encodeFunctionResult, type Address } from 'viem';
import { vi } from 'vitest';
import type { Catalog } from '../../shared/discovery';
import { OFT_READ_ABI, type GetterName } from '../../shared/oft-abi';
import { RpcCallError, type DiscoveryIO } from '../../src/lib/discovery';
export const TOKEN = '0x0000000000000000000000000000000000000011';
export const BRIDGE = '0x0000000000000000000000000000000000000022';
export const OTHER = '0x0000000000000000000000000000000000000033';
export const ENDPOINT = '0x0000000000000000000000000000000000000044';
export const catalog = (): Catalog => ({ status: 'fresh', sourceUrl: 'https://metadata.layerzero-api.com/test', fetchedAt: '2026-09-06T00:00:00Z', deployments: [], warnings: [] });
export const erc20 = () => ({ decimals: 18, symbol: 'TEST', name: 'Test Token' });
export const oft = (token = TOKEN) => ({ token, endpoint: ENDPOINT, oftVersion: ['0x02e49c2c', 1n], sharedDecimals: 6, approvalRequired: false, ...erc20() });
export function harness(contracts: Record<string, Record<string, unknown>>) {
  const io: DiscoveryIO = {
    rpc: vi.fn(async (method, params) => {
      if (method === 'eth_blockNumber') return '0x100';
      if (method === 'eth_getCode') return contracts[String(params[0]).toLowerCase()] ? '0x6001' : '0x';
      if (method === 'eth_call') {
        const call = params[0] as { to: Address; data: `0x${string}` };
        const fn = decodeFunctionData({ abi: OFT_READ_ABI, data: call.data }).functionName as GetterName;
        const value = contracts[call.to.toLowerCase()]?.[fn];
        if (value instanceof Error) throw value;
        if (value === undefined) throw new RpcCallError(3, 'execution reverted');
        return encodeFunctionResult({ abi: OFT_READ_ABI, functionName: fn, result: value as never });
      }
      throw new Error(`Unexpected RPC ${method}`);
    }),
    catalog: vi.fn(async () => catalog()),
    store: { list: vi.fn(async () => []), save: vi.fn(async () => {}) },
  };
  return io;
}
