import { describe, expect, it, vi } from 'vitest';
import { pad, zeroAddress } from 'viem';
import { validateRoute } from '../src/lib/route';
import { matchDvns, peerAddress } from '../src/lib/route-config';
import { PROTOCOL } from '../shared/protocol';
import { routeHarness, routeInput, D1, D2, S1, S2, uln } from './helpers/route';
import { TOKEN, BRIDGE, OTHER } from './helpers/discovery';
import type { RouteResult } from '../shared/route';
const check = (result: RouteResult, id: string) => result.checks.find(c => c.id === id);
describe('cross-chain OFT route validation', () => {
  it('follows the peer to a different address, checks both sides, and saves only address evidence', async () => {
    const { io } = routeHarness();
    const result = await validateRoute(routeInput, io);
    expect(result).toMatchObject({ configurationStatus: 'PASS', status: 'UNKNOWN', executionReady: false, destination: { identity: { bridgeAddress: BRIDGE, token: { address: OTHER } } } });
    expect(io.store.save).toHaveBeenCalledWith(expect.objectContaining({ chainId: 1, tokenAddress: OTHER, bridgeAddress: BRIDGE, source: 'peer' }));
    expect(check(result, 'liquidity')?.status).toBe('UNKNOWN');
    expect(check(result, 'custom')?.status).toBe('UNKNOWN');
    expect(vi.mocked(io.rpc).mock.calls.every(([, method]) => !/send|sign|estimateGas/i.test(method))).toBe(true);
    expect(vi.mocked(io.rpc).mock.calls.filter(([, method]) => method === 'eth_call' || method === 'eth_getCode').every(([chainId, , params]) => params[1] === (chainId === 56 ? '0x100' : '0x200'))).toBe(true);
  });
  it.each(['missing', 'non-EVM', 'reciprocal', 'no-code'])('does not pass a %s peer', async variant => {
    const { io, contracts } = routeHarness();
    if (variant === 'missing') contracts[56][TOKEN].peers = pad(zeroAddress);
    if (variant === 'non-EVM') contracts[56][TOKEN].peers = `0x${'11'.repeat(32)}`;
    if (variant === 'reciprocal') contracts[1][BRIDGE].peers = pad(OTHER);
    if (variant === 'no-code') delete contracts[1][BRIDGE];
    const result = await validateRoute(routeInput, io);
    expect(result.configurationStatus).toBe('FAIL'); expect(result.executionReady).toBe(false);
    expect(io.store.save).not.toHaveBeenCalled();
  });
  it('rejects a changed source token binding', async () => {
    const { io } = routeHarness();
    expect((await validateRoute({ ...routeInput, tokenAddress: OTHER }, io)).configurationStatus).toBe('FAIL');
  });
  it.each(['wrong-address', 'wrong-eid'])('rejects an Endpoint with %s', async variant => {
    const { io, contracts } = routeHarness();
    if (variant === 'wrong-address') contracts[1][BRIDGE].endpoint = OTHER;
    else contracts[1][PROTOCOL[1].endpoint].eid = 30102;
    expect(check(await validateRoute(routeInput, io), 'endpoints')?.status).toBe('FAIL');
  });
  it('permits different local decimals but rejects different shared decimals', async () => {
    const first = routeHarness(); first.contracts[1][OTHER].decimals = 6;
    expect((await validateRoute(routeInput, first.io)).configurationStatus).toBe('PASS');
    first.contracts[1][BRIDGE].sharedDecimals = 5;
    expect(check(await validateRoute(routeInput, first.io), 'message-format')?.status).toBe('FAIL');
  });
  it('keeps an unknown OFT version unsupported', async () => {
    const { io, contracts } = routeHarness(); contracts[1][BRIDGE].oftVersion = ['0x02e49c2c', 2n];
    expect(check(await validateRoute(routeInput, io), 'destination-identity')?.status).toBe('UNKNOWN');
  });
  it.each(['blocked', 'custom', 'unregistered', 'unsupported-eid', 'other-version'])('detects %s libraries without decoding them as normal ULN302', async variant => {
    const { io, contracts } = routeHarness();
    const endpoint = contracts[56][PROTOCOL[56].endpoint], lib = contracts[56][PROTOCOL[56].sendLibrary];
    if (variant === 'blocked') endpoint.getSendLibrary = PROTOCOL[56].blockedLibrary;
    if (variant === 'custom') { endpoint.getSendLibrary = OTHER; contracts[56][OTHER] = {}; }
    if (variant === 'unregistered') endpoint.isRegisteredLibrary = false;
    if (variant === 'unsupported-eid') lib.isSupportedEid = false;
    if (variant === 'other-version') lib.version = [4n, 0, 2];
    const result = await validateRoute(routeInput, io);
    expect(check(result, 'libraries')?.status).toBe(['custom', 'other-version'].includes(variant) ? 'UNKNOWN' : 'FAIL');
    expect(check(result, 'uln')?.status).toBe('UNKNOWN');
  });
  it('compares source confirmation depth against destination requirements', async () => {
    const { io, configs } = routeHarness(); configs[56].confirmations = '19';
    expect(check(await validateRoute(routeInput, io), 'confirmations')?.status).toBe('FAIL');
    configs[56].confirmations = '25';
    expect(check(await validateRoute(routeInput, io), 'confirmations')?.status).toBe('PASS');
  });
  it('does not accept a raw NIL/default DVN count or malformed threshold as effective config', async () => {
    const { io, configs } = routeHarness(); configs[56].requiredDVNCount = 255;
    expect(check(await validateRoute(routeInput, io), 'uln')?.status).toBe('UNKNOWN');
    configs[56].requiredDVNCount = 2; configs[56].optionalDVNThreshold = 1;
    expect(check(await validateRoute(routeInput, io), 'uln')?.status).toBe('UNKNOWN');
  });
  it('rejects a Dead DVN even if the address has code', async () => {
    const { io, configs, contracts } = routeHarness();
    configs[56] = uln([PROTOCOL[56].deadDvn]); contracts[56][PROTOCOL[56].deadDvn] = {};
    expect(check(await validateRoute(routeInput, io), 'uln')?.status).toBe('FAIL');
  });
  it('keeps metadata failure distinct from RPC failure and never passes DVN mapping on stale data', async () => {
    const { io, catalog } = routeHarness(); catalog.status = 'stale';
    const result = await validateRoute(routeInput, io);
    expect(result.configurationStatus).toBe('UNKNOWN'); expect(check(result, 'dvns')?.detail).toContain('메타데이터');
    expect(check(result, 'libraries')?.status).toBe('PASS');
  });
  it('flags deployment registry drift', async () => {
    const { io, catalog } = routeHarness(); catalog.chains[0].sendLibrary = OTHER;
    expect(check(await validateRoute(routeInput, io), 'protocol-registry')?.status).toBe('UNKNOWN');
  });
  it.each(['native-cap', 'size', 'custom-executor'])('detects unusable %s executor configuration', async variant => {
    const { io, contracts, executors } = routeHarness();
    if (variant === 'native-cap') contracts[56][PROTOCOL[56].executors[0]].dstConfig = [5000n, 12000, 0n, 0n];
    if (variant === 'size') executors[56].maxMessageSize = 39;
    if (variant === 'custom-executor') { executors[56].executor = OTHER; contracts[56][OTHER] = {}; }
    expect(check(await validateRoute(routeInput, io), 'executor')?.status).toBe(variant === 'custom-executor' ? 'UNKNOWN' : 'FAIL');
  });
  it('flags pause and zero adapter inventory as execution failures even when configuration matches', async () => {
    const { io, contracts } = routeHarness(); contracts[56][TOKEN].paused = true; contracts[1][OTHER].balanceOf = 0n;
    const result = await validateRoute(routeInput, io);
    expect(result.configurationStatus).toBe('PASS'); expect(result.status).toBe('FAIL');
    expect(check(result, 'liquidity')?.status).toBe('FAIL');
    expect(check(result, `pause-56-${TOKEN}`)?.status).toBe('FAIL');
  });
  it('does not assume paused=false when the getter does not exist', async () => {
    const { io } = routeHarness(); const result = await validateRoute(routeInput, io);
    expect(check(result, `pause-1-${BRIDGE}`)?.status).toBe('UNKNOWN');
  });
  it('labels RPC failure as UNKNOWN and cancels obsolete checks without saving candidates', async () => {
    const { io } = routeHarness(); vi.mocked(io.rpc).mockRejectedValueOnce(new Error('offline'));
    const result = await validateRoute(routeInput, io);
    expect(result.status).toBe('UNKNOWN'); expect(result.checks[0].detail).toContain('RPC 오류');
    expect(io.store.save).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort();
    await expect(validateRoute(routeInput, io, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('checks the reverse direction independently and uses no adapter inventory check for self-OFT destination', async () => {
    const { io } = routeHarness();
    const result = await validateRoute({ sourceChain: 1, destinationChain: 56, bridgeAddress: BRIDGE, tokenAddress: OTHER }, io);
    expect(result.configurationStatus).toBe('PASS'); expect(check(result, 'liquidity')?.status).toBe('NOT_APPLICABLE');
  });
});

describe('DVN identity and optional threshold matching', () => {
  it('matches operator ids across different chain addresses, including source optional assignments', () => {
    const { catalog } = routeHarness();
    const send = { ...uln([S1]), optionalDVNs: [S2], optionalDVNCount: 1, optionalDVNThreshold: 1 };
    expect(matchDvns(send, uln([D1, D2]), 56, 1, catalog).status).toBe('PASS');
    expect(matchDvns(uln([S1]), uln([D1, D2]), 56, 1, catalog).status).toBe('FAIL');
    expect(matchDvns(uln([S1]), { ...uln([D1]), optionalDVNs: [D2], optionalDVNCount: 1, optionalDVNThreshold: 1 }, 56, 1, catalog).status).toBe('FAIL');
  });
  it('never guesses unknown, deprecated, or ambiguous DVN identities', () => {
    for (const kind of ['missing', 'deprecated', 'ambiguous']) {
      const { catalog } = routeHarness(); const dvns = catalog.chains[0].dvns;
      if (kind === 'missing') dvns.pop();
      if (kind === 'deprecated') dvns[0].deprecated = true;
      if (kind === 'ambiguous') dvns.push({ ...dvns[0], address: OTHER });
      expect(matchDvns(uln(), uln([D1, D2]), 56, 1, catalog).status).toBe('UNKNOWN');
    }
  });
  it('requires EVM padding when interpreting bytes32 peer', () => {
    expect(peerAddress(pad(TOKEN))).toBe(TOKEN);
    expect(() => peerAddress(`0x${'ff'.repeat(32)}`)).toThrow();
  });
});

describe('Executor layout compatibility', () => {
  it.each([1, 2])('handles %s extra dstConfig words conservatively', async extraWords => {
    const { io } = routeHarness(); const normal = io.rpc;
    io.rpc = vi.fn(async (chainId, method, params) => {
      const value = await normal(chainId, method, params);
      const to = (params[0] as { to?: string })?.to?.toLowerCase();
      return method === 'eth_call' && to === PROTOCOL[56].executors[0] ? String(value) + '0'.repeat(64 * extraWords) : value;
    });
    expect(check(await validateRoute(routeInput, io), 'executor')?.status).toBe(extraWords === 1 ? 'PASS' : 'UNKNOWN');
  });
});
