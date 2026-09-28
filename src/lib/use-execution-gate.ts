import { useEffect, useState } from 'react';
import { blockingExecution, type ExecutionRecord } from '../../shared/execution';
import { executionStore } from './execution-store';

// A UI guard only: executionStore.reserve remains the atomic cross-tab authority.
export function useExecutionGate(chainId: number, account: string) {
  const key = `${chainId}:${account.toLowerCase()}`;
  const [state, setState] = useState<{ key: string; ready: boolean; rows: ExecutionRecord[]; error?: string }>({ key: '', ready: false, rows: [] });
  useEffect(() => {
    let active = true, requestId = 0;
    const load = async () => {
      const id = ++requestId;
      try {
        const rows = await executionStore.list();
        if (active && id === requestId) setState({ key, ready: true, rows });
      } catch (error) {
        if (active && id === requestId) setState({ key, ready: true, rows: [], error: `전송 이력 조회 오류 — ${error instanceof Error ? error.message : '기록을 읽지 못했습니다.'}` });
      }
    };
    const refresh = () => void load();
    window.addEventListener('oft-executions', refresh);
    window.addEventListener('focus', refresh);
    const timer = setInterval(refresh, 5000); // Other tabs can write IndexedDB without a local event.
    refresh();
    return () => { active = false; clearInterval(timer); window.removeEventListener('oft-executions', refresh); window.removeEventListener('focus', refresh); };
  }, [key]);
  const current = state.key === key ? state : { key, ready: false, rows: [] };
  return { ...current, pending: blockingExecution(current.rows, chainId, account) };
}
