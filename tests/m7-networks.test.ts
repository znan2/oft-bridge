import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, pad } from 'viem';
import { CHAINS, chainById, isChainId } from '../shared/chains';
import { PROTOCOL } from '../shared/protocol';
import { validateRoute } from '../src/lib/route';
import { prepareTransfer } from '../src/lib/transfer';
import { prepareExecution, submitExecution, type RabbySession } from '../src/lib/execution';
import { additionalNetworkFee, assertFinalityAvailable, estimateNetworkGas, OP_FEE_ABI, OP_ORACLE } from '../src/lib/network-execution';
import { ProtocolMetadataService } from '../server/protocol-metadata';
import { routeHarness } from './helpers/route';
import { transferHarness, transferInput, SENDER } from './helpers/transfer';
import { BRIDGE, OTHER, TOKEN } from './helpers/discovery';
const call = { from: SENDER, to: TOKEN, data: '0x1234' as const, value: '0x10' };
function opHarness() {
  const h = transferHarness([8453, 42161]);
  const fee = { data: 1000000000000n, operator: 300000000000n, fail: false };
  const base = h.io.rpc;
  h.io.rpc = vi.fn(async (id, method, params) => {
    if (method === 'eth_call' && String((params[0] as { to: string }).to).toLowerCase() === OP_ORACLE.toLowerCase()) {
      if (fee.fail) throw new Error('RPC fee outage');
      const decoded = decodeFunctionData({ abi: OP_FEE_ABI, data: (params[0] as {data: `0x${string}`}).data });
      return encodeFunctionResult({ abi: OP_FEE_ABI, functionName: decoded.functionName, result: decoded.functionName === 'getL1FeeUpperBound' ? fee.data : fee.operator });
    }
    return base(id, method, params);
  });
  const input = { ...transferInput, walletChainId: 8453, route: { sourceChain: 8453, destinationChain: 42161, bridgeAddress: TOKEN, tokenAddress: TOKEN } };
  return { ...h, fee, input };
}
describe('M7 network registry and routes', () => {
  it('has unique network identities and complete pinned profiles, preserving old IDs', () => {
    expect(CHAINS.length).toBeGreaterThan(65);
    expect(new Set(CHAINS.map(c=>c.id)).size).toBe(CHAINS.length);
    expect(new Set(CHAINS.map(c=>c.eid)).size).toBe(CHAINS.length);
    expect(chainById(56).eid).toBe(30102); expect(chainById(1).eid).toBe(30101);
    expect(isChainId('8453')).toBe(false); expect(isChainId(8453)).toBe(true);
    expect(isChainId(295)).toBe(false); expect(isChainId(4217)).toBe(false);
    for (const chain of CHAINS) {
      expect(chain.decimals).toBe(18); expect(PROTOCOL[chain.id].endpoint).toMatch(/^0x[\da-f]{40}$/);
      expect(chain.sourceRestriction !== undefined).toBe(chain.feeModel === 'unreviewed');
    }
  });
  it.each([[8453, 42161], [10, 137], [43114, 80094]])('validates %s → %s using that pair’s EIDs and profiles', async (src,dst) => {
    const h = routeHarness([src,dst]);
    const result = await validateRoute({ sourceChain: src, destinationChain: dst, bridgeAddress: TOKEN, tokenAddress: TOKEN }, h.io);
    expect(result.configurationStatus).toBe('PASS'); expect(result.destination?.identity?.token.address).toBe(OTHER);
    expect(vi.mocked(h.io.rpc).mock.calls.every(([id]) => [src,dst].includes(id))).toBe(true);
    expect(h.io.store.save).toHaveBeenCalledWith(expect.objectContaining({ chainId: dst, bridgeAddress: BRIDGE }));
  });
  it('isolates malformed metadata to its chain, retaining fresh unrelated rows', async () => {
    const h = routeHarness([8453,42161]);
    const c = h.catalog.chains[0];
    const good = { chainDetails: { nativeChainId: c.chainId }, deployments: [{ stage: 'mainnet', version: 2, eid: c.eid, endpointV2: { address: c.endpoint }, sendUln302: { address: c.sendLibrary }, receiveUln302: { address: c.receiveLibrary }, blockedMessageLib: { address: c.blockedLibrary }, deadDVN: { address: c.deadDvn }, executor: { address: c.executors[0] } }], dvns: {} };
    const service = new ProtocolMetadataService(vi.fn(async () => Response.json({ base: good, arbitrum: { bad: true } })));
    const catalog = await service.get();
    expect(catalog.status).toBe('fresh'); expect(catalog.chains.map(c=>c.chainId)).toEqual([8453]); expect(catalog.warnings.join()).toContain('Arbitrum');
    h.io.protocol = async () => catalog;
    expect((await validateRoute({ sourceChain:8453,destinationChain:42161,bridgeAddress:TOKEN,tokenAddress:TOKEN },h.io)).configurationStatus).toBe('UNKNOWN');
  });
  it('rejects a read-only network before RPC or wallet work', async () => {
    const chain = CHAINS.find(c=>c.sourceRestriction)!; const h = transferHarness();
    await expect(prepareTransfer({ ...transferInput, walletChainId: chain.id, route: { ...transferInput.route, sourceChain: chain.id } },h.io)).rejects.toMatchObject({ code:'UNSUPPORTED_NETWORK' });
    expect(h.io.rpc).not.toHaveBeenCalled();
  });
});
describe('M7 fees and finality', () => {
  it('adds OP data/operator budgets without changing OFT nativeFee or msg.value', async () => {
    const h=opHarness(), plan=await prepareTransfer(h.input,h.io);
    expect(plan.simulation.status).toBe('passed');
    expect(plan.gas?.additionalBudgetWei).toBe('1560000000000');
    expect(BigInt(plan.gas!.totalNativeBudgetWei)).toBe(h.values.nativeFee + 240000n*h.values.gasPrice + 1560000000000n);
    expect(plan.transaction.value).toBe(h.values.nativeFee.toString());
    const calls = vi.mocked(h.io.rpc).mock.calls.filter(([,m,p])=>m==='eth_call' && (p[0] as {to:string}).to===OP_ORACLE);
    const sizeCall = calls.map(([, , p])=>decodeFunctionData({ abi: OP_FEE_ABI, data: (p[0] as {data:`0x${string}`}).data })).find(d=>d.functionName==='getL1FeeUpperBound');
    expect(sizeCall!.args[0]).toBeGreaterThan(BigInt((plan.transaction.data.length-2)/2));
  });
  it('includes additional costs for token approval, and rechecks them before send', async () => {
    const h=opHarness();
    h.contracts[8453][TOKEN].approvalRequired = true;
    h.contracts[8453][TOKEN].approve = true;
    const approval = await prepareExecution(h.input,h.io);
    expect(approval.kind).toBe('approve'); expect(approval.gasBudget?.additionalBudgetWei).toBe('1560000000000');
    h.values.allowance = 10n**22n;
    const review = await prepareExecution(h.input,h.io);
    const wallet: RabbySession = { uid: h.input.providerUid, executionMode: 'live', assertCurrent: vi.fn(), request: vi.fn(async ({method})=>method==='eth_accounts' ? [SENDER] : '0x2105') };
    const store = { list:vi.fn(async()=>[]), reserve:vi.fn(), put:vi.fn() };
    h.fee.data = h.values.nativeBalance;
    await expect(submitExecution(review,wallet,h.io,store)).rejects.toMatchObject({code:'NETWORK_FEE_CHANGED'});
    expect(store.reserve).not.toHaveBeenCalled(); expect(vi.mocked(wallet.request).mock.calls.some(([a])=>a.method==='eth_sendTransaction')).toBe(false);
  });
  it('does not treat missing OP oracle fees as zero or reuse a previous fee', async () => {
    const h=opHarness(); h.fee.fail=true;
    await expect(estimateNetworkGas(8453,call,h.io)).rejects.toMatchObject({code:'NETWORK_FEE_UNAVAILABLE'});
  });
  it('does not double-count Arbitrum L1 costs already included in gas estimation', async () => {
    const rpc=vi.fn(); expect(await additionalNetworkFee(42161,call,100000n,100n,{rpc})).toMatchObject({additionalBudgetWei:'0'}); expect(rpc).not.toHaveBeenCalled();
  });
  it.each(['unsupported','malformed','hash-mismatch'])('blocks %s finality before approval/signing', async mode => {
    const h=opHarness(), original=h.io.rpc;
    h.io.rpc=vi.fn(async(id,m,p)=> {
      if (id===42161 && m==='eth_getBlockByNumber') {
        if(mode==='unsupported') throw new Error('unsupported finalized');
        if(mode==='malformed') return null;
        return { number:'0x10', hash: pad(p[0]==='finalized'?'0x11':'0x12') };
      }
      return original(id,m,p);
    });
    await expect(prepareExecution(h.input,h.io)).rejects.toMatchObject({code:'FINALITY_UNAVAILABLE'});
  });
  it('verifies a finalized hash against the same numbered block', async () => {
    const rpc=vi.fn(async()=>({number:'0x42',hash:pad('0x11')}));
    await assertFinalityAvailable(8453,{rpc}); expect(rpc.mock.calls).toEqual([[8453,'eth_getBlockByNumber',['finalized',false]],[8453,'eth_getBlockByNumber',['0x42',false]]]);
  });
});
