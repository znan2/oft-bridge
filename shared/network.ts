// Safe defaults: testnet chains and dry-run execution unless a mode is explicitly selected.
// Browser builds receive the network through Vite `define`; Node reads the environment.
export type NetworkMode = 'testnet' | 'mainnet';
export type ExecutionMode = 'dry-run' | 'live';
declare const __OFT_NETWORK__: string | undefined;

export function parseNetworkMode(value: unknown): NetworkMode {
  if (value === undefined || value === null || value === '' || value === 'testnet') return 'testnet';
  if (value === 'mainnet') return 'mainnet';
  throw new Error('OFT_NETWORK는 testnet 또는 mainnet만 허용합니다.');
}
export function parseExecutionMode(value: unknown): ExecutionMode {
  if (value === undefined || value === null || value === '' || value === 'dry-run') return 'dry-run';
  if (value === 'live') return 'live';
  throw new Error('OFT_EXECUTION은 dry-run 또는 live만 허용합니다.');
}
function env(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}
export const NETWORK_MODE: NetworkMode = parseNetworkMode(typeof __OFT_NETWORK__ !== 'undefined' ? __OFT_NETWORK__ : env('OFT_NETWORK'));
