import { describe, it, expect, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionData, toHex } from 'viem';
import { prepareExecution, submitExecution, type RabbySession } from '../src/lib/execution';
import { locksAccount, type ExecutionRecord, type ExecutionStore } from '../shared/execution';
import { OFT_QUOTE_ABI } from '../shared/oft-abi';
import { transferHarness, transferInput, SENDER } from './helpers/transfer';
import { BRIDGE, OTHER } from './helpers/discovery';
export function memoryStore() {
  const rows = new Map<string, ExecutionRecord>();
  const store: ExecutionStore = {
    list: vi.fn(async () => [...rows.values()]),
    reserve: vi.fn(async row => { if ([...rows.values()].some(r => r.review.transaction.from === row.review.transaction.from && r.review.transaction.chainId === row.review.transaction.chainId && locksAccount(r))) throw new Error('미확정 요청'); rows.set(row.id, structuredClone(row)); }),
    put: vi.fn(async row => { rows.set(row.id, structuredClone(row)); }),
  }; return { rows, store };
}
export function executionHarness() {
  const h = transferHarness(), original = h.io.rpc;
  h.io.rpc = vi.fn(async (chain, method, params) => method === 'eth_getTransactionCount' ? '0x4' : original(chain, method, params));
  const wallet: RabbySession = { uid: transferInput.providerUid, executionMode: 'live', assertCurrent: vi.fn(), request: vi.fn(async ({ method }) => method === 'eth_accounts' ? [SENDER] : method === 'eth_chainId' ? '0x38' : `0x${'a'.repeat(64)}`) };
  return { ...h, wallet, ...memoryStore() };
}
describe('dry-run default', () => {
  it.each([undefined, 'dry-run', 'LIVE', 'true'])('refuses to open the wallet or reserve history when executionMode is %s', async mode => {
    const h = executionHarness(), review = await prepareExecution(transferInput, h.io);
    const wallet = { ...h.wallet, executionMode: mode } as unknown as RabbySession;
    await expect(submitExecution(review, wallet, h.io, h.store)).rejects.toMatchObject({ code: 'DRY_RUN' });
    expect(h.wallet.request).not.toHaveBeenCalled(); expect(h.store.reserve).not.toHaveBeenCalled(); expect(h.rows.size).toBe(0);
  });
  it('still produces the dry-run output: route, amounts and fee estimate without any wallet call', async () => {
    const h = executionHarness(), review = await prepareExecution(transferInput, h.io);
    expect(review.plan.fee.nativeFee).toBe(h.values.nativeFee.toString()); expect(review.gasBudget?.budgetWithBufferWei).toBeTruthy();
    expect(review.plan.route.configurationStatus).toBe('PASS'); expect(h.wallet.request).not.toHaveBeenCalled();
  });
});
describe('M5 explicit wallet execution', () => {
  it('revalidates and prepares a send without signing', async () => {
    const h = executionHarness(), review = await prepareExecution(transferInput, h.io);
    expect(review.kind).toBe('send'); expect(review.transaction.value).toBe(h.values.nativeFee.toString()); expect(h.wallet.request).not.toHaveBeenCalled();
  });
  it('persists the intent first and submits the exact reviewed request once through Rabby only', async () => {
    const h = executionHarness(), review = await prepareExecution(transferInput, h.io);
    const original = h.wallet.request;
    h.wallet.request = vi.fn(async args => { if (args.method === 'eth_sendTransaction') expect(h.rows.size).toBe(1); return original(args); });
    const row = await submitExecution(review, h.wallet, h.io, h.store);
    expect(row.status).toBe('pending'); expect(row.nonce).toBe('4');
    const writes = vi.mocked(h.wallet.request).mock.calls.filter(([x]) => x.method === 'eth_sendTransaction'); expect(writes).toHaveLength(1);
    expect(writes[0][0].params).toEqual([{ from: SENDER, to: review.transaction.to, data: review.transaction.data, value: toHex(BigInt(review.transaction.value)), gas: toHex(BigInt(review.transaction.gas)), gasPrice: toHex(BigInt(review.transaction.gasPrice)), chainId: '0x38', nonce: '0x4' }]);
    expect(vi.mocked(h.io.rpc).mock.calls.some(([,m]) => /sendTransaction|sign/i.test(m))).toBe(false);
  });
  it.each(['expired', 'data', 'value', 'chain', 'to'])('blocks %s review changes before opening a wallet', async change => {
    const h = executionHarness(), r = await prepareExecution(transferInput, h.io);
    if (change === 'expired') r.expiresAt = new Date(0).toISOString();
    if (change === 'data') r.transaction.data = '0x'; if (change === 'value') r.transaction.value = '1'; if (change === 'chain') r.transaction.chainId = 1; if (change === 'to') r.transaction.to = OTHER;
    await expect(submitExecution(r, h.wallet, h.io, h.store)).rejects.toThrow(); expect(h.rows.size).toBe(0);
  });
  it.each(['account', 'chain', 'provider', 'disconnected'])('blocks a changed wallet %s', async change => {
    const h = executionHarness(), r = await prepareExecution(transferInput, h.io);
    if (change === 'provider') h.wallet.uid = 'different';
    if (change === 'disconnected') h.wallet.assertCurrent = () => { throw new Error('disconnected'); };
    if (change === 'account' || change === 'chain') h.wallet.request = vi.fn(async ({ method }) => method === 'eth_accounts' ? [change === 'account' ? OTHER : SENDER] : '0x1');
    await expect(submitExecution(r, h.wallet, h.io, h.store)).rejects.toThrow(); expect(h.rows.size).toBe(0);
  });
  it.each(['funds', 'gas', 'receipt', 'aborted'])('blocks latest preflight %s changes', async change => {
    const h = executionHarness(), r = await prepareExecution(transferInput, h.io), c = new AbortController();
    if (change === 'funds') h.values.nativeBalance = 0n; if (change === 'gas') h.values.gas *= 5n;
    if (change === 'receipt') h.values.receivedDelta = -1n; if (change === 'aborted') c.abort();
    await expect(submitExecution(r, h.wallet, h.io, h.store, c.signal)).rejects.toThrow(); expect(h.rows.size).toBe(0);
  });
  it('prevents duplicate requests across executions even while the first wallet is open', async () => {
    const h = executionHarness(), r = await prepareExecution(transferInput, h.io);
    await submitExecution(r, h.wallet, h.io, h.store);
    await expect(submitExecution(r, h.wallet, h.io, h.store)).rejects.toThrow('미확정');
    expect(vi.mocked(h.wallet.request).mock.calls.filter(([a]) => a.method === 'eth_sendTransaction')).toHaveLength(1);
  });
  it.each([4001, -32002, -32603])('records wallet error %s without retry', async code => {
    const h = executionHarness(), r = await prepareExecution(transferInput, h.io), original = h.wallet.request;
    h.wallet.request = vi.fn(async a => { if (a.method === 'eth_sendTransaction') throw { code }; return original(a); });
    const row = await submitExecution(r, h.wallet, h.io, h.store);
    expect(row.status).toBe(code === 4001 ? 'rejected' : 'unknown'); expect(locksAccount(row)).toBe(code !== 4001);
    expect(vi.mocked(h.wallet.request).mock.calls.filter(([a]) => a.method === 'eth_sendTransaction')).toHaveLength(1);
  });
  it('keeps the hash if the component aborts during wallet signing', async () => {
    const h = executionHarness(), r = await prepareExecution(transferInput, h.io), c = new AbortController(), original = h.wallet.request;
    h.wallet.request = vi.fn(async a => { if (a.method === 'eth_sendTransaction') c.abort(); return original(a); });
    const row = await submitExecution(r, h.wallet, h.io, h.store, c.signal);
    expect(row.hash).toMatch(/^0x/); expect(h.rows.get(row.id)?.hash).toBe(row.hash);
  });
  it('does not open Rabby if the intent cannot be persisted', async () => {
    const h = executionHarness(), r = await prepareExecution(transferInput, h.io); h.store.reserve = vi.fn(async () => { throw new Error('storage failure'); });
    await expect(submitExecution(r, h.wallet, h.io, h.store)).rejects.toThrow('storage');
    expect(vi.mocked(h.wallet.request).mock.calls.some(([a]) => a.method === 'eth_sendTransaction')).toBe(false);
  });
  it('keeps a recovered replacement if the original wallet response arrives later', async () => {
    const h = executionHarness(), r = await prepareExecution(transferInput, h.io), original = h.wallet.request;
    const replacementHash = `0x${'b'.repeat(64)}`;
    h.wallet.request = vi.fn(async args => {
      if (args.method === 'eth_sendTransaction') {
        const old = [...h.rows.values()][0];
        h.rows.set(old.id, { ...old, hash: replacementHash, storageRevision: 1, status: 'pending' });
      }
      return original(args);
    });
    h.store.put = vi.fn(async (_row, expected) => { expect(expected?.storageRevision).toBeUndefined(); return false; });
    const row = await submitExecution(r, h.wallet, h.io, h.store);
    expect(row.hash).toBe(replacementHash);
    expect(vi.mocked(h.wallet.request).mock.calls.filter(([a]) => a.method === 'eth_sendTransaction')).toHaveLength(1);
  });
  it('returns the hash and a visible recovery error if persistence fails after broadcast', async () => {
    const h = executionHarness(), r = await prepareExecution(transferInput, h.io); h.store.put = vi.fn(async () => { throw new Error(); });
    const row = await submitExecution(r, h.wallet, h.io, h.store); expect(row.hash).toBeTruthy(); expect(row.trackingError).toContain('저장 실패');
  });
  it.each([0n, 1n])('prepares exact approval or a separate zero reset for allowance %s', async allowance => {
    const h = executionHarness(); h.values.allowance = allowance; h.contracts[1][OTHER].approve = true;
    const input = { ...transferInput, walletChainId: 1, route: { sourceChain: 1 as const, destinationChain: 56 as const, tokenAddress: OTHER, bridgeAddress: BRIDGE } };
    const review = await prepareExecution(input, h.io);
    expect(review.kind).toBe(allowance ? 'approve-reset' : 'approve');
    expect(decodeFunctionData({ abi: OFT_QUOTE_ABI, data: review.transaction.data }).args).toEqual([BRIDGE, allowance ? 0n : BigInt(review.plan.amounts.sentLD)]);
    expect(review.transaction.value).toBe('0');
  });
  it('refuses ERC20 approve false instead of treating an eth_call return as success', async () => {
    const h = executionHarness(); h.contracts[1][OTHER].approve = false;
    await expect(prepareExecution({ ...transferInput, walletChainId: 1, route: { sourceChain: 1, destinationChain: 56, tokenAddress: OTHER, bridgeAddress: BRIDGE } }, h.io)).rejects.toThrow('성공 값');
  });
});
