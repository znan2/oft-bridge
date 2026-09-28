// Tests must never reach a real RPC, metadata API or Scan. Only loopback (local anvil harness) is allowed.
const realFetch = globalThis.fetch;
const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`Network blocked in tests: relative URL ${raw}`); }
  if (!loopback.has(url.hostname)) throw new Error(`Network blocked in tests: ${url.hostname}`);
  return realFetch(input, init);
}) as typeof fetch;
