import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, pad, parseAbiParameters, type Address, type Hex } from 'viem';
import fixture from './fixtures/drv-ethereum-receive.json';
import { OFT_RECEIVE_ABI } from '../shared/oft-abi';
import { PROTOCOL } from '../shared/protocol';
import { discover } from '../src/lib/discovery';
import { messageGuid, transactionHash } from '../src/lib/transaction-candidates';
import { erc20, oft, harness, TOKEN, OTHER } from './helpers/discovery';
const bridge = fixture.tokenAddress;
const recipient = '0xca20100000000000000000000000000000000003';
function receiveHarness(adapter = false) {
  const tx = structuredClone(fixture.transaction), receipt = structuredClone(fixture.receipt);
  const token = adapter ? TOKEN : bridge;
  const contracts: Record<string, Record<string, unknown>> = { [bridge]: { ...oft(token), endpoint: PROTOCOL[1].endpoint, approvalRequired: adapter }, [TOKEN]: erc20(), [OTHER]: { ...oft(token), endpoint: PROTOCOL[1].endpoint, approvalRequired: adapter } };
  if (adapter) { receipt.logs[0].address = token; receipt.logs[0].topics[1] = pad(bridge as Hex); }
  const io = harness(contracts), normal = io.rpc;
  io.rpc = vi.fn(async (method, params) => method === 'eth_getTransactionByHash' ? tx : method === 'eth_getTransactionReceipt' ? receipt : normal(method, params));
  return { io, tx, receipt, contracts, request: { chainId: 1 as const, tokenAddress: token, transactionHash: tx.hash } };
}
function extraReceive(emitter: Address, token: Address, nonce: bigint) {
  const origin = { srcEid: 30311, sender: pad(OTHER), nonce };
  const guid = messageGuid(nonce, origin.srcEid, origin.sender, 30101, emitter);
  const base = { ...fixture.receipt.logs[0] };
  return [
    { ...base, address: token, topics: encodeEventTopics({ abi: OFT_RECEIVE_ABI, eventName: 'Transfer', args: { from: emitter, to: recipient } }) as Hex[], data: encodeAbiParameters(parseAbiParameters('uint256'), [123n]) },
    { ...base, address: emitter, topics: encodeEventTopics({ abi: OFT_RECEIVE_ABI, eventName: 'OFTReceived', args: { guid, toAddress: recipient } }) as Hex[], data: encodeAbiParameters(parseAbiParameters('uint32,uint256'), [origin.srcEid, 123n]) },
    { ...base, address: PROTOCOL[1].endpoint, topics: encodeEventTopics({ abi: OFT_RECEIVE_ABI, eventName: 'PacketDelivered' }) as Hex[], data: encodeAbiParameters(parseAbiParameters('(uint32 srcEid,bytes32 sender,uint64 nonce),address'), [origin, emitter]) },
  ];
}
describe('successful OFT receive transaction recovery', () => {
  it('uses the real DRV receive emitter rather than the executor tx.to, with no catalog or past fee reuse', async () => {
    const h = receiveHarness(), result = await discover(h.request, h.io);
    expect(result.status).toBe('found');
    expect(result.candidates[0].address.toLowerCase()).toBe(bridge);
    expect(result.candidates[0].address.toLowerCase()).not.toBe(h.tx.to);
    expect(result.transaction).toMatchObject({ kind: 'receive', srcEid: 30311, guid: fixture.receipt.logs[1].topics[1] });
    expect(result.transaction).not.toHaveProperty('amountReceivedLD');
    expect(result.transaction).not.toHaveProperty('dstEid');
    expect(result.chainId).toBe(1); expect(result.candidates[0].identity?.kind).toBe('OFT');
    expect(h.io.catalog).not.toHaveBeenCalled();
    expect(h.io.store.save).toHaveBeenCalledWith(expect.objectContaining({ chainId: 1, source: 'transaction', transactionHash: h.tx.hash }));
    expect(vi.mocked(h.io.rpc).mock.calls.some(([m]) => /send|sign|estimateGas/i.test(m))).toBe(false);
  });
  it('recovers an adapter for an ordinary ERC20 from a successful lockbox receive', async () => {
    const h = receiveHarness(true), result = await discover(h.request, h.io);
    expect(result.status).toBe('found');
    expect(result.candidates[0].identity).toMatchObject({ kind: 'OFTAdapter', approvalRequired: true, token: { address: TOKEN } });
    expect(h.io.store.save).toHaveBeenCalledWith(expect.objectContaining({ tokenAddress: TOKEN, bridgeAddress: expect.any(String) }));
  });
  it('revalidates current token() and refuses an adapter whose token binding changed', async () => {
    const h = receiveHarness(true); h.contracts[bridge].token = OTHER;
    const result = await discover(h.request, h.io);
    expect(result.candidates[0].status).toBe('mismatch'); expect(h.io.store.save).not.toHaveBeenCalled();
  });
  it('returns multiple supported emitters as candidates instead of choosing the first event', async () => {
    const h = receiveHarness(true); h.receipt.logs.push(...extraReceive(OTHER, TOKEN, 7n));
    const result = await discover(h.request, h.io);
    expect(result.status).toBe('multiple'); expect(result.candidates).toHaveLength(2); expect(result.transactions).toHaveLength(2);
    expect(result.transaction).toBeUndefined();
    expect(vi.mocked(h.io.store.save).mock.calls.every(([c]) => c.transactionHash === h.tx.hash)).toBe(true);
  });
  it('deduplicates repeated evidence for the same emitter and GUID', async () => {
    const h = receiveHarness(); h.receipt.logs.push(structuredClone(h.receipt.logs[1]));
    const result = await discover(h.request, h.io);
    expect(result.candidates).toHaveLength(1); expect(result.transactions).toHaveLength(1);
  });
  it.each(['failed', 'missing-oft', 'missing-delivery', 'foreign-endpoint', 'wrong-guid', 'wrong-eid', 'no-credit', 'wrong-amount', 'wrong-recipient', 'wrong-credit-from', 'removed', 'log-block', 'log-hash', 'receipt-block', 'wrong-chain', 'malformed-event'])('rejects %s receive evidence without saving a candidate', async variant => {
    const h = receiveHarness(true);
    if (variant === 'failed') h.receipt.status = '0x0';
    if (variant === 'missing-oft') h.receipt.logs.splice(1, 1);
    if (variant === 'missing-delivery') h.receipt.logs.splice(2, 1);
    if (variant === 'foreign-endpoint') h.receipt.logs[2].address = OTHER;
    if (variant === 'wrong-guid') h.receipt.logs[1].topics[1] = pad('0x01');
    if (variant === 'wrong-eid') h.receipt.logs[1].data = encodeAbiParameters(parseAbiParameters('uint32,uint256'), [30102, BigInt(h.receipt.logs[0].data)]);
    if (variant === 'no-credit') h.receipt.logs.splice(0, 1);
    if (variant === 'wrong-amount') h.receipt.logs[0].data = pad('0x01');
    if (variant === 'wrong-recipient') h.receipt.logs[0].topics[2] = pad(OTHER);
    if (variant === 'wrong-credit-from') h.receipt.logs[0].topics[1] = pad(OTHER);
    if (variant === 'removed') h.receipt.logs[1].removed = true;
    if (variant === 'log-block') h.receipt.logs[1].blockHash = pad('0x01');
    if (variant === 'log-hash') h.receipt.logs[1].transactionHash = pad('0x01');
    if (variant === 'receipt-block') h.receipt.blockHash = pad('0x01');
    if (variant === 'wrong-chain') h.tx.chainId = '0x38';
    if (variant === 'malformed-event') h.receipt.logs[1].data += '00';
    expect((await discover(h.request, h.io)).status).toBe('transaction-error');
    expect(h.io.store.save).not.toHaveBeenCalled();
  });
  it('rejects a different input token even when the transaction received another OFT', async () => {
    const h = receiveHarness();
    expect((await discover({ ...h.request, tokenAddress: TOKEN }, h.io)).status).toBe('transaction-error');
    expect(h.io.store.save).not.toHaveBeenCalled();
  });
  it('keeps receipt RPC outages distinct from missing OFT evidence', async () => {
    const h = receiveHarness(), original = h.io.rpc;
    h.io.rpc = async (m, p) => { if (m === 'eth_getTransactionReceipt') throw new Error('public RPC unavailable'); return original(m, p); };
    expect((await discover(h.request, h.io)).status).toBe('rpc-error'); expect(h.io.store.save).not.toHaveBeenCalled();
  });
  it('rejects a transaction with too many distinct emitters without truncating the choice', async () => {
    const h = receiveHarness(true);
    for (let i = 1; i <= 20; i++) h.receipt.logs.push(...extraReceive(pad(`0x${i.toString(16).padStart(2, '0')}`, { size: 20 }), TOKEN, BigInt(i)));
    const result = await discover(h.request, h.io);
    expect(result.status).toBe('transaction-error'); expect(result.message).toContain('후보가 너무 많'); expect(h.io.store.save).not.toHaveBeenCalled();
  });
});
describe('transaction reference input', () => {
  it('accepts a hash or matching explorer URL, extracting only the hash', () => {
    expect(transactionHash(` ${fixture.transaction.hash} `, 1)).toBe(fixture.transaction.hash);
    expect(transactionHash(fixture.sourceUrl + '?foo=1#eventlog', 1)).toBe(fixture.transaction.hash);
  });
  it.each([fixture.sourceUrl.replace('etherscan.io', 'bscscan.com'), fixture.sourceUrl.replace('etherscan.io', 'evil.test'), fixture.sourceUrl.replace('https:', 'http:'), fixture.sourceUrl.replace('/tx/', '/address/'), '0x1234'])('rejects invalid or wrong-chain reference %s before any RPC', async reference => {
    const h = receiveHarness();
    expect((await discover({ ...h.request, transactionHash: reference }, h.io)).status).toBe('input-error'); expect(h.io.rpc).not.toHaveBeenCalled();
  });
});
