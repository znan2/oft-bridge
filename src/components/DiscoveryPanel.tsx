import { useEffect, useState } from 'react';
import { isAddress } from 'viem';
import { ExternalLink, LoaderCircle, Search } from 'lucide-react';
import { chainById, type ChainId } from '../../shared/chains';
import type { CandidateCheck, DiscoveryResult } from '../../shared/discovery';
import { discover } from '../lib/discovery';
import { browserDiscoveryIO } from '../lib/discovery-io';
import { RoutePanel } from './RoutePanel';
import { DEMO } from '../lib/demo-flag';
import { DEMO_TOKEN } from '../demo/constants';

type Mode = 'auto' | 'manual' | 'transaction';
export function DiscoveryPanel({ source, destination, revision, ready }: { source: ChainId; destination: ChainId; revision: number; ready: boolean }) {
  const [ca, setCa] = useState(DEMO ? DEMO_TOKEN : '');
  const [mode, setMode] = useState<Mode>('auto');
  const [manual, setManual] = useState('');
  const [txHash, setTxHash] = useState('');
  const [submitted, setSubmitted] = useState({ key: '', nonce: 0 });
  const [state, setState] = useState<{ key: string; busy: boolean; result?: DiscoveryResult; error?: string }>({ key: '', busy: false });
  const [selection, setSelection] = useState({ result: null as DiscoveryResult | null, address: '' });
  const context = JSON.stringify([source, destination, revision, ca.trim(), mode, manual.trim(), txHash.trim()]);
  const visible = state.key === context ? state : undefined;
  const result = visible?.result;
  const identified = result?.candidates.filter(c => c.status === 'identified') ?? [];
  const chosen = identified.length === 1 ? identified[0].address : selection.result === result ? selection.address : '';

  useEffect(() => {
    if (!ready || !ca.trim()) return;
    const explicit = submitted.key === context;
    if (!explicit && (mode !== 'auto' || !isAddress(ca.trim()))) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setState({ key: context, busy: true });
      try {
        const value = await discover({ chainId: source, tokenAddress: ca,
          ...(mode === 'manual' ? { manualAddress: manual.trim() || 'invalid' } : {}),
          ...(mode === 'transaction' ? { transactionHash: txHash.trim() || 'invalid' } : {}) },
        browserDiscoveryIO(source, revision, controller.signal), controller.signal);
        if (!controller.signal.aborted) setState({ key: context, busy: false, result: value });
      } catch (error) {
        if (!controller.signal.aborted) setState({ key: context, busy: false, error: error instanceof Error ? error.message : '조회 중 오류가 발생했습니다.' });
      }
    }, explicit ? 0 : 450);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [context, submitted, ready, source, revision, ca, mode, manual, txHash]);

  function candidateCard(candidate: CandidateCheck) {
    const identity = candidate.identity;
    return <article className={`candidate-card ${candidate.address === chosen ? 'selected' : ''}`} key={candidate.address}>
      <div className="candidate-heading"><strong>{identity ? `${identity.token.symbol ?? "토큰"}${identity.token.name ? ` · ${identity.token.name}` : ""}` : "확인하지 못한 후보"}</strong>{identity ? <span className="status good">{identity.kind}</span> : <span className="status bad">{candidate.status === 'rpc-error' ? 'RPC 오류' : '미확인'}</span>}</div>
      <AddressLine label="브릿지 컨트랙트" address={candidate.address} source={source} />
      {identity ? <>
        {identity.token.address.toLowerCase() !== candidate.address.toLowerCase() && <AddressLine label="연결된 토큰" address={identity.token.address} source={source} />}
        <details className="evidence-details"><summary>브릿지 확인 근거</summary><ul>{candidate.sources.map((s, i) => <li key={i}>{s.detail}{s.transactionHash && <> · <a href={`${chainById(source).explorer}/tx/${s.transactionHash}`} target="_blank" rel="noreferrer">근거 거래 ↗</a></>}</li>)}</ul></details>
        {identified.length > 1 && <button className={candidate.address === chosen ? 'primary candidate-select' : 'secondary candidate-select'} aria-pressed={candidate.address === chosen} onClick={() => setSelection({ result: result!, address: candidate.address })}>{candidate.address === chosen ? '선택됨' : '이 후보 선택'}</button>}
      </> : <p className="error-text">{candidate.reason}</p>}
    </article>;
  }
  return <section className="panel discovery-panel" aria-labelledby="discovery-title">
    <div className="section-title"><h2 id="discovery-title">토큰 CA로 브릿지 찾기</h2><span className="muted">{chainById(source).shortName}에서 조회</span></div>
    <form onSubmit={event => { event.preventDefault(); setSubmitted({ key: context, nonce: submitted.nonce + 1 }); }}>
      <label className="field-label" htmlFor="token-ca">출발 네트워크의 토큰 CA</label>
      <div className="discovery-input-row"><input id="token-ca" value={ca} onChange={e => setCa(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" /><button className="primary" disabled={!ready || !ca.trim() || visible?.busy} type="submit">{visible?.busy ? <LoaderCircle size={18} className="spin" /> : <Search size={18} />}조회</button></div>
      {ca.trim() && !isAddress(ca.trim()) && <p className="error-text">유효한 42자리 CA를 입력하세요. 혼합 대소문자 주소는 체크섬도 확인합니다.</p>}
      <fieldset className="recovery-options"><legend>탐색 방법</legend><div className="mode-switch">{([['auto', '자동 탐색'], ['manual', '브릿지 주소 직접 입력'], ['transaction', '성공 거래 해시']] as const).map(([value, label]) => <label key={value}><input type="radio" name="discovery-mode" value={value} checked={mode === value} onChange={() => setMode(value)} /><span>{label}</span></label>)}</div>
        {mode === 'manual' && <div className="recovery-field"><label htmlFor="bridge-address">브릿지 컨트랙트 주소</label><input id="bridge-address" value={manual} onChange={e => setManual(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" /><p className="footnote">입력 CA와 token()의 관계를 확인한 뒤 후보를 이 브라우저에 저장합니다.</p></div>}
        {mode === 'transaction' && <div className="recovery-field"><label htmlFor="source-tx">성공한 {chainById(source).shortName} 거래 해시 또는 스캔 링크</label><input id="source-tx" value={txHash} onChange={e => setTxHash(e.target.value)} placeholder="0x… (66자리) 또는 https://…/tx/…" spellCheck={false} autoComplete="off" /><p className="footnote">{chainById(source).shortName}에서 OFT를 보내거나 받은 성공 거래를 입력하세요.</p></div>}
      </fieldset>
    </form>
    <div className="discovery-output" aria-live="polite" aria-busy={visible?.busy ?? false}>
      {visible?.busy && <p className="query-progress"><LoaderCircle className="spin" size={18} />컨트랙트와 토큰 관계를 조회하고 있습니다.</p>}
      {visible?.error && <div role="alert" className="alert">{visible.error}</div>}
      {result && <>
        <div className={identified.length ? 'discovery-summary' : 'alert'} role={identified.length ? 'status' : 'alert'}><strong>{result.message}</strong>{result.status === 'not-found' && <p>자동 탐색 범위에서 찾지 못한 결과입니다. 브릿지 주소나 성공 거래 해시로 보완할 수 있습니다.</p>}{result.status === 'rpc-error' && <p><a className="text-button" href="#networks-title">RPC 설정 확인 ↑</a></p>}</div>
        {mode !== 'transaction' && identified.length === 0 && ['not-found', 'metadata-error', 'unsupported'].includes(result.status) && <button className="secondary" type="button" onClick={() => { setMode('transaction'); window.setTimeout(() => document.getElementById('source-tx')?.focus(), 0); }}>성공한 전송·수신 거래로 찾기</button>}
        
        {result.token && !identified.length && <p className="footnote">입력 토큰: {result.token.symbol ?? '심볼 미확인'} · decimals {result.token.decimals ?? '미확인'}</p>}
        {result.warnings.length > 0 && <ul className="discovery-warnings">{result.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}
        <div className="candidate-grid">{result.candidates.filter(c => c.status === 'identified').map(candidateCard)}</div>
        {result.candidates.some(c => c.status !== 'identified') && <details className="rejected-candidates"><summary>확인하지 못한 후보 {result.candidates.filter(c => c.status !== 'identified').length}개</summary><div className="candidate-grid">{result.candidates.filter(c => c.status !== 'identified').map(candidateCard)}</div></details>}
      </>}
    </div>
    {chosen && identified.find(c => c.address === chosen)?.identity && <RoutePanel key={`${context}:${result!.checkedAt}:${chosen}`} input={{ sourceChain: source, destinationChain: destination, bridgeAddress: chosen, tokenAddress: identified.find(c => c.address === chosen)!.identity!.token.address }} revision={revision} />}
  </section>;
}

function AddressLine({ label, address, source }: { label: string; address: string; source: ChainId }) {
  return <div className="contract-address"><span>{label}</span><a href={`${chainById(source).explorer}/address/${address}#code`} target="_blank" rel="noreferrer"><code>{address}</code><ExternalLink size={13} aria-label="스캔에서 보기" /></a></div>;
}
