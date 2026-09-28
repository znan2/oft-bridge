import { useEffect, useRef, useState } from 'react';
import { useConnection } from 'wagmi';
import { formatEther, formatUnits } from 'viem';
import { LoaderCircle } from 'lucide-react';
import { chainById } from '../../shared/chains';
import type { TransferPlan } from '../../shared/transfer';
import { blockingExecution, pendingExecutionMessage, type ExecutionRecord, type ExecutionReview } from '../../shared/execution';
import { prepareExecution, submitExecution } from '../lib/execution';
import { executionStore } from '../lib/execution-store';
import { browserRouteIO } from '../lib/route-io';
import { transferIssue } from '../lib/transfer';
import { sessionKey } from '../lib/wallet';
import { useExecutionGate } from '../lib/use-execution-gate';
import { currentRuntime, useRuntime } from '../lib/runtime';

export function ExecutionPanel({ plan, onPlanReviewed }: { plan: TransferPlan; onPlanReviewed?(plan: TransferPlan): void }) {
  const connection = useConnection();
  const runtime = useRuntime(), live = runtime.executionMode === 'live';
  const gate = useExecutionGate(plan.input.route.sourceChain, plan.input.sender);
  const blocked = !gate.ready || !!gate.error || !!gate.pending;
  const [review, setReview] = useState<ExecutionReview>();
  const [row, setRow] = useState<ExecutionRecord>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [accepted, setAccepted] = useState(false);
  const [now, setNow] = useState(Date.now);
  const active = useRef(true), lock = useRef(false), controller = useRef<AbortController | null>(null);
  const current = useRef(connection); current.current = connection;
  useEffect(() => {
    active.current = true; const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { active.current = false; controller.current?.abort(); clearInterval(timer); };
  }, []);
  const expired = !review || now >= Date.parse(review.expiresAt);
  useEffect(() => {
    if (blocked) { setAccepted(false); if (!busy) setReview(undefined); }
  }, [blocked, gate.pending?.id, busy]);
  async function historyClear() {
    try {
      const pending = blockingExecution(await executionStore.list(), plan.input.route.sourceChain, plan.input.sender);
      if (pending) { if (active.current) { setError(pendingExecutionMessage(pending)); setReview(undefined); setAccepted(false); } return false; }
      return true;
    } catch (e) { if (active.current) { setError(`전송 이력 조회 오류 — ${e instanceof Error ? e.message : '기록을 읽지 못했습니다.'}`); setReview(undefined); setAccepted(false); } return false; }
  }
  async function prepare() {
    if (lock.current || blocked) return; lock.current = true; setBusy(true); setError(''); setReview(undefined); setAccepted(false); setRow(undefined);
    const abort = new AbortController(); controller.current?.abort(); controller.current = abort;
    try {
      if (!await historyClear()) return;
      abort.signal.throwIfAborted();
      const result = await prepareExecution(plan.input, browserRouteIO(plan.input.rpcRevision, abort.signal), abort.signal);
      if (active.current && !abort.signal.aborted && await historyClear() && !abort.signal.aborted) { setReview(result); onPlanReviewed?.(result.plan); }
    } catch (e) { if (active.current && !abort.signal.aborted) setError(transferIssue(e).message); }
    finally { lock.current = false; if (active.current) setBusy(false); }
  }
  async function submit() {
    if (!live || lock.current || blocked || !review || !accepted || row || Date.now() >= Date.parse(review.expiresAt)) return;
    lock.current = true; setBusy(true); setError('');
    const abort = controller.current ?? new AbortController();
    try {
      if (!await historyClear()) return;
      abort.signal.throwIfAborted();
      const connector = current.current.connector;
      if (connector?.id !== 'io.rabby' || !current.current.isConnected) throw new Error('Rabby를 다시 연결하세요.');
      // Re-read the server mode right before signing; the tab may predate a restart without --live.
      const fresh = await currentRuntime(abort.signal);
      if (fresh.executionMode !== 'live') throw new Error('서버가 dry-run 모드로 바뀌었습니다. 서명 요청을 보내지 않았습니다. 페이지를 새로고침하세요.');
      const provider = await connector.getProvider() as { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
      const expected = sessionKey(plan.input.sender, plan.input.walletChainId, plan.input.providerUid);
      const result = await submitExecution(review, { uid: connector.uid, executionMode: fresh.executionMode, request: args => provider.request(args), assertCurrent() {
        const c = current.current;
        if (!active.current || !c.isConnected || c.connector?.id !== 'io.rabby' || sessionKey(c.address, c.chainId, c.connector?.uid) !== expected) throw new Error('지갑 또는 입력이 변경되었습니다.');
      } }, browserRouteIO(plan.input.rpcRevision, abort.signal), executionStore, abort.signal);
      if (active.current) { setRow(result); setAccepted(false); }
    } catch (e) { if (active.current) setError(e instanceof Error ? e.message : '서명 요청을 준비하지 못했습니다.'); }
    finally { lock.current = false; if (active.current) setBusy(false); }
  }
  const source = chainById(plan.input.route.sourceChain), destination = chainById(plan.input.route.destinationChain);
  const token = plan.route.source?.identity?.token.symbol ?? '토큰';
  const label = review?.kind === 'approve-reset' ? 'Rabby에서 기존 승인 0으로 초기화' : review?.kind === 'approve' ? 'Rabby에서 필요 수량 승인' : 'Rabby에서 브릿지 전송';
  return <section className="execution-panel" aria-label="Rabby 승인·전송">
    <h3>Rabby 승인·전송</h3>
    <p className="footnote">최신 경로·금액·수수료를 다시 확인한 뒤 아래 요청을 검토하세요. 승인과 전송은 각각 Rabby에서 서명합니다.</p>
    {!live && <p className="dry-run-note" role="note"><strong>Dry-run</strong> 경로·수량·예상 수수료까지만 계산합니다. 서명 요청은 비활성입니다. 실제 전송은 서버를 <code>--live</code>로 시작해야 합니다.</p>}
    {!gate.ready && <p role="status">같은 계정·출발 체인의 이전 요청을 확인하는 중입니다.</p>}
    {gate.error && <p className="alert" role="alert">{gate.error} 이력을 확인하기 전에는 새 서명을 시작할 수 없습니다.</p>}
    {gate.pending && <div className="alert" role="status"><strong>이전 요청 처리 대기</strong><p>{pendingExecutionMessage(gate.pending)}</p><a href="#execution-history">대기 요청 확인 ↓</a></div>}
    <button type="button" className="secondary" disabled={busy || blocked} onClick={() => void prepare()}>{busy && <LoaderCircle className="spin" size={16} />}전송 직전 재검증</button>
    {error && <p className="alert" role="alert">{error}</p>}
    {review && <div className="execution-review">
      <strong>{review.kind === 'send' ? '브릿지 전송 요청 검토' : review.kind === 'approve-reset' ? '기존 승인 초기화 요청 검토' : '토큰 승인 요청 검토'}</strong>
      <dl className="transfer-facts">
        <div><dt>네트워크</dt><dd>{source.shortName} → {destination.shortName}</dd></div>
        <div><dt>보내는 계정</dt><dd>{review.transaction.from}</dd></div>
        <div><dt>서명 대상 컨트랙트</dt><dd>{review.transaction.to}</dd></div>
        {review.kind === 'send' ? <>
          <div><dt>받는 주소</dt><dd>{review.plan.input.recipient}</dd></div>
          <div><dt>환불 주소</dt><dd>{review.plan.refundAddress}</dd></div>
          <div><dt>실제 차감 예정</dt><dd>{formatUnits(BigInt(review.plan.amounts.sentLD), review.plan.amounts.sourceDecimals)} {token}</dd></div>
          <div><dt>목적지 예상 / 최소 수령</dt><dd>{formatUnits(BigInt(review.plan.amounts.destinationLD), review.plan.amounts.destinationDecimals)} / {formatUnits(BigInt(review.plan.amounts.destinationMinimumLD), review.plan.amounts.destinationDecimals)}</dd></div>
        </> : <>
          <div><dt>승인받는 브릿지 · spender</dt><dd>{review.plan.approval.spender}</dd></div>
          <div><dt>승인 수량</dt><dd>{review.kind === 'approve-reset' ? '0' : formatUnits(BigInt(review.plan.approval.amountLD), review.plan.amounts.sourceDecimals)} {token}</dd></div>
        </>}
        <div><dt>{review.kind === 'send' ? '브릿지 수수료' : '승인 요청 금액'}</dt><dd>{formatEther(BigInt(review.transaction.value))} {source.symbol}</dd></div>
        <div><dt>출발 가스비 예산 · 20% 여유 포함</dt><dd>{formatEther(review.gasBudget ? BigInt(review.gasBudget.budgetWithBufferWei) : BigInt(review.transaction.gas) * BigInt(review.transaction.gasPrice))} {source.symbol}</dd></div>
      </dl>
      {review.kind === 'approve-reset' && <p className="footnote">기존의 부족한 allowance를 먼저 0으로 바꿉니다. 확정 후 다시 검증하면 필요한 수량의 승인 요청을 준비합니다.</p>}
      {review.kind !== 'send' && <p className="footnote">승인 확정 후 ‘전송 직전 재검증’을 다시 누르세요. 갱신한 견적과 send 시뮬레이션을 확인한 후 별도로 전송합니다.</p>}
      <p className="footnote">{expired ? '검토 견적이 만료됐습니다. 다시 검증하세요.' : `서명 요청 유효 시간 ${Math.max(0, Math.ceil((Date.parse(review.expiresAt) - now) / 1000))}초`} · Rabby에서 최종 가스비를 확인하세요.</p>
      {live ? <>
        <label className="execution-consent"><input type="checkbox" checked={accepted} disabled={busy || blocked || expired || !!row} onChange={e => setAccepted(e.target.checked)} />위 주소·수량·수수료와 미확인 조건을 확인했습니다.</label>
        <button type="button" className="primary" disabled={busy || blocked || expired || !accepted || !!row} onClick={() => void submit()}>{busy && <LoaderCircle className="spin" size={16} />}{label}</button>
      </> : <button type="button" className="secondary" disabled>Dry-run · 서명 요청 비활성</button>}
      {busy && <p role="status">재검증 또는 Rabby 응답 대기 중입니다. 서명 창이 열렸다면 그 창에서 확인하세요.</p>}
    </div>}
    {row && <div role="status"><p>{row.detail}</p>{row.hash && <p><a href={`${source.explorer}/tx/${row.hash}`} target="_blank" rel="noreferrer">{row.hash}</a></p>}{row.trackingError && <p className="alert">{row.trackingError}</p>}<a href="#execution-history">전송 이력·도착 추적 보기 ↓</a></div>}
  </section>;
}
