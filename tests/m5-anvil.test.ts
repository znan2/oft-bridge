import { readFileSync, writeFileSync } from 'node:fs';
import { it, expect } from 'vitest';
import { encodeFunctionData, decodeFunctionResult, parseAbi, toHex, pad } from 'viem';
import { prepareExecution, submitExecution } from '../src/lib/execution';
import { attachSourceHash, trackExecution } from '../src/lib/tracking';
import type { TransferInput } from '../shared/transfer';
import { locksAccount, type ExecutionRecord, type ExecutionStore, type ScanResult } from '../shared/execution';
import { PROTOCOL } from '../shared/protocol';
import { transferHarness, transferInput, SENDER, RECIPIENT } from './helpers/transfer';
import { TOKEN, BRIDGE, OTHER } from './helpers/discovery';
const enabled = process.env.OFT_M5_ANVIL === '1';
it.skipIf(!enabled)('local EVM: reset → exact approval → fresh quote → send → verified destination delivery in both directions', async () => {
  const tokenArtifact = JSON.parse(readFileSync(`${process.env.OFT_M5_ARTIFACTS ?? '/tmp/oft-m5-evm/out'}/M5Harness.sol/M5Token.json`, 'utf8'));
  const endpointArtifact = JSON.parse(readFileSync(`${process.env.OFT_M5_ARTIFACTS ?? '/tmp/oft-m5-evm/out'}/M5Harness.sol/M5Endpoint.json`, 'utf8'));
  let id = 0;
  const rpc = async (chain: 1 | 56, method: string, params: unknown[]) => {
    const response = await fetch(`http://127.0.0.1:${chain === 56 ? (process.env.OFT_M5_BSC_PORT ?? 18545) : (process.env.OFT_M5_ETH_PORT ?? 18546)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    const body = await response.json(); if (body.error) throw new Error(body.error.message); return body.result;
  };
  const admin = async (chain: 1 | 56, to: string, name: string, args: unknown[]) => rpc(chain, 'eth_sendTransaction', [{ from: SENDER, to, data: encodeFunctionData({ abi: tokenArtifact.abi, functionName: name, args }), gas: '0x100000' }]);
  for (const chain of [56,1] as const) {
    expect(BigInt(await rpc(chain, 'eth_chainId', []))).toBe(BigInt(chain));
    await rpc(chain, 'anvil_impersonateAccount', [SENDER]); await rpc(chain, 'anvil_setBalance', [SENDER, toHex(10n ** 22n)]);
    for (const target of [TOKEN, BRIDGE, OTHER]) await rpc(chain, 'anvil_setCode', [target, tokenArtifact.deployedBytecode.object]);
    await rpc(chain, 'anvil_setCode', [PROTOCOL[chain].endpoint, endpointArtifact.deployedBytecode.object]);
  }
  await admin(56, TOKEN, 'setup', [TOKEN, BRIDGE, 30102]); await admin(1, BRIDGE, 'setup', [OTHER, TOKEN, 30101]);
  await admin(56, TOKEN, 'seed', [SENDER, 10n ** 21n]); await admin(1, OTHER, 'seed', [SENDER, 10n ** 21n]); await admin(1, OTHER, 'seed', [BRIDGE, 10n ** 21n]);
  // Existing insufficient approval exercises a separate reset transaction.
  await admin(1, OTHER, 'approve', [BRIDGE, 1n]);
  const rows = new Map<string, ExecutionRecord>();
  const store: ExecutionStore = { list: async () => [...rows.values()], reserve: async r => { if ([...rows.values()].some(x => x.review.transaction.chainId === r.review.transaction.chainId && locksAccount(x))) throw new Error('pending'); rows.set(r.id, r); }, put: async r => { rows.set(r.id, r); } };
  const summaries = [];
  for (const chain of [1,56] as const) {
    const destination = chain === 1 ? 56 : 1, token = chain === 1 ? OTHER : TOKEN, bridge = chain === 1 ? BRIDGE : TOKEN, peer = chain === 1 ? TOKEN : BRIDGE;
    const h = transferHarness();
    const input: TransferInput = { ...transferInput, amount: '1', sender: SENDER, recipient: RECIPIENT, walletChainId: chain, route: { sourceChain: chain, destinationChain: destination, tokenAddress: token, bridgeAddress: bridge } };
    const refresh = async () => {
      if (chain === 1) {
        const raw = await rpc(chain, 'eth_call', [{ to: token, data: encodeFunctionData({ abi: tokenArtifact.abi, functionName: 'allowance', args: [SENDER, bridge] }) }, 'latest']);
        h.values.allowance = BigInt(raw);
      }
      const mock = h.io.rpc;
      return { ...h.io, rpc: async (c: 1 | 56, m: string, a: unknown[]) => {
        // M3 route/quote fixture is explicit; approve simulation and all submitted transactions run in EVM.
        if (m === 'eth_call' && (a[0] as { data: string }).data.startsWith('0x095ea7b3')) return rpc(c,m,a);
        return mock(c,m,a);
      } };
    };
    let review = await prepareExecution(input, await refresh());
    const wallet = { uid: input.providerUid, executionMode: 'live' as const, assertCurrent() {}, request: ({ method, params = [] }: { method: string; params?: unknown[] }) => method === 'eth_accounts' ? Promise.resolve([SENDER]) : rpc(chain, method, params) };
    const scanMessages: ScanResult = { checkedAt: new Date().toISOString(), messages: [] };
    const io = { rpc, scan: async () => scanMessages };
    const actions = [];
    for (let i=0;i<3;i++) {
      const row = await submitExecution(review, wallet, { ...h.io, rpc }, store);
      expect(row.hash).toMatch(/^0x/); expect(row.status).toBe('pending'); actions.push(review.kind);
      await rpc(chain, 'anvil_mine', ['0x50']);
      let tracked = await trackExecution(row, io);
      if (review.kind !== 'send') {
        expect(tracked.status, tracked.trackingError).toBe('approval-confirmed'); await store.put(tracked);
        review = await prepareExecution(input, await refresh()); continue;
      }
      expect(tracked.guid, tracked.trackingError).toBeTruthy();
      const nonceRaw = await rpc(chain, 'eth_call', [{ to: bridge, data: encodeFunctionData({ abi: tokenArtifact.abi, functionName: 'nonce' }) }, 'latest']);
      const dstHash = await rpc(destination, 'eth_sendTransaction', [{ from: SENDER, to: PROTOCOL[destination].endpoint, gas: '0x100000', data: encodeFunctionData({ abi: endpointArtifact.abi, functionName: 'deliver', args: [{ srcEid: chain === 1 ? 30101 : 30102, sender: pad(bridge), nonce: BigInt(nonceRaw) }, peer, destination === 1 ? 30101 : 30102, RECIPIENT, 10n ** 18n] }) }]);
      await rpc(destination, 'anvil_mine', ['0x50']);
      scanMessages.messages.push({ guid: tracked.guid!, srcEid: chain === 1 ? 30101 : 30102, dstEid: destination === 1 ? 30101 : 30102, sender: bridge, receiver: peer, sourceHash: row.hash!, destinationHash: dstHash, status: 'DELIVERED' });
      tracked = await trackExecution(tracked, io);
      expect(tracked.status, tracked.trackingError).toBe('delivered'); expect(tracked.destinationAmountLD).toBe((10n ** 18n).toString()); await store.put(tracked);
      summaries.push({ chain, actions, sourceHash: row.hash, destinationHash: dstHash, status: tracked.status }); break;
    }
    expect(actions).toEqual(chain === 1 ? ['approve-reset','approve','send'] : ['send']);
  }
  // M6: actual pending/replacement receipts, while public RPC settings and real wallets remain untouched.
  const recoverySummaries = [];
  const balance = async () => BigInt(await rpc(56, 'eth_call', [{ to: TOKEN, data: encodeFunctionData({ abi: tokenArtifact.abi, functionName: 'balanceOf', args: [SENDER] }) }, 'latest']));
  const io = { rpc, scan: async (): Promise<ScanResult> => ({ checkedAt: new Date().toISOString(), messages: [] }) };
  const wallet = { uid: transferInput.providerUid, executionMode: 'live' as const, assertCurrent() {}, request: ({ method, params = [] }: { method: string; params?: unknown[] }) => method === 'eth_accounts' ? Promise.resolve([SENDER]) : rpc(56, method, params) };
  for (const kind of ['speedup', 'cancel'] as const) {
    const h = transferHarness(), review = await prepareExecution({ ...transferInput, amount: '1' }, h.io), before = await balance();
    await rpc(56, 'evm_setAutomine', [false]);
    try {
      const sent = await submitExecution(review, wallet, { ...h.io, rpc }, store);
      const pending = await trackExecution(sent, io);
      expect(pending.status).toBe('pending'); expect(locksAccount(pending)).toBe(true);
      await expect(submitExecution(review, wallet, { ...h.io, rpc }, store)).rejects.toThrow('pending');
      const failed = await trackExecution(pending, { ...io, rpc: async () => { throw new Error('RPC 오류 — offline'); } });
      expect(failed.trackingError).toContain('RPC 오류'); expect(failed.hash).toBe(sent.hash);
      const t = review.transaction;
      const replacementHash = await rpc(56, 'eth_sendTransaction', [{ from: SENDER, to: kind === 'cancel' ? SENDER : t.to, data: kind === 'cancel' ? '0x' : t.data, value: kind === 'cancel' ? '0x0' : toHex(BigInt(t.value)), gas: kind === 'cancel' ? '0x5208' : toHex(BigInt(t.gas)), gasPrice: toHex(BigInt(t.gasPrice) * 2n), nonce: toHex(BigInt(sent.nonce)) }]);
      const restored = JSON.parse(JSON.stringify(failed)) as ExecutionRecord;
      const linked = await attachSourceHash(restored, replacementHash, io);
      expect((await trackExecution(linked, io)).status).toBe('pending');
      await rpc(56, 'anvil_mine', ['0x50']);
      const final = await trackExecution(linked, io);
      expect(final.status, final.trackingError).toBe(kind === 'cancel' ? 'replaced' : 'destination-pending');
      expect(final.sourceFinalized).toBe(true); expect(locksAccount(final)).toBe(false);
      expect(before - await balance()).toBe(kind === 'cancel' ? 0n : 10n ** 18n);
      await store.put(final);
      recoverySummaries.push({ kind, originalHash: sent.hash, replacementHash, status: final.status, sourceFinalized: final.sourceFinalized, tokenDebitLD: (before - await balance()).toString(), rpcRecovery: true, restoredFromSerializedRecord: true });
    } finally { await rpc(56, 'evm_setAutomine', [true]); }
  }
  writeFileSync('/tmp/oft-m5-local-evidence.json', JSON.stringify({ checkedAt: new Date().toISOString(), localOnly: true, mockedRouteAndQuote: true, summaries, recoverySummaries }, null, 2) + '\n');
}, 30_000);
