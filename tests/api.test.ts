import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, API_TIMEOUT_MS } from '../src/lib/api';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const untilAbort = (signal: AbortSignal) => new Promise<never>((_, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});
describe('local API failure and recovery', () => {
  it.each(['fetch', 'body'])('times out a stalled %s without retrying', async phase => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (_url, init: RequestInit) => phase === 'fetch' ? untilAbort(init.signal!) : { ok: true, json: () => untilAbort(init.signal!) });
    vi.stubGlobal('fetch', fetcher);
    const result = api('/health').catch(error => error);
    await vi.advanceTimersByTimeAsync(API_TIMEOUT_MS);
    expect(await result).toMatchObject({ code: 'LOCAL_SERVER_TIMEOUT' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves caller cancellation without reporting an outage', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => untilAbort(init.signal!)));
    const controller = new AbortController(), reason = new Error('route changed');
    const result = api('/health', { signal: controller.signal }).catch(error => error);
    controller.abort(reason);
    expect(await result).toBe(reason);
  });
  it('allows an explicit retry after the server comes back', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal('fetch', fetcher);
    await expect(api('/health')).rejects.toMatchObject({ code: 'LOCAL_SERVER_ERROR' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(api('/health')).resolves.toEqual({ ok: true });
  });
  it.each(['RPC_ERROR', 'SCAN_ERROR', 'SETTINGS_CHANGED'])('preserves %s returned by the server', async code => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code, message: 'specific failure' }), { status: 503 })));
    await expect(api('/rpc/56')).rejects.toMatchObject({ code, message: 'specific failure' });
  });
});
