import { createConfig, http, type Connector } from 'wagmi';
import { defineChain, type Chain } from 'viem';
import { CHAINS } from '../../shared/chains';

export function createWalletConfig() {
  return createConfig({
    chains: CHAINS.map(c => defineChain({ id: c.id, name: c.name, nativeCurrency: { name: c.symbol, symbol: c.symbol, decimals: c.decimals }, rpcUrls: { default: { http: [...c.rpcs] } }, blockExplorers: { default: { name: c.shortName + ' Scan', url: c.explorer } } })) as [Chain, ...Chain[]],
    multiInjectedProviderDiscovery: true,
    transports: Object.fromEntries(CHAINS.map(c => [c.id, http(`/api/rpc/${c.id}`, { retryCount: 0, fetchOptions: { headers: { 'x-oft-client': 'local-dashboard' } } })])),
  });
}
export function rabbyConnectors(connectors: readonly Connector[]) {
  return connectors.filter(c => c.id === 'io.rabby');
}
export function walletError(error: unknown): string {
  let current = error;
  const visited = new Set();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const item = current as { code?: number; name?: string; cause?: unknown };
    if (item.code === 4001 || item.name === 'UserRejectedRequestError') return 'Rabby에서 요청을 취소했습니다. 다시 요청할 수 있습니다.';
    if (item.code === -32002 || item.name === 'ResourceUnavailableRpcError') return 'Rabby에 대기 중인 요청이 있습니다. 지갑 창을 확인하세요.';
    current = item.cause;
  }
  return 'Rabby 요청을 완료하지 못했습니다. 지갑의 잠금 상태와 연결을 확인하세요.';
}
export function sessionKey(address?: string, chainId?: number, providerUid?: string) {
  return JSON.stringify([address?.toLowerCase() ?? null, chainId ?? null, providerUid ?? null]);
}
