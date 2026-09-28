import { useEffect, useRef, useState } from 'react';
import { formatUnits } from 'viem';
import { chainById } from '../../shared/chains';
import { terminalStatus, type ExecutionRecord, type ScanResult } from '../../shared/execution';
import { executionStore } from '../lib/execution-store';
import { attachSourceHash, trackExecution, type TrackingIO } from '../lib/tracking';
import { browserRouteIO } from '../lib/route-io';
import { api } from '../lib/api';
const labels: Record<ExecutionRecord['status'], string> = {
  'wallet-pending': 'Rabby 응답 대기', unknown: '전파 결과 미확인', pending: '출발 확정 대기', rejected: '서명 요청 취소', 'source-failed': '출발 실행 실패',
  'approval-confirmed': '승인 확정', 'source-confirmed': '출발 실행 성공', 'destination-pending': '목적지 전달 대기', 'destination-failed': '목적지 처리 확인 필요',
  'destination-confirming': '수령 확인 · 최종 확정 대기', delivered: '목적지 수령 완료', replaced: '취소·변경 거래 확정',
};
export function ExecutionHistory({ revision }: { revision: number }) {
  const [rows, setRows] = useState<ExecutionRecord[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false);
  const tick = useRef<() => void>(() => {});
  useEffect(() => {
    const controller = new AbortController(); let running = false; let timer: ReturnType<typeof setTimeout>;
    const route = browserRouteIO(revision, controller.signal);
    const io: TrackingIO = { rpc: route.rpc, scan: hash => api<ScanResult>(`/scan/tx/${hash}`, { signal: controller.signal }) };
    const load = async () => { try { const list = await executionStore.list(); if (!controller.signal.aborted) { setRows(list); setLoaded(true); } } catch (e) { if (!controller.signal.aborted) setError(String(e)); } };
    const poll = async () => {
      if (running || controller.signal.aborted) return;
      running = true; clearTimeout(timer); setBusy(true); setError('');
      try {
        const list = await executionStore.list();
        if (!controller.signal.aborted) { setRows(list); setLoaded(true); }
        for (const row of list.filter(r => r.hash && !terminalStatus(r.status))) {
          const next = await trackExecution(row, io);
          if (controller.signal.aborted) return;
          await executionStore.put(next, row);
        }
        await load();
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '전송 이력 조회 실패'); }
      finally { running = false; if (!controller.signal.aborted) { setBusy(false); timer = setTimeout(() => void poll(), 15_000); } }
    };
    tick.current = () => void poll();
    const changed = () => void load(); window.addEventListener('oft-executions', changed); void poll();
    return () => { controller.abort(); clearTimeout(timer); window.removeEventListener('oft-executions', changed); };
  }, [revision]);
  return <section className="panel execution-history" id="execution-history" aria-labelledby="execution-history-title">
    <div className="section-title"><h2 id="execution-history-title">전송 이력·도착 추적</h2><button className="secondary" disabled={busy} onClick={() => tick.current()}>{busy ? '조회 중…' : '이력 다시 조회'}</button></div>
    <p className="footnote">이력은 현재 브라우저에 저장됩니다.</p>
    {error && <p className="alert" role="alert">{error}</p>}
    {!rows.length && !error && <p className="empty-state">{loaded ? '아직 승인·전송 요청이 없습니다.' : '저장한 전송 이력을 확인하는 중입니다.'}</p>}
    {rows.map(row => <HistoryRow key={row.id} row={row} revision={revision} refresh={() => tick.current()} />)}
  </section>;
}
function HistoryRow({ row, revision, refresh }: { row: ExecutionRecord; revision: number; refresh(): void }) {
  const [reference, setReference] = useState(''), [destinationHash, setDestinationHash] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const recovery = useRef<AbortController | null>(null), lock = useRef(false);
  useEffect(() => {
    setBusy(false); setError('');
    return () => { recovery.current?.abort(); recovery.current = null; lock.current = false; };
  }, [revision]);
  const p = row.review.plan, source = chainById(p.input.route.sourceChain), destination = chainById(p.input.route.destinationChain);
  async function recover(destinationOnly = false) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true); setError('');
    const abort = new AbortController(), route = browserRouteIO(revision, abort.signal);
    recovery.current = abort;
    const io: TrackingIO = { rpc: route.rpc, scan: hash => api<ScanResult>(`/scan/tx/${hash}`, { signal: abort.signal }) };
    try {
      const next: ExecutionRecord = destinationOnly ? { ...row, destinationHash: destinationHash.trim(), destinationHashSource: 'manual', destinationAmountLD: undefined, status: 'source-confirmed', detail: '수신 해시 연결 · 수신 근거 확인 대기', updatedAt: new Date().toISOString() } : await attachSourceHash(row, reference.trim(), io);
      if (destinationOnly && !/^0x[0-9a-f]{64}$/i.test(next.destinationHash!)) throw new Error('66자리 목적지 수신 거래 해시를 입력하세요.');
      abort.signal.throwIfAborted();
      if (await executionStore.put(next, row) === false) throw new Error('다른 조회에서 이력이 갱신됐습니다. 최신 이력을 확인하고 다시 연결하세요.');
      refresh();
    } catch (e) { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : '해시 연결 실패'); }
    finally { if (recovery.current === abort) { lock.current = false; if (!abort.signal.aborted) setBusy(false); } }
  }
  return <article className="execution-row">
    <div className="section-title"><h3>{row.review.kind === 'send' ? `${source.shortName} → ${destination.shortName} 브릿지` : row.review.kind === 'approve-reset' ? '기존 승인 초기화' : '토큰 승인'}</h3><strong className={row.status === 'delivered' || row.status === 'approval-confirmed' ? 'accent' : 'muted'}>{labels[row.status]}</strong></div>
    {row.status !== 'delivered' && <p>{row.detail}</p>}<p className="footnote">{new Date(row.createdAt).toLocaleString('ko-KR')}</p>
    {row.hash && <div className="contract-address"><span>출발 거래</span><a href={`${source.explorer}/tx/${row.hash}`} target="_blank" rel="noreferrer"><code title={row.hash}>{row.hash.slice(0, 10)}…{row.hash.slice(-8)}</code></a></div>}
    {row.originalHash && row.originalHash !== row.hash && <p className="footnote">기존 해시 {row.originalHash}</p>}
    {row.guid && <div className="contract-address"><span>메시지 상태</span><a href={`https://layerzeroscan.com/tx/${row.hash}`} target="_blank" rel="noreferrer">LayerZero Scan ↗</a></div>}
    {row.destinationHash && <div className="contract-address"><span>목적지 거래</span><a href={`${destination.explorer}/tx/${row.destinationHash}`} target="_blank" rel="noreferrer"><code title={row.destinationHash}>{row.destinationHash.slice(0, 10)}…{row.destinationHash.slice(-8)}</code></a></div>}
    {row.destinationAmountLD && <p>확인한 수령량: {formatUnits(BigInt(row.destinationAmountLD), p.amounts.destinationDecimals)} {p.route.destination?.identity?.token.symbol ?? '토큰'}</p>}
    {row.trackingError && <p className="alert" role="alert">{row.trackingError}</p>}
    {!terminalStatus(row.status) && <details className="evidence-details"><summary>전파 결과 미확인·교체 거래 해시 연결</summary>
      <p className="footnote">Rabby 활동에서 같은 계정·nonce의 출발 또는 교체 거래 해시를 확인해 입력하세요. 요청과 내용이 다른 거래는 취소·변경으로 표시합니다. 지갑 창에 요청이 남아 있다면 먼저 확인하세요.</p>
      <label className="field-label" htmlFor={`recover-${row.id}`}>출발·교체 거래 해시</label><input id={`recover-${row.id}`} value={reference} onChange={e => setReference(e.target.value)} maxLength={66} /><button className="secondary" disabled={busy || !reference} onClick={() => void recover()}>해시 연결·검증</button>
      {row.guid && <><p className="footnote">Scan 조회가 안 되는 경우 목적지 수신 해시를 직접 입력할 수 있습니다. 수신 증거를 동일하게 검증합니다.</p><label className="field-label" htmlFor={`destination-${row.id}`}>목적지 수신 거래 해시</label><input id={`destination-${row.id}`} value={destinationHash} onChange={e => setDestinationHash(e.target.value)} maxLength={66} /><button className="secondary" disabled={busy || !destinationHash} onClick={() => void recover(true)}>목적지 해시 연결·검증</button></>}
    </details>}
    {error && <p className="alert" role="alert">{error}</p>}
    <details className="evidence-details"><summary>계정·거래 정보</summary><p>계정 <code>{row.review.transaction.from}</code> · nonce {row.nonce}</p></details>
  </article>;
}
