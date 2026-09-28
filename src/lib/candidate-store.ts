import { isChainId } from '../../shared/chains';
import { isAddress } from 'viem';
import type { CandidateStore, SavedCandidate } from '../../shared/discovery';

const DB_NAME = 'oft-bridge-candidates';
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('candidates', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('후보 저장소가 사용 중입니다.'));
  });
}
function valid(value: unknown): value is SavedCandidate {
  if (!value || typeof value !== 'object') return false;
  const row = value as SavedCandidate;
  return isChainId(row.chainId) && typeof row.id === 'string' &&
    typeof row.tokenAddress === 'string' && typeof row.bridgeAddress === 'string' && isAddress(row.tokenAddress, { strict: false }) && isAddress(row.bridgeAddress, { strict: false }) &&
    ['manual', 'transaction', 'peer'].includes(row.source) && typeof row.savedAt === 'string' && Number.isFinite(Date.parse(row.savedAt)) &&
    row.id === `${row.chainId}:${row.tokenAddress.toLowerCase()}:${row.bridgeAddress.toLowerCase()}` &&
    (row.transactionHash === undefined || /^0x[0-9a-f]{64}$/i.test(row.transactionHash));
}
export const candidateStore: CandidateStore = {
  async list(chainId, tokenAddress) {
    const db = await open();
    try {
      const rows = await new Promise<unknown[]>((resolve, reject) => {
        const request = db.transaction('candidates').objectStore('candidates').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return rows.filter(valid).filter(row => row.chainId === chainId && row.tokenAddress.toLowerCase() === tokenAddress.toLowerCase());
    } finally { db.close(); }
  },
  async save(candidate) {
    if (!valid(candidate)) throw new Error('유효하지 않은 후보 기록입니다.');
    const db = await open();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('candidates', 'readwrite');
        const store = tx.objectStore('candidates');
        store.put(candidate);
        const all = store.getAll();
        all.onsuccess = () => {
          const rows = all.result as SavedCandidate[];
          rows.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
          for (const row of rows.slice(100)) store.delete(row.id);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  },
};
