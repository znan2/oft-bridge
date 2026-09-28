import { isAddress } from 'viem';
import { blockingExecution, pendingExecutionMessage, type ExecutionRecord, type ExecutionStore } from '../../shared/execution';
import { isChainId } from '../../shared/chains';
const DB = 'oft-bridge-executions';
// Preserve a returned hash across component unmounts if an IndexedDB write fails.
const emergency = new Map<string, ExecutionRecord>();
const BACKUP = 'oft-execution-recovery:';
function recoveryRows() {
  if (typeof localStorage !== 'undefined') {
    try { for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      if (key.startsWith(BACKUP)) { const row: unknown = JSON.parse(localStorage.getItem(key)!); if (validExecution(row) && !emergency.has(row.id)) emergency.set(row.id, row); }
    } } catch { /* In-memory recovery remains available when browser storage is full. */ }
  }
  return [...emergency.values()];
}
const statuses = ['wallet-pending', 'unknown', 'pending', 'rejected', 'source-failed', 'approval-confirmed', 'source-confirmed', 'destination-pending', 'destination-failed', 'destination-confirming', 'delivered', 'replaced'];
const hash = (x: unknown) => typeof x === 'string' && /^0x[0-9a-f]{64}$/i.test(x);
const revision = (row: ExecutionRecord) => row.storageRevision ?? 0;
function mergeRecovery(rows: ExecutionRecord[]) {
  const merged = new Map(rows.map(r => [r.id, r]));
  for (const row of recoveryRows()) {
    const old = merged.get(row.id);
    if (!old || revision(row) > revision(old) || (revision(row) === revision(old) && row.updatedAt >= old.updatedAt)) merged.set(row.id, row);
  }
  return [...merged.values()];
}
export function validExecution(value: unknown): value is ExecutionRecord {
  try {
    const r = value as ExecutionRecord, p = r.review.plan, t = r.review.transaction;
    return r.version === 1 && typeof r.id === 'string' && r.id.length < 100 && statuses.includes(r.status) &&
      Number.isSafeInteger(revision(r)) && revision(r) >= 0 &&
      (r.destinationHashSource === undefined || r.destinationHashSource === 'manual' || r.destinationHashSource === 'scan') &&
      (r.sourceFinalized === undefined || typeof r.sourceFinalized === 'boolean') &&
      [r.actualSentLD, r.actualReceivedLD, r.destinationAmountLD].every(v => v === undefined || (typeof v === 'string' && /^\d{1,78}$/.test(v))) &&
      ['approve', 'approve-reset', 'send'].includes(r.review.kind) && /^\d+$/.test(r.nonce) &&
      Number.isFinite(Date.parse(r.createdAt)) && Number.isFinite(Date.parse(r.updatedAt)) &&
      isChainId(t.chainId) && isChainId(p.input.route.sourceChain) && isChainId(p.input.route.destinationChain) &&
      t.chainId === p.input.route.sourceChain && t.from.toLowerCase() === p.input.sender.toLowerCase() &&
      [t.from, t.to, p.input.recipient, p.input.refundAddress, p.input.route.tokenAddress, p.input.route.bridgeAddress, p.route.destination!.identity!.bridgeAddress, p.route.destination!.identity!.token.address].every(a => isAddress(a, { strict: false })) &&
      /^0x(?:[0-9a-f]{2})*$/i.test(t.data) && t.data.length < 30000 &&
      [t.value, t.gas, t.gasPrice, p.sendParam.amountLD, p.sendParam.minAmountLD].every(v => typeof v === 'string' && /^\d{1,78}$/.test(v)) &&
      [p.amounts.sourceDecimals, p.amounts.destinationDecimals, p.amounts.sharedDecimals].every(n => Number.isInteger(n) && n >= 0 && n <= 77) &&
      p.amounts.sourceDecimals >= p.amounts.sharedDecimals && p.amounts.destinationDecimals >= p.amounts.sharedDecimals &&
      [r.hash, r.originalHash, r.guid, r.destinationHash].every(x => x === undefined || hash(x)) && typeof r.detail === 'string';
  } catch { return false; }
}
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('executions', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('전송 이력 저장소를 열지 못했습니다.'));
    request.onblocked = () => reject(new Error('전송 이력 저장소가 사용 중입니다.'));
  });
}
function notify() { if (typeof window !== 'undefined') window.dispatchEvent(new Event('oft-executions')); }
export const executionStore: ExecutionStore = {
  async list() {
    let db: IDBDatabase;
    try { db = await open(); }
    catch (error) { const recovered = recoveryRows(); if (recovered.length) return recovered; throw error; }
    try {
      const rows = await new Promise<unknown[]>((resolve, reject) => {
        const request = db.transaction('executions').objectStore('executions').getAll();
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      // Corrupt history could contain an unresolved send. Do not silently discard it and unlock signing.
      if (rows.some(r => !validExecution(r))) throw new Error('전송 이력 일부를 해석하지 못했습니다. 기존 거래를 확인하기 전에는 새 전송을 시작할 수 없습니다.');
      return mergeRecovery(rows as ExecutionRecord[]).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } finally { db.close(); }
  },
  async reserve(row) {
    if (!validExecution(row)) throw new Error('전송 기록 형식이 잘못되었습니다.');
    const db = await open();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('executions', 'readwrite'), store = tx.objectStore('executions');
        let reason = '전송 이력을 저장하지 못해 Rabby 요청을 중단했습니다.';
        const read = store.getAll();
        read.onsuccess = () => {
          if (read.result.some(r => !validExecution(r))) { reason = '해석할 수 없는 기존 전송 이력이 있습니다.'; tx.abort(); return; }
          const rows = mergeRecovery(read.result as ExecutionRecord[]);
          const pending = blockingExecution(rows, row.review.transaction.chainId, row.review.transaction.from);
          if (pending) {
            reason = pendingExecutionMessage(pending); tx.abort(); return;
          }
          if (rows.length >= 500) { reason = '전송 이력 저장 한도(500건)에 도달했습니다. 기록을 백업하고 정리가 필요합니다.'; tx.abort(); return; }
          store.add(row);
        };
        tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(new Error(reason));
      });
    } finally { db.close(); }
    notify();
  },
  async put(row, expected) {
    if (!validExecution(row)) throw new Error('전송 기록 형식이 잘못되었습니다.');
    let db: IDBDatabase | undefined;
    let baseRevision = revision(row), committedRevision = baseRevision;
    try {
      db = await open();
      const saved = await new Promise<boolean>((resolve, reject) => {
        const tx = db!.transaction('executions', 'readwrite'), store = tx.objectStore('executions');
        const read = store.get(row.id); let written = false;
        let failure: unknown = new Error('전송 이력 저장 실패 — 표시된 거래 해시를 보관하세요.');
        read.onsuccess = () => {
          try {
            const current: unknown = read.result;
            if (current && !validExecution(current)) throw new Error('기존 전송 기록을 해석하지 못했습니다.');
            // Check and write in one IndexedDB transaction. Wall-clock equality is not a concurrency token.
            if (expected && (!current || expected.id !== row.id || revision(current as ExecutionRecord) !== revision(expected))) return;
            baseRevision = current ? revision(current as ExecutionRecord) : revision(row);
            committedRevision = baseRevision + 1;
            if (!Number.isSafeInteger(committedRevision)) throw new Error('전송 기록 버전 한도를 초과했습니다.');
            store.put({ ...row, storageRevision: committedRevision }); written = true;
          } catch (error) { failure = error; tx.abort(); }
        };
        tx.oncomplete = () => resolve(written); tx.onabort = tx.onerror = () => reject(failure);
      });
      if (!saved) return false;
      row.storageRevision = committedRevision;
      emergency.delete(row.id);
      try { localStorage.removeItem(`${BACKUP}${row.id}`); } catch { /* No browser storage in non-browser tests. */ }
    } catch (error) {
      const backup = { ...row, storageRevision: baseRevision, trackingError: '전송 이력 저장 실패 — 복구용 기록을 표시합니다. 거래 해시를 복사해 보관하세요.' };
      emergency.set(row.id, backup);
      try { localStorage.setItem(`${BACKUP}${row.id}`, JSON.stringify(backup)); } catch { /* Memory still retains the hash. */ }
      notify(); throw error;
    } finally { db?.close(); }
    notify();
    return true;
  },
};
