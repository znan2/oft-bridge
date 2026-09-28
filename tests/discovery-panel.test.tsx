// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DiscoveryPanel } from '../src/components/DiscoveryPanel';
import { discover } from '../src/lib/discovery';
import { RoutePanel } from '../src/components/RoutePanel';
import type { DiscoveryResult } from '../shared/discovery';
import { TOKEN, BRIDGE, OTHER, ENDPOINT } from './helpers/discovery';
vi.mock('../src/lib/discovery', () => ({ discover: vi.fn() }));
vi.mock('../src/lib/discovery-io', () => ({ browserDiscoveryIO: vi.fn(() => ({})) }));
vi.mock('../src/components/RoutePanel', () => ({ RoutePanel: vi.fn(() => null) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const base = (): DiscoveryResult => ({ status: 'not-found', message: 'Pool 컨트랙트를 찾지 못했습니다.', inputAddress: TOKEN, chainId: 56, blockNumber: '0x100', checkedAt: new Date().toISOString(), token: null, catalog: null, candidates: [], warnings: [] });
function found(address = BRIDGE): DiscoveryResult {
  return { ...base(), status: 'found', message: '브릿지 컨트랙트 후보를 확인했습니다.', candidates: [{ address, status: 'identified', reason: 'ok', sources: [{ source: 'manual', detail: '직접 입력' }], identity: { bridgeAddress: address, kind: 'OFTAdapter', token: { address: TOKEN, name: 'Test', symbol: 'TEST', decimals: 18 }, endpoint: ENDPOINT, interfaceId: '0x02e49c2c', messageVersion: '1', approvalRequired: true, sharedDecimals: 6 } }] };
}
function enterCA(value = TOKEN) { fireEvent.change(screen.getByLabelText('출발 네트워크의 토큰 CA'), { target: { value } }); }
function submit() { fireEvent.click(screen.getByRole('button', { name: '조회' })); }
describe('discovery dashboard flow', () => {
  it('automatically queries a valid CA and shows exact not-found text with recovery controls', async () => {
    vi.mocked(discover).mockResolvedValue(base());
    render(<DiscoveryPanel source={56} destination={1} revision={0} ready />);
    enterCA();
    expect(await screen.findByText('Pool 컨트랙트를 찾지 못했습니다.')).toBeTruthy();
    expect(screen.getByLabelText('브릿지 주소 직접 입력')).toBeTruthy();
    expect(screen.getByLabelText('성공 거래 해시')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '성공한 전송·수신 거래로 찾기' }));
    expect(screen.getByLabelText('성공한 BSC 거래 해시 또는 스캔 링크')).toBeTruthy();
  });
  it('accepts a received transaction link and identifies its evidence without implying reverse route readiness', async () => {
    const hash = '0x' + '12'.repeat(32);
    const value = { ...found(), chainId: 1 as const, transactions: [{ kind: 'receive' as const, hash, bridgeAddress: BRIDGE, blockNumber: '0x100', guid: hash, srcEid: 30311, recipient: OTHER, endpoint: ENDPOINT }] };
    vi.mocked(discover).mockResolvedValue(value);
    render(<DiscoveryPanel source={1} destination={56} revision={0} ready />);
    fireEvent.click(screen.getByLabelText('성공 거래 해시')); enterCA();
    const link = `https://etherscan.io/tx/${hash}`;
    fireEvent.change(screen.getByLabelText('성공한 Ethereum 거래 해시 또는 스캔 링크'), { target: { value: link } }); submit();
    expect(await screen.findByText('OFTAdapter')).toBeTruthy();
    expect(discover).toHaveBeenCalledWith(expect.objectContaining({ chainId: 1, tokenAddress: TOKEN, transactionHash: link }), expect.anything(), expect.any(AbortSignal));
    expect(RoutePanel).toHaveBeenCalledWith(expect.objectContaining({ input: { sourceChain: 1, destinationChain: 56, bridgeAddress: BRIDGE, tokenAddress: TOKEN } }), undefined);
    expect(screen.queryByRole('button', { name: /^전송$/ })).toBeNull();
  });
  it('shows RPC failure separately and links to RPC settings', async () => {
    vi.mocked(discover).mockResolvedValue({ ...base(), status: 'rpc-error', message: 'RPC 오류 — BSC 조회를 완료하지 못했습니다.' });
    render(<DiscoveryPanel source={56} destination={1} revision={2} ready />); enterCA(); submit();
    expect(await screen.findByText('RPC 오류 — BSC 조회를 완료하지 못했습니다.')).toBeTruthy();
    expect(screen.queryByText('Pool 컨트랙트를 찾지 못했습니다.')).toBeNull();
    expect(screen.getByRole('link', { name: /RPC 설정/ }).getAttribute('href')).toBe('#networks-title');
  });
  it('submits manual recovery and displays distinct bridge/token addresses', async () => {
    vi.mocked(discover).mockResolvedValue(found());
    render(<DiscoveryPanel source={56} destination={1} revision={0} ready />);
    fireEvent.click(screen.getByLabelText('브릿지 주소 직접 입력')); enterCA();
    fireEvent.change(screen.getByLabelText('브릿지 컨트랙트 주소'), { target: { value: BRIDGE } }); submit();
    expect(await screen.findByText('OFTAdapter')).toBeTruthy();
    expect(discover).toHaveBeenCalledWith(expect.objectContaining({ tokenAddress: TOKEN, manualAddress: BRIDGE }), expect.anything(), expect.any(AbortSignal));
    expect(screen.getByText(BRIDGE)).toBeTruthy(); expect(screen.getByText(TOKEN)).toBeTruthy();
    expect(RoutePanel).toHaveBeenCalledWith(expect.objectContaining({ input: { sourceChain: 56, destinationChain: 1, bridgeAddress: BRIDGE, tokenAddress: TOKEN } }), undefined);
    expect(screen.queryByRole('button', { name: /전송|approve|send/ })).toBeNull();
  });
  it('requires an explicit choice among multiple candidates and resets the choice on refresh', async () => {
    vi.mocked(discover).mockResolvedValue({ ...found(), status: 'multiple', candidates: [...found().candidates, ...found(OTHER).candidates] });
    render(<DiscoveryPanel source={56} destination={1} revision={0} ready />); enterCA(); submit();
    const choices = await screen.findAllByRole('button', { name: '이 후보 선택' });
    expect(RoutePanel).not.toHaveBeenCalled();
    fireEvent.click(choices[1]);
    expect(screen.getByRole('button', { name: '선택됨' }).getAttribute('aria-pressed')).toBe('true');
    expect(RoutePanel).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ bridgeAddress: OTHER }) }), undefined);
    vi.mocked(discover).mockResolvedValue({ ...found(), status: 'multiple', candidates: [...found().candidates, ...found(OTHER).candidates] });
    submit();
    await waitFor(() => expect(screen.queryByRole('button', { name: '선택됨' })).toBeNull());
  });
  it('hides stale results immediately and ignores an old response after CA change', async () => {
    let resolveOld!: (value: DiscoveryResult) => void;
    vi.mocked(discover).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValueOnce({ ...base(), inputAddress: OTHER });
    render(<DiscoveryPanel source={56} destination={1} revision={0} ready />); enterCA(); submit();
    await waitFor(() => expect(discover).toHaveBeenCalledTimes(1));
    enterCA(OTHER); submit();
    await screen.findByText('Pool 컨트랙트를 찾지 못했습니다.');
    await act(async () => { resolveOld(found()); });
    expect(screen.queryByText('OFTAdapter')).toBeNull();
  });
  it('aborts an in-flight read and hides results when RPC revision or chain changes', async () => {
    let resolveOld!: (value: DiscoveryResult) => void;
    vi.mocked(discover).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    const view = render(<DiscoveryPanel key="56:0" source={56} destination={1} revision={0} ready />); enterCA(); submit();
    await waitFor(() => expect(discover).toHaveBeenCalledTimes(1));
    const signal = vi.mocked(discover).mock.calls[0][2]!;
    view.rerender(<DiscoveryPanel key="1:1" source={1} destination={56} revision={1} ready />);
    expect(signal.aborted).toBe(true);
    await act(async () => { resolveOld(found()); });
    expect(screen.queryByText('OFTAdapter')).toBeNull();
    expect((screen.getByLabelText('출발 네트워크의 토큰 CA') as HTMLInputElement).value).toBe('');
  });
});
