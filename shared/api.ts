import type { ChainId } from './chains';

export type ApiErrorCode = 'RPC_ERROR' | 'RPC_CHAIN_MISMATCH' | 'RPC_INVALID_URL' | 'RPC_SETTINGS_ERROR' | 'STALE_CONTEXT' | 'INVALID_REQUEST' | 'METHOD_NOT_ALLOWED' | 'ACCESS_DENIED' | 'SCAN_ERROR';
export interface ApiFailure { code: ApiErrorCode; message: string }
export interface HealthResponse { ok: true; signing: false; network: 'testnet' | 'mainnet'; executionMode: 'dry-run' | 'live'; walletExecution: boolean }
export interface RpcSetting { chainId: ChainId; custom: boolean; host: string | null }
export interface SettingsResponse { revision: number; chains: RpcSetting[] }
export interface NetworkHealth {
  chainId: ChainId; blockNumber: string; latencyMs: number; checkedAt: string;
  mode: 'public' | 'custom' | 'env'; host: string; fallbackUsed: boolean; revision: number;
}
export interface RpcRequest { jsonrpc: '2.0'; id: string | number; method: string; params: unknown[] }
export interface RpcResponse { jsonrpc: '2.0'; id: string | number; result?: unknown; error?: { code: number; message: string; data?: string } }
