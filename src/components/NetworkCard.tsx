import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, RefreshCw, Settings2 } from 'lucide-react';
import { chainById, type ChainId } from '../../shared/chains';
import type { NetworkHealth, RpcSetting, SettingsResponse } from '../../shared/api';
import { api } from '../lib/api';

export function NetworkCard({ chainId, revision, setting }: { chainId: ChainId; revision: number; setting?: RpcSetting }) {
  const chain = chainById(chainId);
  const client = useQueryClient();
  const fieldId = useId();
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState('');
  const [notice, setNotice] = useState('');
  const health = useQuery({ queryKey: ['rpc-health', chainId, revision], queryFn: ({ signal }) => api<NetworkHealth>(`/chains/${chainId}/health`, { signal }), retry: false, staleTime: 20000 });
  const update = useMutation({
    mutationFn: (value: string | null) => api<SettingsResponse>(`/settings/rpc/${chainId}`, value === null ? { method: 'DELETE' } : { method: 'PUT', body: JSON.stringify({ url: value }) }),
    onSuccess: async settings => {
      await client.cancelQueries({ queryKey: ['rpc-health', chainId] });
      await client.cancelQueries({ queryKey: ['native-balance', chainId] });
      client.setQueryData<SettingsResponse>(['rpc-settings'], current => current && current.revision > settings.revision ? current : settings);
      setUrl(''); setNotice('RPC 설정을 적용했습니다.');
    },
  });
  const status = health.isFetching ? '조회 중' : health.isError ? '조회 오류' : health.data ? '정상' : '대기';
  return <article className="network-card">
    <header className="network-heading"><div className={`chain-mark ${chain.key}`} aria-hidden="true">{chain.shortName.slice(0, 1)}</div><div><h3>{chain.shortName}</h3></div><span role="status" className={`status ${health.isError ? 'bad' : health.isFetching ? 'pending' : health.data ? 'good' : ''}`}><i />{status}</span></header>
    {health.error ? <div className="alert" role="alert"><p>{health.error.message}</p><button className="text-button" onClick={() => { setEditing(true); setNotice(''); }}>RPC 직접 입력</button></div> : <div className="rpc-observation"><span>{health.data?.host ?? 'RPC에 연결하는 중…'}{health.data?.mode === 'env' ? ' · 환경변수 RPC' : ''}{health.data?.fallbackUsed ? ' · 대체 RPC' : ''}</span></div>}
    <div className="card-actions"><button className="text-button" onClick={() => health.refetch()} disabled={health.isFetching || update.isPending}><RefreshCw size={14} className={health.isFetching ? 'spin' : ''} />다시 조회</button><button className="text-button" aria-expanded={editing} aria-controls={fieldId} onClick={() => { setEditing(v => !v); setNotice(''); }}><Settings2 size={14} />RPC 설정<ChevronDown size={14} /></button></div>
    {editing && <form id={fieldId} className="rpc-form" onSubmit={e => { e.preventDefault(); setNotice(''); update.mutate(url.trim()); }}>
      <p className="footnote">Chain ID {chain.id} · EID {chain.eid}</p><label htmlFor={`${fieldId}-url`}>{chain.shortName} RPC 주소</label>
      {setting?.custom && <p className="footnote">현재 설정: {setting.host}</p>}
      <input id={`${fieldId}-url`} type="url" placeholder="https://…" value={url} onChange={e => { setUrl(e.target.value); update.reset(); setNotice(''); }} autoComplete="off" spellCheck={false} disabled={update.isPending} />
      <p className="footnote">연결과 네트워크를 확인한 뒤 이 PC에 저장합니다.</p>
      <div className="rpc-form-actions"><button className="secondary" type="submit" disabled={!url.trim() || update.isPending}>{update.isPending ? '확인 중…' : '확인 후 적용'}</button>{setting?.custom && <button className="text-button" type="button" disabled={update.isPending} onClick={() => { setNotice(''); update.mutate(null); }}>공개 RPC로 복귀</button>}</div>
      {update.error && <p className="error-text" role="alert">{update.error.message}</p>}
      {notice && <p className="success-text" role="status"><Check size={14} />{notice}</p>}
    </form>}
  </article>;
}
