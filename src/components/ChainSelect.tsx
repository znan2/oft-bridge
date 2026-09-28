import { useId, useState } from 'react';
import { CHAINS, chainById, type ChainId } from '../../shared/chains';
export function ChainSelect({ label, value, other, onChange }: { label: string; value: ChainId; other: ChainId; onChange: (id: ChainId) => void }) {
  const id = useId(), [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const matches = CHAINS.filter(c => `${c.name} ${c.shortName} ${c.key} ${c.id} ${c.eid}`.toLowerCase().includes(needle));
  const options = matches.some(c => c.id === value) ? matches : [chainById(value), ...matches];
  return <div className="chain-select">
    <label className="eyebrow" htmlFor={`${id}-select`}>{label}</label>
    <input aria-label={`${label} 검색`} placeholder="네트워크 검색" value={query} onChange={e => setQuery(e.target.value)} autoComplete="off" />
    <select id={`${id}-select`} value={value} onChange={e => { onChange(Number(e.target.value)); setQuery(''); }}>
      {options.map(c => <option key={c.id} value={c.id} disabled={c.id === other}>{c.shortName}{label === '출발 네트워크' && c.sourceRestriction ? ' · 조회 전용' : ''}</option>)}
    </select>
    {needle && <small role="status">검색 결과 {matches.length}개{!matches.length ? ' · 현재 선택 유지' : ''}</small>}
  </div>;
}
