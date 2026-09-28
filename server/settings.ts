import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CHAINS, type ChainId } from '../shared/chains';
import type { SettingsResponse } from '../shared/api';
import { AppError } from './errors';

export function validateRpcUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new AppError('RPC_INVALID_URL', 'RPC 오류 — 올바른 HTTP(S) 주소를 입력하세요.');
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new AppError('RPC_INVALID_URL', 'RPC 오류 — 올바른 HTTP(S) 주소를 입력하세요.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) {
    throw new AppError('RPC_INVALID_URL', 'RPC 오류 — HTTPS 주소를 입력하세요. 로컬 노드는 HTTP도 가능합니다.');
  }
  if (loopback && ['4318', '5173'].includes(url.port)) throw new AppError('RPC_INVALID_URL', 'RPC 오류 — 대시보드 주소는 RPC로 사용할 수 없습니다.');
  return url.toString();
}

// OFT_RPC_URL_<chainId> keeps a private RPC (and its API key) in the environment, never in code or the UI.
export function rpcOverrides(env: Record<string, string | undefined>): Partial<Record<ChainId, readonly string[]>> {
  const endpoints: Partial<Record<ChainId, readonly string[]>> = {};
  for (const chain of CHAINS) {
    const value = env[`OFT_RPC_URL_${chain.id}`];
    if (!value) continue;
    try { endpoints[chain.id] = [validateRpcUrl(value)]; }
    catch { throw new AppError('RPC_INVALID_URL', `OFT_RPC_URL_${chain.id} 값이 올바른 HTTPS RPC 주소가 아닙니다.`); }
  }
  return endpoints;
}

export class SettingsStore {
  private custom: Partial<Record<ChainId, string>> = {};
  private revision = 0;
  private queue: Promise<void> = Promise.resolve();
  constructor(private path: string) {}
  async load() {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !('custom' in parsed)) throw new Error('format');
      const custom = (parsed as { custom: Record<string, unknown> }).custom;
      if (!custom || typeof custom !== 'object') throw new Error('format');
      const revision = (parsed as { revision?: unknown }).revision ?? 0;
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) throw new Error('revision');
      this.revision = revision;
      for (const chain of CHAINS) if (custom[chain.id] != null) this.custom[chain.id] = validateRpcUrl(custom[chain.id]);
      await chmod(this.path, 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new AppError('RPC_SETTINGS_ERROR', '로컬 RPC 설정 파일을 읽을 수 없습니다. .local/rpc.json을 확인하세요.', 500);
    }
  }
  snapshot(chainId: ChainId) { return { url: this.custom[chainId], revision: this.revision }; }
  summary(): SettingsResponse {
    return { revision: this.revision, chains: CHAINS.map(chain => ({ chainId: chain.id, custom: Boolean(this.custom[chain.id]), host: this.custom[chain.id] ? new URL(this.custom[chain.id]!).hostname : null })) };
  }
  async set(chainId: ChainId, url: string | null) {
    const write = this.queue.then(async () => {
      const next = { ...this.custom };
      if (url) next[chainId] = url; else delete next[chainId];
      try {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temp = `${this.path}.tmp`;
        await writeFile(temp, JSON.stringify({ custom: next, revision: this.revision + 1 }, null, 2) + '\n', { mode: 0o600 });
        await rename(temp, this.path);
        this.custom = next;
        this.revision++;
      } catch { throw new AppError('RPC_SETTINGS_ERROR', 'RPC 설정을 로컬 파일에 저장하지 못했습니다.', 500); }
    });
    this.queue = write.catch(() => {});
    await write;
    return this.summary();
  }
}
