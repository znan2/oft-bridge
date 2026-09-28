import { useEffect, useState } from 'react';
import { ArrowRight, LoaderCircle, RefreshCw } from 'lucide-react';
import { chainById, type ChainId } from '../../shared/chains';
import type { RouteCheck, RouteInput, RouteResult, RouteSide } from '../../shared/route';
import { validateRoute } from '../lib/route';
import { browserRouteIO } from '../lib/route-io';
import { TransferPanel } from './TransferPanel';
const statusText = { PASS: '확인', FAIL: '문제 발견', UNKNOWN: '미확인', NOT_APPLICABLE: '해당 없음' };
export function RoutePanel({ input, revision }: { input: RouteInput; revision: number }) {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<{ key: string; result?: RouteResult; busy: boolean; error?: string }>({ key: '', busy: false });
  const key = JSON.stringify([input, revision, nonce]);
  const visible = state.key === key ? state : undefined;
  const result = visible?.result;
  useEffect(() => {
    const controller = new AbortController();
    setState({ key, busy: true });
    validateRoute(input, browserRouteIO(revision, controller.signal), controller.signal).then(result => {
      if (!controller.signal.aborted) setState({ key, busy: false, result });
    }).catch(error => { if (!controller.signal.aborted) setState({ key, busy: false, error: error instanceof Error ? error.message : '경로 조회 오류입니다.' }); });
    return () => controller.abort();
    // key contains every input field, revision, and refresh request.
  }, [key]);
  const title = result?.configurationStatus === 'FAIL' ? '경로 설정에서 문제를 발견했습니다' : result?.status === 'FAIL' ? '전송 조건에서 문제를 발견했습니다' : result?.configurationStatus === 'PASS' ? '기본 경로 설정이 일치합니다' : '경로 설정에 미확인 항목이 있습니다';
  function checks(scope: RouteCheck['scope']) {
    return <div className="route-checks">{result?.checks.filter(c => c.scope === scope).map(check => <details key={check.id} className={`route-check ${check.status.toLowerCase()}`} open={check.status === 'FAIL'}>
      <summary><span>{check.title}</span><span className="check-badge">{statusText[check.status]}</span></summary>
      <p>{check.detail}</p><p className="check-evidence">{check.chainId ? `${chainById(check.chainId).shortName} · 블록 ${check.blockNumber ? BigInt(check.blockNumber).toLocaleString('en-US') : '미확인'}` : '양쪽 관찰 블록 및 공식 프로토콜 자료 기준'}{check.address && <> · <a href={`${chainById(check.chainId ?? input.sourceChain).explorer}/address/${check.address}#code`} target="_blank" rel="noreferrer">컨트랙트 ↗</a></>}</p>
    </details>)}</div>;
  }
  return <section className="route-panel" aria-labelledby="route-title">
    <div className="section-title"><h2 id="route-title">브릿지 경로</h2><button className="secondary" disabled={visible?.busy} onClick={() => setNonce(n => n + 1)}><RefreshCw size={14} />경로 다시 검증</button></div>
    <p className="route-direction">{chainById(input.sourceChain).shortName}<ArrowRight size={16} />{chainById(input.destinationChain).shortName}</p>
    <div aria-live="polite" aria-busy={visible?.busy ?? true}>
      {(!visible || visible.busy) && <p className="query-progress"><LoaderCircle className="spin" size={18} />양쪽 체인의 브릿지 설정을 확인하고 있습니다.</p>}
      {visible?.error && <div className="alert" role="alert">{visible.error}</div>}
      {result && <>
        <div className={`route-verdict ${(result.status === 'FAIL' ? 'FAIL' : result.configurationStatus).toLowerCase()}`}><strong>{title}</strong><p>{result.status === 'FAIL' ? '실패한 항목의 근거를 확인하세요. 현재 전송 준비 상태가 아닙니다.' : '수량을 입력해 수수료와 전송 조건을 확인하세요.'}</p></div>
        {result.warnings.length > 0 && <ul className="discovery-warnings">{result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
        <details className="evidence-details pathway-details"><summary>컨트랙트 주소·경로 검증 상세</summary><div className="route-sides">{result.source && <Side side={result.source} label="출발" />}{result.destination && <Side side={result.destination} label={result.destination.identity ? '도착 · peer로 발견' : '도착 · 미확인'} />}</div>
        <h3 className="checks-heading">기본 경로 설정</h3>{checks('configuration')}
        </details>
        {result.configurationStatus === 'PASS' && result.checks.some(c => c.scope === "execution" && c.status !== "PASS" && c.status !== "NOT_APPLICABLE") && <details className="evidence-details" open={result.status === "FAIL"}><summary>추가 확인 사항</summary>{checks('execution')}</details>}
        <TransferPanel input={input} revision={revision} routeResult={result} />
      </>}
    </div>
  </section>;
}
function Side({ side, label }: { side: RouteSide; label: string }) {
  return <article className="route-side"><span className="eyebrow">{label}</span><h3>{chainById(side.chainId).shortName} <span>{side.identity?.kind ?? '미확인'}</span></h3>{side.identity && <><Link label="브릿지" address={side.identity.bridgeAddress} chainId={side.chainId} /><Link label={`토큰 · ${side.identity.token.symbol ?? '미확인'}`} address={side.identity.token.address} chainId={side.chainId} /></>}</article>;
}
function Link({ label, address, chainId }: { label: string; address: string; chainId: ChainId }) {
  return <div className="contract-address"><span>{label}</span><a href={`${chainById(chainId).explorer}/address/${address}#code`} target="_blank" rel="noreferrer"><code>{address}</code></a></div>;
}
