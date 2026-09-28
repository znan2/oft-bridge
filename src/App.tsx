import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight } from 'lucide-react';
import { CHAINS, chainById, type ChainId } from '../shared/chains';
import type { SettingsResponse } from '../shared/api';
import { api } from './lib/api';
import { DEMO } from './lib/demo-flag';
import { useRuntime } from './lib/runtime';
import { WalletPanel } from './components/WalletPanel';
import { NetworkCard } from './components/NetworkCard';
import { DiscoveryPanel } from './components/DiscoveryPanel';
import { ChainSelect } from './components/ChainSelect';
import { ExecutionHistory } from './components/ExecutionHistory';

export default function App() {
  const queryClient = useQueryClient();
  const runtime = useRuntime();
  // The registry lists the default pair first (testnet: Sepolia → Base Sepolia, mainnet: BSC → Ethereum).
  const [source, setSource] = useState<ChainId>(CHAINS[0].id);
  const [destination, setDestination] = useState<ChainId>(CHAINS[1].id);
  const settings = useQuery({ queryKey: ['rpc-settings'], queryFn: ({ signal }) => api<SettingsResponse>('/settings/rpc', { signal }), retry: false });
  const revision = settings.data?.revision ?? 0;
  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="/"><span className="brand-mark"><ArrowLeftRight size={20} /></span>OFT<span>Bridge</span></a>
      <div className="mode-badges" aria-label="실행 모드">
        {DEMO && <span className="mode-badge">DEMO · 목업 데이터</span>}
        <span className={`mode-badge ${runtime.network === 'mainnet' ? 'warn' : ''}`}>{runtime.network === 'mainnet' ? 'MAINNET' : 'TESTNET'}</span>
        <span className={`mode-badge ${runtime.executionMode === 'live' ? 'warn' : ''}`}>{runtime.executionMode === 'live' ? 'LIVE · 서명 가능' : 'DRY-RUN'}</span>
        <span className="local-badge"><i />LOCAL</span>
      </div>
    </header>
    <main>
      <div className="page-heading"><div><h1>브릿지 전송과 도착 확인</h1><p>토큰 CA로 LayerZero OFT 경로를 찾고, 양쪽 체인 설정과 예상 수수료를 검증합니다.</p></div></div>
      {runtime.mismatch && <div className="alert" role="alert">서버 네트워크({runtime.network})와 화면 빌드 네트워크가 다릅니다. 서명 요청을 비활성화했습니다. 같은 OFT_NETWORK로 다시 시작하세요.</div>}
      <div className="route-strip"><ChainSelect label="출발 네트워크" value={source} other={destination} onChange={setSource} /><button className="swap-button" aria-label="출발과 도착 네트워크 바꾸기" onClick={() => { setSource(destination); setDestination(source); }}><ArrowLeftRight size={18} /></button><ChainSelect label="도착 네트워크" value={destination} other={source} onChange={setDestination} /></div>
      {chainById(source).sourceRestriction && <div className="alert" role="status">{chainById(source).shortName}: {chainById(source).sourceRestriction}</div>}
      {settings.error && <div className="alert settings-error" role="alert"><p>{settings.error.message}</p><button className="secondary" onClick={async () => { const result = await settings.refetch(); if (result.isSuccess) await Promise.all(['rpc-health', 'native-balance'].map(key => queryClient.invalidateQueries({ queryKey: [key], refetchType: 'active' }))); }}>서버 다시 확인</button></div>}
      <div className="workspace-grid"><WalletPanel source={source} revision={revision} /><section className="panel networks-panel" aria-labelledby="networks-title"><div className="section-title"><h2 id="networks-title">RPC 연결</h2></div><div className="network-grid">{[source, destination].map(chainId => <NetworkCard key={chainId} chainId={chainId} revision={revision} setting={settings.data?.chains.find(s => s.chainId === chainId)} />)}</div></section></div>
      <DiscoveryPanel key={`${source}:${destination}:${revision}`} source={source} destination={destination} revision={revision} ready={settings.isSuccess} />
      <ExecutionHistory revision={revision} />
    </main><footer className="app-footer"><span>OFT Bridge · 감사받지 않은 코드 · 사용 책임은 사용자에게 있습니다</span><span>{chainById(source).shortName} <span className="dim">→</span> {chainById(destination).shortName}</span></footer>
  </div>;
}
