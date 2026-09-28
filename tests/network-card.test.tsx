// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { NetworkCard } from '../src/components/NetworkCard';
import type { SettingsResponse } from '../shared/api';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const original: SettingsResponse = { revision: 0, chains: [{ chainId: 56, custom: false, host: null }] };
const changed: SettingsResponse = { revision: 1, chains: [{ chainId: 56, custom: true, host: 'custom.test' }] };
const health = { chainId: 56, revision: 0, blockNumber: '100', latencyMs: 40, checkedAt: '2026-09-06T06:00:00Z', mode: 'public', host: 'public.test', fallbackUsed: false };
function mounted() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['rpc-settings'], original);
  function Card() {
    const { data } = useQuery({ queryKey: ['rpc-settings'], queryFn: async () => original, staleTime: Infinity });
    return <NetworkCard chainId={56} revision={data!.revision} setting={data!.chains[0]} />;
  }
  render(<QueryClientProvider client={client}><Card /></QueryClientProvider>);
  return client;
}
describe('RPC error and manual settings flow', () => {
  it('clearly labels an RPC failure and applies a validated custom RPC before retrying', async () => {
    let custom = false;
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === 'PUT') { custom = true; return Response.json(changed); }
      if (init?.method === 'DELETE') { custom = false; return Response.json({ ...original, revision: 2 }); }
      return custom ? Response.json({ ...health, revision: 1, mode: 'custom', host: 'custom.test', blockNumber: '101' }) : Response.json({ code: 'RPC_ERROR', message: 'RPC 오류 — BSC 조회를 완료하지 못했습니다.' }, { status: 503 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = mounted(); const user = userEvent.setup();
    expect(await screen.findByText('RPC 오류 — BSC 조회를 완료하지 못했습니다.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'RPC 직접 입력' }));
    await user.type(screen.getByLabelText('BSC RPC 주소'), 'https://custom.test/private-key');
    await user.click(screen.getByRole('button', { name: '확인 후 적용' }));
    expect(await screen.findByText('custom.test')).toBeTruthy();
    expect(screen.queryByText('RPC 오류 — BSC 조회를 완료하지 못했습니다.')).toBeNull();
    expect((screen.getByLabelText('BSC RPC 주소') as HTMLInputElement).value).toBe('');
    expect(client.getQueryData<SettingsResponse>(['rpc-settings'])?.revision).toBe(1);
    await user.click(screen.getByRole('button', { name: '공개 RPC로 복귀' }));
    await waitFor(() => expect(client.getQueryData<SettingsResponse>(['rpc-settings'])?.revision).toBe(2));
    client.clear();
  });
  it('preserves the existing RPC when a new address fails chain validation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_: string, init?: RequestInit) => init?.method === 'PUT'
      ? Response.json({ code: 'RPC_CHAIN_MISMATCH', message: 'RPC 오류 — 선택한 BSC 네트워크와 일치하지 않습니다.' }, { status: 503 })
      : Response.json(health)));
    const client = mounted(); const user = userEvent.setup();
    await screen.findByText('public.test');
    await user.click(screen.getByRole('button', { name: 'RPC 설정' }));
    await user.type(screen.getByLabelText('BSC RPC 주소'), 'https://ethereum.test');
    await user.click(screen.getByRole('button', { name: '확인 후 적용' }));
    expect(await screen.findByText(/RPC 오류 — 선택한 BSC/)).toBeTruthy();
    expect(client.getQueryData(['rpc-settings'])).toEqual(original);
    client.clear();
  });
  it('ignores an old settings response that arrives after another chain was changed', async () => {
    let finish: (value: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(async (_: string, init?: RequestInit) => init?.method === 'PUT'
      ? new Promise<Response>(resolve => { finish = resolve; }) : Response.json(health)));
    const client = mounted(); const user = userEvent.setup();
    await screen.findByText('public.test');
    await user.click(screen.getByRole('button', { name: 'RPC 설정' }));
    await user.type(screen.getByLabelText('BSC RPC 주소'), 'https://custom.test');
    await user.click(screen.getByRole('button', { name: '확인 후 적용' }));
    act(() => client.setQueryData(['rpc-settings'], { ...changed, revision: 2 }));
    await act(async () => finish(Response.json(changed)));
    await screen.findByText('RPC 설정을 적용했습니다.');
    expect(client.getQueryData<SettingsResponse>(['rpc-settings'])?.revision).toBe(2);
    client.clear();
  });
});
