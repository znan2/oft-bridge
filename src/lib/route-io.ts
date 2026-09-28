import type { ChainId } from '../../shared/chains';
import type { ProtocolCatalog } from '../../shared/route';
import { api } from './api';
import { candidateStore } from './candidate-store';
import { browserDiscoveryIO } from './discovery-io';
import type { RouteIO } from './route';
export function browserRouteIO(revision: number, signal: AbortSignal): RouteIO {
  const clients = new Map<ChainId, ReturnType<typeof browserDiscoveryIO>>();
  return {
    rpc(chainId, method, params) {
      if (!clients.has(chainId)) clients.set(chainId, browserDiscoveryIO(chainId, revision, signal));
      return clients.get(chainId)!.rpc(method, params);
    },
    protocol: () => api<ProtocolCatalog>('/metadata/protocol', { signal }), store: candidateStore,
  };
}
