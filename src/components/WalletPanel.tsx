import { useState } from 'react';
import { useConnection, useConnect, useConnectors, useDisconnect, useSwitchChain } from 'wagmi';
import { useQuery } from '@tanstack/react-query';
import { formatEther } from 'viem';
import { ArrowUpRight, Check, Copy, Wallet, RefreshCw } from 'lucide-react';
import { chainById, isChainId, type ChainId } from '../../shared/chains';
import { rabbyConnectors, walletError, sessionKey } from '../lib/wallet';
import { nativeBalance } from '../lib/api';

export function WalletPanel({ source, revision }: { source: ChainId; revision: number }) {
  const connection = useConnection();
  const connectors = rabbyConnectors(useConnectors());
  const connect = useConnect();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);
  const connected = connection.isConnected && connection.connector?.id === 'io.rabby';
  const currentKey = sessionKey(connection.address, connection.chainId, connection.connector?.uid);
  const balance = useQuery({
    queryKey: ['native-balance', source, revision, currentKey],
    queryFn: ({ signal }) => nativeBalance(source, connection.address!, signal),
    enabled: connected, retry: false, staleTime: 15000,
  });
  const busy = connect.isPending || disconnect.isPending || switchChain.isPending;
  async function connectRabby() {
    if (connectors.length !== 1 || busy) return;
    setNotice('');
    try { await connect.mutateAsync({ connector: connectors[0] }); }
    catch (error) { setNotice(walletError(error)); }
  }
  async function changeChain() {
    setNotice('');
    try { await switchChain.mutateAsync({ chainId: source }); }
    catch (error) { setNotice(walletError(error)); }
  }
  async function disconnectWallet() {
    setNotice('');
    try { await disconnect.mutateAsync({}); }
    catch (error) { setNotice(walletError(error)); }
  }
  async function copyAddress() {
    try { await navigator.clipboard.writeText(connection.address!); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { setNotice('주소를 복사하지 못했습니다. 표시된 주소를 직접 복사하세요.'); }
  }
  return <section className="panel wallet-panel" aria-labelledby="wallet-title">
    <h2 id="wallet-title">내 지갑</h2>
    {connected ? <>
      <div className="wallet-identity"><span className="wallet-avatar"><Wallet size={24} /></span><div><strong>Rabby Wallet</strong><span className="status good"><i />연결됨</span></div></div>
      <div className="address-row"><code aria-label="연결 주소">{connection.address}</code><button className="icon-button" onClick={copyAddress} aria-label="지갑 주소 복사">{copied ? <Check size={16} /> : <Copy size={16} />}</button></div>
      <dl className="wallet-facts"><div><dt>지갑 네트워크</dt><dd>{isChainId(connection.chainId) ? chainById(connection.chainId).shortName : `미지원 체인 (${connection.chainId})`}</dd></div><div><dt>{chainById(source).shortName} 잔액</dt><dd>{balance.data !== undefined ? `${formatEther(balance.data)} ${chainById(source).symbol}` : balance.isPending ? '조회 중…' : '조회 실패'}</dd></div></dl>
      {balance.error && <div className="alert" role="alert"><p>{balance.error.message}</p><button className="text-button" onClick={() => balance.refetch()} disabled={balance.isFetching}>잔액 다시 조회</button></div>}
      {connection.chainId !== source && <div className="alert"><p>선택한 출발 체인과 지갑 네트워크가 다릅니다.</p><button className="secondary" onClick={changeChain} disabled={busy}>{switchChain.isPending ? 'Rabby 확인 대기…' : `${chainById(source).shortName}로 전환`}</button></div>}
      <button className="text-button muted disconnect" onClick={disconnectWallet} disabled={busy}>연결 해제</button>
    </> : <>
      <div className="wallet-placeholder"><Wallet size={32} strokeWidth={1.3} /><p>Rabby를 연결하면 수량을 입력할 수 있습니다.</p></div>
      <button className="primary connect-button" onClick={connectRabby} disabled={connectors.length !== 1 || busy}><Wallet size={18} />{connect.isPending ? 'Rabby 확인 대기…' : 'Rabby 연결'}<ArrowUpRight size={18} /></button>
      {connectors.length === 0 && <div className="wallet-help"><p>이 브라우저에서 Rabby 확장이 감지되지 않았습니다. Rabby가 설치된 브라우저에서 같은 주소를 열어주세요.</p><button className="text-button" onClick={() => window.dispatchEvent(new Event('eip6963:requestProvider'))}><RefreshCw size={14} />확장 다시 찾기</button></div>}
      {connectors.length > 1 && <p className="error-text">Rabby가 여러 개 감지되었습니다. 중복 확장을 확인하세요.</p>}
    </>}
    {notice && <p role="status" className="alert">{notice}</p>}
  </section>;
}
