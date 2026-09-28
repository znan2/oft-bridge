import { useEffect, useState } from 'react';
import type { HealthResponse } from '../../shared/api';
import { NETWORK_MODE, type ExecutionMode, type NetworkMode } from '../../shared/network';
import { api } from './api';

export interface Runtime { ready: boolean; network: NetworkMode; executionMode: ExecutionMode; mismatch: boolean }
// Unknown or unreachable server state is always treated as dry-run.
const fallback: Runtime = { ready: false, network: NETWORK_MODE, executionMode: 'dry-run', mismatch: false };
let cached: Promise<Runtime> | undefined;

export function toRuntime(health: HealthResponse): Runtime {
  const mismatch = health.network !== NETWORK_MODE;
  // Live signing needs the server's explicit --live flag and a UI built for the same network.
  const live = health.executionMode === 'live' && health.walletExecution === true && !mismatch;
  return { ready: true, network: health.network, executionMode: live ? 'live' : 'dry-run', mismatch };
}
/** Uncached read. The signing path must use this: the server may have restarted in another mode. */
export async function currentRuntime(signal?: AbortSignal): Promise<Runtime> {
  try { return toRuntime(await api<HealthResponse>('/health', { signal })); } catch { return fallback; }
}
export function loadRuntime(): Promise<Runtime> {
  cached ??= currentRuntime().then(runtime => { if (!runtime.ready) cached = undefined; return runtime; });
  return cached;
}
export function useRuntime(): Runtime {
  const [state, setState] = useState(fallback);
  useEffect(() => {
    let active = true;
    void loadRuntime().then(runtime => { if (active) setState(runtime); });
    return () => { active = false; };
  }, []);
  return state;
}
