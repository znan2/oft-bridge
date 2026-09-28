import type { RpcResponse } from '../../shared/api';
import type { ChainId } from '../../shared/chains';
import type { Catalog } from '../../shared/discovery';
import { api } from './api';
import { candidateStore } from './candidate-store';
import { RpcCallError, type DiscoveryIO } from './discovery';

export function browserDiscoveryIO(chainId: ChainId, revision: number, signal: AbortSignal): DiscoveryIO {
  return {
    async rpc(method, params) {
      const response = await api<RpcResponse>(`/rpc/${chainId}`, { method: 'POST', signal,
        headers: { 'x-oft-rpc-revision': String(revision) },
        body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }) });
      if (response.error) throw new RpcCallError(response.error.code, response.error.message, response.error.data);
      return response.result;
    },
    catalog: () => api<Catalog>('/metadata/ofts', { signal }),
    store: candidateStore,
  };
}
