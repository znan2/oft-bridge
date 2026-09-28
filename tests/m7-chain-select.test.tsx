// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChainSelect } from '../src/components/ChainSelect';
const mounted = vi.hoisted(()=>({ discovery: vi.fn(), network: vi.fn() }));
vi.mock('../src/lib/api',()=>({api:vi.fn(async()=>({revision:0,chains:[]}))}));
vi.mock('../src/components/WalletPanel',()=>({WalletPanel:()=>null}));
vi.mock('../src/components/ExecutionHistory',()=>({ExecutionHistory:()=>null}));
vi.mock('../src/components/NetworkCard',()=>({NetworkCard:(p:{chainId:number})=>{mounted.network(p);return <span data-testid="network">{p.chainId}</span>;}}));
vi.mock('../src/components/DiscoveryPanel',()=>({DiscoveryPanel:(p:{source:number;destination:number})=>{mounted.discovery(p);return <input aria-label="토큰 CA 테스트" defaultValue="" />;}}));
import App from '../src/App';
afterEach(()=>{cleanup();vi.clearAllMocks();});
describe('M7 network selection',()=>{
  it('searches IDs/EIDs, keeps a valid selection on no match and prevents same-chain selection',()=>{
    render(<ChainSelect label="도착 네트워크" value={1} other={56} onChange={vi.fn()} />);
    const search=screen.getByRole('textbox',{name:'도착 네트워크 검색'});
    expect((screen.getByRole('option',{name:/BSC/}) as HTMLOptionElement).disabled).toBe(true);
    fireEvent.change(search,{target:{value:'30184'}});
    expect(screen.getByRole('option',{name:'Base'})).toBeTruthy();
    fireEvent.change(search,{target:{value:'no-such-network'}});
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('1');
  });
  it('uses independent source/destination, swaps both and clears previous token/quote context; only selected pair mounts RPC cards',()=>{
    render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><App /></QueryClientProvider>);
    fireEvent.change(screen.getByRole('textbox',{name:'토큰 CA 테스트'}),{target:{value:'old context'}});
    fireEvent.change(screen.getByRole('combobox',{name:'도착 네트워크'}),{target:{value:'8453'}});
    expect((screen.getByRole('textbox',{name:'토큰 CA 테스트'}) as HTMLInputElement).value).toBe('');
    expect(screen.getAllByTestId('network').map(el=>el.textContent)).toEqual(['56','8453']);
    expect(mounted.discovery).toHaveBeenLastCalledWith(expect.objectContaining({source:56,destination:8453}));
    fireEvent.click(screen.getByRole('button',{name:'출발과 도착 네트워크 바꾸기'}));
    expect(screen.getAllByTestId('network').map(el=>el.textContent)).toEqual(['8453','56']);
    expect(mounted.discovery).toHaveBeenLastCalledWith(expect.objectContaining({source:8453,destination:56}));
    expect(mounted.network.mock.calls.every(([p])=>[1,56,8453].includes(p.chainId))).toBe(true);
  });
});
