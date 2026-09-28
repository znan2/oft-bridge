import { useEffect, useRef, useState } from 'react';
import { useConnection } from 'wagmi';
import { formatEther, formatUnits } from 'viem';
import { Calculator, Copy, LoaderCircle } from 'lucide-react';
import { chainById } from '../../shared/chains';
import type { RouteInput, RouteResult } from '../../shared/route';
import type { TransferPlan } from '../../shared/transfer';
import { prepareTransfer, transferIssue } from '../lib/transfer';
import { browserRouteIO } from '../lib/route-io';
import { sessionKey } from '../lib/wallet';
import { ExecutionPanel } from './ExecutionPanel';
import { useExecutionGate } from '../lib/use-execution-gate';

export function TransferPanel({ input, revision, routeResult }: { input: RouteInput; revision: number; routeResult: RouteResult }) {
  const connection = useConnection();
  const connected = connection.isConnected && connection.connector?.id === 'io.rabby';
  const routeBlocked = routeResult.configurationStatus !== 'PASS';
  const configProblems = routeResult.checks.filter(check => check.scope === 'configuration' && (check.status === 'FAIL' || check.status === 'UNKNOWN'));
  // Explain the first actual blockers, without repeating every skipped downstream check.
  const failures = configProblems.filter(check => check.status === 'FAIL');
  const causes = (failures.length ? failures : configProblems.filter(check => !check.detail.startsWith('선행 검사'))).slice(0, 3);
  const reasons = [
    ...(chainById(input.sourceChain).sourceRestriction ? [chainById(input.sourceChain).sourceRestriction!] : []),
    ...(routeBlocked ? causes.length ? causes.map(check => `${check.title}: ${check.detail}`) : ['기본 경로 설정을 아직 확인하지 못했습니다.'] : []),
    ...(!connected ? ['위의 내 지갑에서 Rabby를 연결하세요.'] : connection.chainId !== input.sourceChain ? [`내 지갑에서 ${chainById(input.sourceChain).shortName}로 전환하세요.`] : []),
  ];
  const key = JSON.stringify([input, revision, connected, routeResult.checkedAt, sessionKey(connection.address, connection.chainId, connection.connector?.uid)]);
  return <section className="transfer-panel" aria-labelledby="transfer-title">
    <h2 id="transfer-title">수량·수수료</h2>
    {reasons.length > 0 ? <>
      <div className="alert" id="transfer-block-reason" role="alert"><strong>수량 입력·견적 생성 대기</strong><ul className="discovery-warnings">{reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
        {routeBlocked && <p>{causes.some(check => /RPC 오류/.test(check.detail)) ? '네트워크 RPC 설정을 확인한 뒤 위의 ‘경로 다시 검증’을 눌러주세요.' : '출발 네트워크의 토큰 CA와 경로를 확인한 뒤 위의 ‘경로 다시 검증’을 눌러주세요.'}</p>}
        {!connected || connection.chainId !== input.sourceChain ? <a className="text-button" href="#wallet-title">내 지갑 확인 ↑</a> : null}
      </div>
      <div className="transfer-form"><label className="field-label" htmlFor="transfer-amount">보낼 수량</label><input id="transfer-amount" placeholder="위 조건을 확인하면 입력할 수 있습니다" disabled aria-describedby="transfer-block-reason" /><button className="primary" type="button" disabled><Calculator size={17} />견적 생성 · 시뮬레이션</button></div>
    </> : <TransferForm key={key} input={input} revision={revision} sender={connection.address!} walletChainId={connection.chainId!} providerUid={connection.connector!.uid} />}
  </section>;
}
function TransferForm({ input, revision, sender, walletChainId, providerUid }: { input: RouteInput; revision: number; sender: string; walletChainId: number; providerUid: string }) {
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState(sender);
  const [refundAddress, setRefund] = useState(sender);
  const [slippagePercent, setSlippage] = useState('0');
  const [extraReceiveGas, setGas] = useState('0');
  const [state, setState] = useState<{ key: string; busy: boolean; result?: TransferPlan; error?: string }>({ key: '', busy: false });
  const controller = useRef<AbortController | null>(null);
  const form = { route: input, sender, recipient, refundAddress, amount, slippagePercent, extraReceiveGas, walletChainId, providerUid, rpcRevision: revision };
  const key = JSON.stringify(form);
  const visible = state.key === key ? state : undefined;
  useEffect(() => () => controller.current?.abort(), [key]);
  async function generate() {
    controller.current?.abort();
    const active = new AbortController(); controller.current = active;
    setState({ key, busy: true });
    try {
      const result = await prepareTransfer(form, browserRouteIO(revision, active.signal), active.signal);
      if (!active.signal.aborted) setState({ key, busy: false, result });
    } catch (error) { if (!active.signal.aborted) setState({ key, busy: false, error: transferIssue(error).message }); }
  }
  return <>
    <form className="transfer-form" onSubmit={e => { e.preventDefault(); void generate(); }}>
      <label className="field-label" htmlFor="transfer-amount">보낼 수량</label>
      <input id="transfer-amount" inputMode="decimal" autoComplete="off" placeholder="예: 1.25" value={amount} onChange={e => setAmount(e.target.value)} maxLength={160} required />
      <details className="transfer-advanced"><summary>고급 설정 · 수령 주소 / 슬리피지 / 수신 gas</summary>
        <label className="field-label" htmlFor="transfer-recipient">받는 주소 · 0x 주소</label><input id="transfer-recipient" value={recipient} onChange={e => setRecipient(e.target.value)} maxLength={42} required />
        <label className="field-label" htmlFor="transfer-refund">환불 주소 · 출발 네트워크</label><input id="transfer-refund" value={refundAddress} onChange={e => setRefund(e.target.value)} maxLength={42} required />
        <div className="transfer-fields"><div><label className="field-label" htmlFor="transfer-slippage">슬리피지 (%)</label><input id="transfer-slippage" inputMode="decimal" value={slippagePercent} onChange={e => setSlippage(e.target.value)} maxLength={8} required /></div>
          <div><label className="field-label" htmlFor="transfer-gas">추가 수신 gas</label><input id="transfer-gas" inputMode="numeric" value={extraReceiveGas} onChange={e => setGas(e.target.value)} maxLength={40} required /></div></div>
        <p className="footnote">0이면 컨트랙트에 설정된 수신 gas를 사용합니다. 추가하면 브릿지 수수료가 늘어날 수 있습니다.</p>
      </details>
      <button className="primary" disabled={!amount || visible?.busy} type="submit">{visible?.busy ? <LoaderCircle className="spin" size={17} /> : <Calculator size={17} />}{visible?.busy ? '견적·조건 조회 중…' : '견적 생성 · 시뮬레이션'}</button>
    </form>
    <div aria-live="polite" aria-busy={visible?.busy ?? false}>
      {visible?.busy && <p className="query-progress">수수료·잔액·승인 상태를 확인하고 전송을 시뮬레이션합니다.</p>}
      {visible?.error && <div className="alert" role="alert">{visible.error}</div>}
      {visible?.result && <PlanSummary key={visible.result.fingerprint} plan={visible.result} />}
    </div>
  </>;
}
function PlanSummary({ plan: initialPlan }: { plan: TransferPlan }) {
  const [plan, setPlan] = useState(initialPlan);
  const gate = useExecutionGate(plan.input.route.sourceChain, plan.input.sender);
  const laterApproval = gate.rows.find(row => row.review.kind !== 'send' && !['rejected', 'source-failed'].includes(row.status) && row.review.transaction.chainId === plan.input.route.sourceChain && row.review.transaction.from.toLowerCase() === plan.input.sender.toLowerCase() && row.review.transaction.to.toLowerCase() === plan.input.route.tokenAddress.toLowerCase() && row.review.plan.input.route.bridgeAddress.toLowerCase() === plan.input.route.bridgeAddress.toLowerCase() && Date.parse(row.createdAt) >= Date.parse(plan.createdAt));
  const [now, setNow] = useState(Date.now);
  const [notice, setNotice] = useState('');
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const expired = now >= Date.parse(plan.expiresAt);
  const source = chainById(plan.input.route.sourceChain), destination = chainById(plan.input.route.destinationChain);
  const symbol = plan.route.source?.identity?.token.symbol ?? '토큰';
  const destSymbol = plan.route.destination?.identity?.token.symbol ?? symbol;
  const sourceAmount = (value: string) => `${formatUnits(BigInt(value), plan.amounts.sourceDecimals)} ${symbol}`;
  const destinationAmount = (value: string) => `${formatUnits(BigInt(value), plan.amounts.destinationDecimals)} ${destSymbol}`;
  const native = (value: string) => `${formatEther(BigInt(value))} ${source.symbol}`;
  async function copy(value: string) {
    if (laterApproval) { setNotice('승인 요청 이후 다시 검증한 값을 사용하세요.'); return; }
    if (Date.now() >= Date.parse(plan.expiresAt)) { setNow(Date.now()); setNotice('견적이 만료되었습니다. 다시 생성하세요.'); return; }
    try { await navigator.clipboard.writeText(value); setNotice('복사했습니다.'); }
    catch { setNotice('복사하지 못했습니다. 표시된 값을 직접 선택해 복사하세요.'); }
  }
  const fields: [string, string][] = [
    ['send · payable value (네이티브 단위)', formatEther(BigInt(plan.fee.nativeFee))],
    ['msg.value (wei)', plan.fee.nativeFee],
    ...Object.entries(plan.sendParam).map(([key, value]): [string, string] => [key, String(value)]),
    ['nativeFee (wei)', plan.fee.nativeFee], ['lzTokenFee', plan.fee.lzTokenFee], ['refundAddress', plan.refundAddress],
    ['SendParam tuple', JSON.stringify(Object.values(plan.sendParam))], ['Fee tuple', JSON.stringify([plan.fee.nativeFee, plan.fee.lzTokenFee])],
    ['전송 대상 컨트랙트', plan.transaction.to], ['calldata', plan.transaction.data],
  ];
  return <div className="transfer-result">
    {laterApproval ? <div className="route-verdict unknown"><strong>{gate.pending ? '승인 요청 처리 중 · 전송 이력을 확인하세요' : '승인 요청 이후 재검증이 필요합니다'}</strong><p>아래 수량·수수료는 승인 요청 전 조회값입니다. 전송 이력에서 승인 확정 후 아래의 ‘전송 직전 재검증’을 누르세요.</p></div> : <div className={`route-verdict ${expired || plan.blockers.length ? 'unknown' : 'pass'}`}><strong>{expired ? '견적 만료 · 다시 생성하세요' : plan.blockers.length ? '견적 생성됨 · 전송 조건 확인 필요' : '출발 시뮬레이션 통과 · 전송 전 단계'}</strong>
      <p>{plan.simulation.detail}</p><p>견적 유효 시간 {expired ? '종료' : `${Math.ceil((Date.parse(plan.expiresAt) - now) / 1000)}초 남음`}</p>
    </div>}
    {!laterApproval && plan.blockers.length > 0 && <ul className="discovery-warnings" aria-label="전송 조건 문제">{plan.blockers.map((issue, i) => <li key={i}>{issue.message}{issue.data && <code className="revert-data">{issue.data}</code>}</li>)}</ul>}
    <dl className="transfer-facts">
      <Fact label="받는 주소" value={plan.input.recipient} />
      {plan.refundAddress.toLowerCase() !== plan.input.sender.toLowerCase() && <Fact label="환불 주소 · 출발 네트워크" value={plan.refundAddress} />}
      <Fact label="실제 차감 예정" value={sourceAmount(plan.amounts.sentLD)} />
      <Fact label={`${destination.shortName} 예상 수령`} value={destinationAmount(plan.amounts.destinationLD)} />
      <Fact label="최소 수령" value={destinationAmount(plan.amounts.destinationMinimumLD)} />
      {BigInt(plan.amounts.sourceRemainderLD) > 0n && <Fact label="입력량 중 차감하지 않는 양" value={sourceAmount(plan.amounts.sourceRemainderLD)} />}
      <Fact label="브릿지 수수료" value={native(plan.fee.nativeFee)} />
      <Fact label="출발 체인 가스비 추정" value={plan.gas ? native(plan.gas.estimatedCostWei) : '미확인 · 시뮬레이션·가스 추정 완료 필요'} />
      {plan.gas && <Fact label="총 필요 예산 · 가스 20% 여유" value={native(plan.gas.totalNativeBudgetWei)} />}
      <Fact label="보유 토큰 잔액" value={sourceAmount(plan.balances.tokenLD)} />
      <Fact label="보유 네이티브 잔액" value={native(plan.balances.nativeWei)} />
      <Fact label="토큰 승인" value={laterApproval ? '승인 요청 이후 상태는 전송 이력에서 확인하세요.' : !plan.approval.required ? '별도 승인 불필요' : plan.approval.needed ? `승인 필요 · ${sourceAmount(plan.approval.amountLD)}` : '승인 수량 충분'} />
    </dl>
    {plan.tokenFees.length > 0 && <details className="evidence-details"><summary>토큰 수수료 내역</summary><ul>{plan.tokenFees.map((fee, i) => <li key={i}>{fee.description}: {sourceAmount(fee.feeAmountLD)}</li>)}</ul></details>}
    <details className="evidence-details route-raw"><summary>탐색기 입력값 · calldata</summary>
      <p className="footnote">amountLD·minAmountLD는 출발 토큰 단위, nativeFee는 네이티브 코인의 wei입니다. msg.value에 출발 가스비를 더하지 않습니다.</p>
      <div className="parameter-list">{fields.map(([label, value]) => <div key={label}><span>{label}</span><code>{value}</code><button className="icon-button" aria-label={`${label} 복사`} disabled={expired || !!laterApproval} onClick={() => copy(value)}><Copy size={14} /></button></div>)}</div>
    </details>
    <details className="evidence-details"><summary>추가 확인 사항</summary><ul>{plan.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul><p>출발 가스비는 현재 gasPrice 기준 추정이며 Rabby의 실제 견적과 다를 수 있습니다.</p></details>
    <ExecutionPanel plan={plan} onPlanReviewed={setPlan} />
    {notice && <p role="status" className="footnote">{notice}</p>}
  </div>;
}
function Fact({ label, value }: { label: string; value: string }) { return <div><dt>{label}</dt><dd>{value}</dd></div>; }
