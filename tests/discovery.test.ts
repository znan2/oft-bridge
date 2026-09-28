import { describe, it, expect, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, zeroAddress, type Hex } from 'viem';
import { discover, RpcCallError } from '../src/lib/discovery';
import { OFT_SEND_ABI } from '../shared/oft-abi';
import historical from './fixtures/dos-bsc-ethereum.json';
import { TOKEN, BRIDGE, OTHER, catalog, erc20, oft, harness } from './helpers/discovery';

const input = { chainId: 56 as const, tokenAddress: TOKEN };
const deployment = (address = BRIDGE) => ({ chainId: 56 as const, address, tokenAddress: TOKEN, symbol: 'TEST', name: 'Test', declaredType: 'OFT_ADAPTER', endpointVersion: 'v2' });
describe('OFT identity discovery', () => {
  it('identifies direct OFT at one block, without producing a transfer or route guarantee', async () => {
    const io = harness({ [TOKEN]: oft() });
    const result = await discover(input, io);
    expect(result).toMatchObject({ status: 'found', blockNumber: '0x100', candidates: [{ identity: { kind: 'OFT', approvalRequired: false, sharedDecimals: 6, token: { decimals: 18 } } }] });
    const reads = vi.mocked(io.rpc).mock.calls.filter(([m]) => ['eth_getCode', 'eth_call'].includes(m));
    expect(reads.every(([, p]) => p[1] === '0x100')).toBe(true);
    expect(vi.mocked(io.rpc).mock.calls.some(([m]) => /send|estimateGas|sign/i.test(m))).toBe(false);
    expect(result).not.toHaveProperty('sendParam');
  });
  it('finds multiple adapters from metadata, deduplicates addresses and verifies token binding', async () => {
    const io = harness({ [TOKEN]: erc20(), [BRIDGE]: { ...oft(), approvalRequired: true }, [OTHER]: oft() });
    vi.mocked(io.catalog).mockResolvedValue({ ...catalog(), deployments: [deployment(), deployment(), deployment(OTHER)] });
    const result = await discover(input, io);
    expect(result.status).toBe('multiple');
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.every(c => c.identity?.kind === 'OFTAdapter')).toBe(true);
  });
  it('also accepts an adapter CA directly and separates its underlying token', async () => {
    const result = await discover({ ...input, tokenAddress: BRIDGE }, harness({ [BRIDGE]: oft(), [TOKEN]: erc20() }));
    expect(result).toMatchObject({ status: 'found', token: { address: TOKEN }, candidates: [{ identity: { bridgeAddress: BRIDGE, kind: 'OFTAdapter' } }] });
  });
  it('reports exact not-found text for an ordinary ERC20, and no-code separately', async () => {
    expect(await discover(input, harness({ [TOKEN]: erc20() }))).toMatchObject({ status: 'not-found', message: 'Pool 컨트랙트를 찾지 못했습니다.' });
    expect((await discover(input, harness({}))).status).toBe('no-code');
  });
  it('validates user input before making any RPC requests', async () => {
    const io = harness({});
    expect((await discover({ ...input, tokenAddress: 'invalid' }, io)).status).toBe('input-error');
    expect((await discover({ ...input, manualAddress: 'bad' }, io)).status).toBe('input-error');
    expect(io.rpc).not.toHaveBeenCalled();
  });
  it.each([
    ['native adapter', { token: zeroAddress }],
    ['unknown interface', { oftVersion: ['0x12345678', 1n] }],
    ['new message version', { oftVersion: ['0x02e49c2c', 2n] }],
    ['invalid decimals', { sharedDecimals: 19 }],
    ['Stargate Pool', { stargateType: 0 }],
    ['Stargate OFT', { stargateType: 1 }],
    ['missing approval interface', { approvalRequired: undefined }],
  ])('rejects unsupported %s', async (_, override) => {
    const result = await discover(input, harness({ [TOKEN]: { ...oft(), ...override } }));
    expect(result.status).toBe('unsupported');
    expect(result.candidates.some(c => c.status === 'identified')).toBe(false);
  });
  it('does not treat transport/provider errors as absent methods', async () => {
    for (const error of [new Error('offline'), new RpcCallError(-32005, 'limit exceeded')]) {
      const result = await discover(input, harness({ [TOKEN]: { ...erc20(), endpoint: error } }));
      expect(result.status).toBe('rpc-error');
      expect(result.message).toContain('RPC 오류');
    }
  });
  it('can identify a direct OFT during metadata outage but reports incomplete automatic lookup for an ERC20', async () => {
    for (const contract of [oft(), erc20()]) {
      const io = harness({ [TOKEN]: contract });
      vi.mocked(io.catalog).mockRejectedValue(new Error('offline'));
      const result = await discover(input, io);
      expect(result.status).toBe('token' in contract ? 'found' : 'metadata-error');
      expect(result.warnings.length).toBeGreaterThan(0);
    }
  });
  it('manual candidates work independently of metadata and are saved only after token validation', async () => {
    const io = harness({ [TOKEN]: erc20(), [BRIDGE]: { ...oft(), approvalRequired: true } });
    const result = await discover({ ...input, manualAddress: BRIDGE }, io);
    expect(result.status).toBe('found');
    expect(io.catalog).not.toHaveBeenCalled();
    expect(io.store.save).toHaveBeenCalledWith(expect.objectContaining({ tokenAddress: TOKEN, bridgeAddress: BRIDGE, source: 'manual' }));
    const bad = harness({ [TOKEN]: erc20(), [BRIDGE]: oft(OTHER), [OTHER]: erc20() });
    const mismatch = await discover({ ...input, manualAddress: BRIDGE }, bad);
    expect(mismatch.candidates[0].status).toBe('mismatch');
    expect(bad.store.save).not.toHaveBeenCalled();
  });
  it('revalidates saved candidates and does not reuse stale identity results', async () => {
    const io = harness({ [TOKEN]: erc20(), [BRIDGE]: oft(OTHER), [OTHER]: erc20() });
    vi.mocked(io.store.list).mockResolvedValue([{ id: 'test', chainId: 56, tokenAddress: TOKEN, bridgeAddress: BRIDGE, source: 'manual', savedAt: new Date().toISOString() }]);
    const result = await discover(input, io);
    expect(result.status).toBe('not-found');
    expect(result.candidates[0].status).toBe('mismatch');
  });
  it('keeps a successful current identity when local persistence fails', async () => {
    const io = harness({ [TOKEN]: erc20(), [BRIDGE]: oft() });
    vi.mocked(io.store.save).mockRejectedValue(new Error('storage disabled'));
    const result = await discover({ ...input, manualAddress: BRIDGE }, io);
    expect(result.status).toBe('found');
    expect(result.warnings.join(' ')).toContain('저장하지 못했습니다');
  });
  it('propagates cancellation even when a transport ignores AbortSignal', async () => {
    const io = harness({ [TOKEN]: oft() });
    const controller = new AbortController();
    vi.mocked(io.rpc).mockImplementationOnce(async () => { controller.abort(); return '0x1'; });
    await expect(discover(input, io, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

function txHarness() {
  const bridge = historical.transaction.to;
  const blockHash = `0x${'ab'.repeat(32)}`;
  const tx = { ...historical.transaction, blockHash };
  const receipt = { status: '0x1', transactionHash: tx.hash, to: tx.to, from: tx.from, blockNumber: tx.blockNumber, blockHash, logs: [{
    address: bridge, transactionHash: tx.hash, blockHash, blockNumber: tx.blockNumber,
    topics: encodeEventTopics({ abi: OFT_SEND_ABI, eventName: 'OFTSent', args: { guid: historical.layerZero.guid as Hex, fromAddress: tx.from as Hex } }),
    data: encodeAbiParameters(parseAbiParameters('uint32, uint256, uint256'), [30101, 437000000000000000000n, 437000000000000000000n]),
  }] };
  const io = harness({ [bridge]: oft(bridge) });
  const normal = io.rpc;
  io.rpc = vi.fn(async (method, params) => method === 'eth_getTransactionByHash' ? tx : method === 'eth_getTransactionReceipt' ? receipt : normal(method, params));
  return { io, tx, receipt, request: { chainId: 56 as const, tokenAddress: bridge, transactionHash: tx.hash } };
}
describe('successful source transaction recovery', () => {
  it('round-trips the actual DOS send calldata and extracts only candidate/evidence fields', async () => {
    const { io, request } = txHarness();
    const result = await discover(request, io);
    expect(result.status).toBe('found');
    expect(result.transaction).toMatchObject({ guid: historical.layerZero.guid, dstEid: 30101 });
    expect(result.transaction).not.toHaveProperty('amountLD');
    expect(JSON.stringify(result)).not.toContain(historical.decodedSend.fee.nativeFee);
    expect(io.store.save).toHaveBeenCalledWith(expect.objectContaining({ source: 'transaction', transactionHash: request.transactionHash }));
  });
  it.each(['reverted', 'foreign-emitter', 'non-send', 'wrong-chain', 'receipt-mismatch'])('rejects %s transactions', async (variant) => {
    const { io, tx, receipt, request } = txHarness();
    if (variant === 'reverted') receipt.status = '0x0';
    if (variant === 'foreign-emitter') receipt.logs[0].address = OTHER;
    if (variant === 'non-send') tx.input = '0x12345678';
    if (variant === 'wrong-chain') tx.chainId = '0x1';
    if (variant === 'receipt-mismatch') receipt.blockHash = `0x${'cd'.repeat(32)}`;
    expect((await discover(request, io)).status).toBe('transaction-error');
    expect(io.store.save).not.toHaveBeenCalled();
  });
  it('does not use the transaction recipient when receipt retrieval fails', async () => {
    const { io, request } = txHarness();
    const normal = io.rpc;
    io.rpc = vi.fn(async (method, params) => { if (method === 'eth_getTransactionReceipt') throw new Error('archive unavailable'); return normal(method, params); });
    expect((await discover(request, io)).status).toBe('rpc-error');
    expect(io.store.save).not.toHaveBeenCalled();
  });
});
