// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createWalletConfig, sessionKey } from '../src/lib/wallet';
import { WalletPanel } from '../src/components/WalletPanel';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
class FakeWallet extends EventEmitter {
  address = A;
  chainId = '0x38';
  rejectNext = false;
  request = vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
    if (this.rejectNext && ['wallet_requestPermissions', 'eth_requestAccounts'].includes(method)) { this.rejectNext = false; throw Object.assign(new Error('User denied'), { code: 4001 }); }
    if (method === 'eth_chainId') return this.chainId;
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [this.address];
    if (method === 'wallet_requestPermissions' || method === 'wallet_getPermissions') return [{ parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: [this.address] }] }];
    if (method === 'wallet_revokePermissions') return null;
    if (method === 'wallet_switchEthereumChain') { this.chainId = (params![0] as { chainId: string }).chainId; this.emit('chainChanged', this.chainId); return null; }
    throw Object.assign(new Error('Unsupported mock method: ' + method), { code: -32601 });
  });
}
const disposers: (() => void)[] = [];
afterEach(() => { cleanup(); disposers.splice(0).forEach(fn => fn()); localStorage.clear(); vi.unstubAllGlobals(); });
function mount(includeRabby = true, source: number = 56) {
  const rabby = new FakeWallet(); const metamask = new FakeWallet();
  const announce = () => {
    for (const [rdns, provider, uuid] of [
      ['io.metamask', metamask, '11111111-1111-4111-8111-111111111111'],
      ...(includeRabby ? [['io.rabby', rabby, '22222222-2222-4222-8222-222222222222']] : []),
    ] as const) window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { rdns, name: rdns, uuid, icon: 'data:image/png;base64,aA==' }, provider } }));
  };
  window.addEventListener('eip6963:requestProvider', announce);
  const config = createWalletConfig();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  disposers.push(() => { window.removeEventListener('eip6963:requestProvider', announce); config._internal.mipd?.destroy(); queryClient.clear(); });
  const fetchMock = vi.fn(async (_input?: unknown) => Response.json({ jsonrpc: '2.0', id: 'balance', result: '0xde0b6b3a7640000' }));
  vi.stubGlobal('fetch', fetchMock);
  render(<WagmiProvider config={config} reconnectOnMount={false}><QueryClientProvider client={queryClient}><WalletPanel source={source} revision={0} /></QueryClientProvider></WagmiProvider>);
  return { rabby, metamask, fetchMock };
}

describe('Rabby connection with a mock EIP-6963 provider', () => {
  it('selects Rabby when MetaMask is also present and refreshes on account changes', async () => {
    const { rabby, metamask, fetchMock } = mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Rabby 연결' }));
    expect(await screen.findByText(A)).toBeTruthy();
    expect(await screen.findByText('1 BNB')).toBeTruthy();
    expect(metamask.request).not.toHaveBeenCalled();
    act(() => { rabby.address = B; rabby.emit('accountsChanged', [B]); });
    expect(await screen.findByText(B)).toBeTruthy();
    expect(screen.queryByText(A)).toBeNull();
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    act(() => { rabby.emit('accountsChanged', []); });
    await waitFor(() => expect(screen.queryByText(B)).toBeNull());
    expect(screen.queryByText('1 BNB')).toBeNull();
  });
  it('handles rejection as cancellation and permits a later retry', async () => {
    const { rabby } = mount(); rabby.rejectNext = true;
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Rabby 연결' }));
    expect(await screen.findByText(/Rabby에서 요청을 취소했습니다/)).toBeTruthy();
    expect(screen.queryByText(A)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Rabby 연결' }));
    expect(await screen.findByText(A)).toBeTruthy();
  });
  it('does not silently connect another wallet when Rabby is absent', async () => {
    const { metamask } = mount(false);
    expect((screen.getByRole('button', { name: 'Rabby 연결' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Rabby 확장이 감지되지 않았습니다/)).toBeTruthy();
    expect(metamask.request).not.toHaveBeenCalled();
  });
  it('shows a chain mismatch and requests switching only after the user clicks', async () => {
    const { rabby } = mount(true, 1);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Rabby 연결' }));
    const switchButton = await screen.findByRole('button', { name: 'Ethereum로 전환' });
    expect(rabby.chainId).toBe('0x38');
    await user.click(switchButton);
    await waitFor(() => expect(screen.queryByText('선택한 출발 체인과 지갑 네트워크가 다릅니다.')).toBeNull());
    expect(rabby.chainId).toBe('0x1');
    act(() => { rabby.chainId = '0xf4240'; rabby.emit('chainChanged', '0xf4240'); });
    expect(await screen.findByText('미지원 체인 (1000000)')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '연결 해제' }));
    await waitFor(() => expect(screen.queryByText(A)).toBeNull());
  });
  it('switches Rabby to a newly registered Base chain and reads its balance', async () => {
    const { rabby, fetchMock } = mount(true, 8453);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Rabby 연결' }));
    await user.click(await screen.findByRole('button', { name: 'Base로 전환' }));
    await waitFor(() => expect(rabby.chainId).toBe('0x2105'));
    expect(await screen.findByText('1 ETH')).toBeTruthy();
    expect(fetchMock.mock.calls.some(args => String(args[0]).includes('/rpc/8453'))).toBe(true);
    expect(vi.mocked(rabby.request).mock.calls.some(([a]) => /sendTransaction|sign/.test(a.method))).toBe(false);
  });
  it('changes the context key whenever account, chain or provider changes', () => {
    expect(new Set([sessionKey(A, 56, 'rabby1'), sessionKey(B, 56, 'rabby1'), sessionKey(A, 1, 'rabby1'), sessionKey(A, 56, 'rabby2'), sessionKey()]).size).toBe(5);
  });
});
