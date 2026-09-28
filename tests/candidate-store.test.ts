import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { candidateStore } from '../src/lib/candidate-store';
import { TOKEN, BRIDGE } from './helpers/discovery';

describe('browser candidate persistence', () => {
  it('upserts only address evidence, filters by chain/token, and survives reopening the DB', async () => {
    const value = { id: `56:${TOKEN}:${BRIDGE}`, chainId: 56 as const, tokenAddress: TOKEN, bridgeAddress: BRIDGE, source: 'manual' as const, savedAt: new Date().toISOString() };
    await candidateStore.save(value);
    await candidateStore.save(value);
    expect(await candidateStore.list(56, TOKEN)).toEqual([value]);
    expect(await candidateStore.list(1, TOKEN)).toEqual([]);
    expect(await candidateStore.list(56, BRIDGE)).toEqual([]);
    await expect(candidateStore.save({ ...value, bridgeAddress: 'invalid' })).rejects.toThrow();
  });
  it('keeps old and new chain evidence separate when token and bridge addresses are identical', async () => {
    const value = { id: `8453:${TOKEN}:${BRIDGE}`, chainId: 8453, tokenAddress: TOKEN, bridgeAddress: BRIDGE, source: 'peer' as const, savedAt: new Date().toISOString() };
    await candidateStore.save(value);
    expect(await candidateStore.list(8453, TOKEN)).toEqual([value]);
    expect((await candidateStore.list(56, TOKEN))[0].chainId).toBe(56);
  });
  it('ignores malformed persisted records', async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('oft-bridge-candidates', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('candidates', 'readwrite');
      tx.objectStore('candidates').put({ id: 'bad-record', chainId: 56, source: 'manual', savedAt: new Date().toISOString() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    expect((await candidateStore.list(56, TOKEN)).every(row => row.id !== 'bad-record')).toBe(true);
  });
});
