import { REGISTRY } from './chains';
export interface ProtocolProfile { endpoint: string; sendLibrary: string; receiveLibrary: string; blockedLibrary: string; deadDvn: string; executors: readonly string[] }
// Pinned, explicitly generated deployment profiles. Live metadata must still match before execution.
export const PROTOCOL: Readonly<Record<number, ProtocolProfile>> = Object.fromEntries(REGISTRY.chains.map(c => [c.id, c.protocol]));
