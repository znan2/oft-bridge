import { describe, expect, it, vi } from 'vitest';
import type { ExecutionRecord } from '../shared/execution';
import { trackExecution, attachSourceHash, type TrackingIO } from '../src/lib/tracking';
import { parseScan } from '../server/scan';
import fixture from './fixtures/m5-dos-tracking.json';
const hash = fixture.record.hash;
function harness() {
  const record = structuredClone(fixture.record) as ExecutionRecord;
  const responses = structuredClone(fixture.responses);
  const scan = { checkedAt: new Date().toISOString(), messages: parseScan(structuredClone(fixture.scan)) };
  const io: TrackingIO = { rpc: vi.fn(async (chain, method, params) => {
    const found = responses.find(r => r.chain === chain && r.method === method && JSON.stringify(r.params) === JSON.stringify(params));
    // The old fixture predates the canonical-finalized lookup. Mock that new
    // request explicitly; this is not additional historical RPC evidence.
    const finalized = responses.find(r => r.chain === chain && r.method === 'eth_getBlockByNumber' && r.params[0] === 'finalized')?.response.result as any;
    if (!found && method === 'eth_getBlockByNumber' && params[0] === finalized?.number) return structuredClone(finalized);
    if (!found) throw new Error(`unhandled ${chain} ${method}`); return structuredClone(found.response.result);
  }), scan: vi.fn(async () => scan) };
  const result = (chain: number, method: string, predicate = (_: unknown[]) => true): any => responses.find(r => r.chain === chain && r.method === method && predicate(r.params))!.response.result;
  return { record, responses, io, scan, result };
}
describe('M5 evidence-based tracking', () => {
  it('proves historical DOS source and destination including exact recipient and amount (synthetic 437 tokens)', async () => {
    const h = harness(); const row = await trackExecution(h.record, h.io);
    expect(row.status, row.trackingError).toBe('delivered'); expect(row.guid).toBe(fixture.result.guid); expect(row.destinationAmountLD).toBe('437000000000000000000');
  });
  it('chooses the exact GUID and pathway from several Scan messages', async () => {
    const h = harness(); h.scan.messages.unshift({ ...h.scan.messages[0], guid: `0x${'9'.repeat(64)}`, destinationHash: `0x${'e'.repeat(64)}` });
    expect((await trackExecution(h.record, h.io)).destinationHash).toBe(fixture.result.destinationHash);
  });
  it.each(['guid','sender','receiver','srcEid','dstEid','sourceHash'])('does not use unrelated Scan %s evidence', async field => {
    const h = harness(); (h.scan.messages[0] as any)[field] = field.endsWith('Eid') ? 99999 : `0x${'9'.repeat(field === 'sender' || field === 'receiver' ? 40 : 64)}`;
    const row = await trackExecution(h.record,h.io); expect(row.status).toBe('destination-pending'); expect(row.destinationHash).toBeUndefined();
  });
  it('does not report success from a Scan DELIVERED label without destination receipt', async () => {
    const h = harness(), original=h.io.rpc; h.io.rpc=async(c,m,p)=>c===1&&m==='eth_getTransactionReceipt'?null:original(c,m,p);
    expect((await trackExecution(h.record,h.io)).status).toBe('destination-pending');
  });
  it('reports Scan unavailability separately and still verifies a manually provided destination hash', async () => {
    const h = harness(); h.io.scan=async()=>{throw new Error('LayerZero Scan 조회 오류');};
    const first=await trackExecution(h.record,h.io); expect(first.status).toBe('source-confirmed'); expect(first.trackingError).toContain('Scan');
    h.record.destinationHash=fixture.result.destinationHash; const row=await trackExecution(h.record,h.io); expect(row.status).toBe('delivered'); expect(row.trackingError).toContain('Scan');
  });
  it('verifies a manual destination hash instead of overwriting it with stale Scan data', async () => {
    const h = harness();
    h.record.destinationHash = fixture.result.destinationHash; h.record.destinationHashSource = 'manual';
    h.scan.messages[0].destinationHash = `0x${'d'.repeat(64)}`;
    const row = await trackExecution(h.record, h.io);
    expect(row.status, row.trackingError).toBe('delivered');
    expect(row.destinationHash).toBe(fixture.result.destinationHash);
    expect(row.destinationHashSource).toBe('manual');
  });
  it('keeps indexing delay pending and delivery failure distinct from source failure', async () => {
    const h=harness(); h.scan.messages=[]; expect((await trackExecution(h.record,h.io)).status).toBe('destination-pending');
    const f=harness(); f.scan.messages[0].status='FAILED'; f.scan.messages[0].destinationHash=undefined; expect((await trackExecution(f.record,f.io)).status).toBe('destination-failed');
  });
  it('requires both chains finalized before completion', async () => {
    for (const chain of [1,56]) { const h=harness(); h.result(chain,'eth_getBlockByNumber',p=>p[0]==='finalized').number='0x1'; expect((await trackExecution(h.record,h.io)).status).toBe('destination-confirming'); }
  });
  it('clears old evidence if a source block is no longer canonical', async () => {
    const h=harness(); h.record={...h.record,...fixture.result} as ExecutionRecord;
    h.result(56,'eth_getBlockByNumber',p=>p[0]!=='finalized').hash=`0x${'8'.repeat(64)}`;
    const row=await trackExecution(h.record,h.io); expect(row.status).toBe('pending'); expect(row.guid).toBeUndefined(); expect(row.sourceFinalized).toBe(false);
  });
  it.each([1, 56])('does not complete when chain %s finalized hash disagrees with its numbered block', async chain => {
    const h = harness(), original = h.io.rpc;
    const finalized = h.result(chain, 'eth_getBlockByNumber', p => p[0] === 'finalized');
    h.io.rpc = async (c, m, p) => c === chain && m === 'eth_getBlockByNumber' && p[0] === finalized.number
      ? { ...finalized, hash: `0x${'9'.repeat(64)}` } : original(c, m, p);
    const row = await trackExecution({ ...h.record, ...fixture.result } as ExecutionRecord, h.io);
    expect(row.status).not.toBe('delivered');
    expect(row.destinationAmountLD).toBeUndefined();
    expect(row.trackingError).toContain('확정 블록 해시 불일치');
    if (chain === 56) expect(row.sourceFinalized).toBe(false);
  });
  it.each([1, 56])('rejects a zero finalized block hash on chain %s', async chain => {
    const h = harness();
    h.result(chain, 'eth_getBlockByNumber', p => p[0] === 'finalized').hash = `0x${'0'.repeat(64)}`;
    const row = await trackExecution(h.record, h.io);
    expect(row.status).not.toBe('delivered'); expect(row.trackingError).toContain('확정');
  });
  it('reports a failed source receipt only after finality', async () => {
    const h=harness(); h.result(56,'eth_getTransactionReceipt').status='0x0';
    expect((await trackExecution(h.record,h.io)).status).toBe('source-failed'); expect(h.io.scan).not.toHaveBeenCalled();
  });
  it.each(['from','nonce','input','value'])('detects changed transaction %s', async field => {
    const h=harness(); const tx=h.result(56,'eth_getTransactionByHash'); tx[field]=field==='from'?`0x${'4'.repeat(40)}`:field==='input'?'0x':'0x0';
    if(field==='from') h.result(56,'eth_getTransactionReceipt').from=tx.from;
    const row=await trackExecution(h.record,h.io);
    if(field==='from'||field==='nonce') expect(row.trackingError).toBeTruthy(); else expect(row.status).toBe('replaced');
    expect(row.status).not.toBe('delivered');
  });
  it.each(['OFTReceived','Transfer','Endpoint'])('requires destination %s evidence', async kind => {
    const h=harness(); const receipt=h.result(1,'eth_getTransactionReceipt');
    if(kind==='Endpoint') receipt.logs=receipt.logs.filter((l:any)=>l.address.toLowerCase()!==h.record.review.plan.route.destination!.identity!.endpoint.toLowerCase());
    else if(kind==='Transfer') receipt.logs=receipt.logs.filter((l:any)=>l.topics[0]!=='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
    // Remove the OFTReceived log using its unique non-indexed data size.
    if(kind==='OFTReceived') receipt.logs=receipt.logs.filter((l:any)=>l.data.length!==130);
    const row=await trackExecution(h.record,h.io); expect(row.status).not.toBe('delivered'); expect(row.trackingError).toBeTruthy();
  });
  it('requires destination recipient and source shared quantity agreement', async () => {
    const h=harness(); h.record.review.plan.input.recipient=`0x${'4'.repeat(40)}`; expect((await trackExecution(h.record,h.io)).status).not.toBe('delivered');
  });
  it('links a lost-response hash by source account and nonce and rejects unrelated hashes', async () => {
    const h=harness(); h.record.hash=undefined; const row=await attachSourceHash(h.record,hash,h.io); expect(row.hash).toBe(hash);
    h.record.nonce='999999'; await expect(attachSourceHash(h.record,hash,h.io)).rejects.toThrow('nonce');
  });
  it('clears prior delivery evidence when reconnecting a source hash', async () => {
    const h = harness();
    const next = await attachSourceHash({ ...h.record, ...fixture.result } as ExecutionRecord, hash, h.io);
    expect(next.status).toBe('pending'); expect(next.sourceFinalized).toBe(false);
    for (const field of ['guid', 'destinationHash', 'destinationHashSource', 'destinationAmountLD', 'actualSentLD', 'actualReceivedLD', 'scanStatus'] as const) expect(next[field]).toBeUndefined();
  });
  it('rejects a source hash whose transaction names another chain', async () => {
    const h = harness(); h.result(56, 'eth_getTransactionByHash').chainId = '0x1';
    await expect(attachSourceHash(h.record, hash, h.io)).rejects.toThrow();
  });
  it('recovers saved history after RPC service is restored without a new send', async () => {
    const h = harness();
    const failed = await trackExecution(h.record, { ...h.io, rpc: async () => { throw new Error('RPC 오류'); } });
    expect(failed.trackingError).toContain('RPC 오류'); expect(failed.hash).toBe(hash);
    const reloaded = JSON.parse(JSON.stringify(failed)) as ExecutionRecord;
    expect((await trackExecution(reloaded, h.io)).status).toBe('delivered');
    expect(vi.mocked(h.io.rpc).mock.calls.some(([, method]) => /sendTransaction|sign/i.test(method))).toBe(false);
  });
  it('does not turn RPC failure into a transfer failure', async () => {
    const h=harness(); h.io.rpc=async()=>{throw new Error('RPC 오류 — BSC');}; const row=await trackExecution(h.record,h.io); expect(row.status).toBe('pending'); expect(row.trackingError).toContain('RPC 오류');
  });
});
