import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executionStore, validExecution } from '../src/lib/execution-store';
import type { ExecutionRecord } from '../shared/execution';
import fixture from './fixtures/m5-dos-tracking.json';
function row(id: string): ExecutionRecord { return { ...structuredClone(fixture.record) as ExecutionRecord, id, status: 'wallet-pending', hash: undefined }; }
beforeEach(async () => { await new Promise<void>((resolve,reject)=>{const r=indexedDB.deleteDatabase('oft-bridge-executions');r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error);}); });
describe('persistent execution intent', () => {
  it('does not let an old tracker overwrite a manually replaced hash, even in the same millisecond', async () => {
    const a = { ...row('race'), hash: fixture.record.hash, status: 'pending' as const };
    await executionStore.reserve(a);
    const snapshot = (await executionStore.list())[0];
    const replacement = { ...snapshot, hash: `0x${'c'.repeat(64)}`, detail: '사용자가 연결한 교체 거래' };
    await executionStore.put(replacement, snapshot);
    const stale = { ...snapshot, status: 'source-confirmed' as const, detail: '늦게 도착한 이전 해시 응답' };
    expect(await executionStore.put(stale, snapshot)).toBe(false);
    expect((await executionStore.list())[0].hash).toBe(replacement.hash);
  });
  it('atomically reserves only one unresolved request across concurrent callers', async () => { const results=await Promise.allSettled([executionStore.reserve(row('a')),executionStore.reserve(row('b'))]); expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1); expect(await executionStore.list()).toHaveLength(1); });
  it('allows exactly one concurrent update of a legacy record without a revision', async () => {
    const a = row('cas'); await executionStore.reserve(a);
    const results = await Promise.all([executionStore.put({ ...a, detail: 'first' }, a), executionStore.put({ ...a, detail: 'second' }, a)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await executionStore.list())[0].storageRevision).toBe(1);
  });
  it('retains hashes for reload and unlocks after explicit rejection', async () => { const a=row('a');await executionStore.reserve(a);await executionStore.put({...a,status:'rejected'});await executionStore.reserve(row('b'));expect(await executionStore.list()).toHaveLength(2); });
  it('validates persisted records and never replays a stored request', async () => { expect(validExecution(row('a'))).toBe(true); expect(validExecution({...row('a'),nonce:'NaN'})).toBe(false);await expect(executionStore.reserve({...row('a'),hash:'bad'})).rejects.toThrow(); });
  it('rejects corrupted receipt amounts and finality flags before display or unlocking', () => {
    for (const field of ['actualSentLD', 'actualReceivedLD', 'destinationAmountLD']) expect(validExecution({ ...row('bad'), [field]: 'NaN' })).toBe(false);
    expect(validExecution({ ...row('bad'), sourceFinalized: 'false' })).toBe(false);
    expect(validExecution({ ...row('bad'), storageRevision: -1 })).toBe(false);
  });
  it('retains a returned hash outside the form after a storage write failure', async () => {
    const a=row('recover'); await executionStore.reserve(a);
    const sent={...a,hash:fixture.record.hash,status:'pending' as const};
    const fail=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementationOnce(()=>{throw new Error('quota');});
    await expect(executionStore.put(sent, a)).rejects.toThrow('quota'); fail.mockRestore();
    const recovered=(await executionStore.list()).find(r=>r.id===a.id)!;
    expect(recovered.hash).toBe(sent.hash); expect(recovered.trackingError).toContain('저장 실패');
    expect(await executionStore.put({ ...recovered, trackingError: undefined }, recovered)).toBe(true);
    expect((await executionStore.list()).find(r=>r.id===a.id)?.trackingError).toBeUndefined();
  });
  it('blocks unreadable history rather than silently unlocking a possibly pending request',async()=>{
    await executionStore.reserve(row('a'));
    const db=await new Promise<IDBDatabase>(resolve=>{const r=indexedDB.open('oft-bridge-executions');r.onsuccess=()=>resolve(r.result);});
    await new Promise<void>(resolve=>{const tx=db.transaction('executions','readwrite');tx.objectStore('executions').put({...row('a'),nonce:'corrupt'});tx.oncomplete=()=>resolve();});db.close();
    await expect(executionStore.list()).rejects.toThrow('해석');await expect(executionStore.reserve(row('b'))).rejects.toThrow('해석');
  });
  it('keeps an unknown wallet result locked until it is reconciled', async()=>{await executionStore.reserve({...row('a'),status:'unknown'});await expect(executionStore.reserve(row('b'))).rejects.toThrow('미확정');});
});
