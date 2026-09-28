// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RoutePanel } from '../src/components/RoutePanel';
import { validateRoute } from '../src/lib/route';
import type { RouteResult } from '../shared/route';
import { routeInput } from './helpers/route';
import { TOKEN, BRIDGE, OTHER } from './helpers/discovery';
vi.mock('../src/lib/route', () => ({ validateRoute: vi.fn() }));
vi.mock('../src/lib/route-io', () => ({ browserRouteIO: vi.fn(() => ({})) }));
vi.mock('wagmi', () => ({ useConnection: () => ({ isConnected: true, address: '0x0000000000000000000000000000000000000091', chainId: 56, connector: { id: 'io.rabby', uid: 'mock-rabby' } }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function result(): RouteResult { return { input: routeInput, checkedAt: new Date().toISOString(), status: 'UNKNOWN', configurationStatus: 'PASS', executionReady: false, warnings: [], checks: [
  { id: 'peer', title: '목적지 peer', scope: 'configuration', status: 'PASS', detail: '양쪽 연결 확인' },
  { id: 'custom', title: '커스텀 제약', scope: 'execution', status: 'UNKNOWN', detail: '민팅 권한 미확인' },
], destination: { chainId: 1, blockNumber: '0x200', identity: { bridgeAddress: BRIDGE, kind: 'OFTAdapter', token: { address: OTHER, name: 'Test', symbol: 'TEST', decimals: 18 }, endpoint: TOKEN, interfaceId: '0x02e49c2c', messageVersion: '1', approvalRequired: true, sharedDecimals: 6 } } }; }
describe('route inspection UI', () => {
  it('shows config verification separately from execution readiness and displays the discovered destination', async () => {
    vi.mocked(validateRoute).mockResolvedValue(result());
    render(<RoutePanel input={routeInput} revision={4} />);
    expect(await screen.findByText('기본 경로 설정이 일치합니다')).toBeTruthy();
    expect(screen.getByText(/수량을 입력해 수수료와 전송 조건/)).toBeTruthy(); expect(screen.getByText('커스텀 제약')).toBeTruthy();
    expect(screen.getByText(BRIDGE)).toBeTruthy(); expect(screen.getByText(OTHER)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^전송$|approve|send/ })).toBeNull();
  });
  it('opens failed checks with their reason and does not show a passing headline', async () => {
    const value = result(); value.configurationStatus = 'FAIL'; value.status = 'FAIL';
    value.checks[0] = { ...value.checks[0], status: 'FAIL', detail: '목적지 peer가 다릅니다.' };
    vi.mocked(validateRoute).mockResolvedValue(value);
    render(<RoutePanel input={routeInput} revision={0} />);
    expect(await screen.findByText('경로 설정에서 문제를 발견했습니다')).toBeTruthy();
    expect(screen.getByText('목적지 peer가 다릅니다.').closest('details')?.open).toBe(true);
    expect((screen.getByLabelText('보낼 수량') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '견적 생성 · 시뮬레이션' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('목적지 peer: 목적지 peer가 다릅니다.');
    fireEvent.click(screen.getByRole('button', { name: '견적 생성 · 시뮬레이션' }));
    expect(validateRoute).toHaveBeenCalledTimes(1);
  });
  it('keeps the amount field visible with an explicit RPC cause for an unknown route', async () => {
    const value = result(); value.configurationStatus = 'UNKNOWN';
    value.checks[0] = { ...value.checks[0], status: 'UNKNOWN', detail: 'RPC 오류 — 공개 노드 응답 없음' };
    vi.mocked(validateRoute).mockResolvedValue(value);
    render(<RoutePanel input={routeInput} revision={0} />);
    await screen.findByText('경로 설정에 미확인 항목이 있습니다');
    expect((screen.getByLabelText('보낼 수량') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('RPC 오류 — 공개 노드 응답 없음');
    expect(screen.getByRole('alert').textContent).toContain('네트워크 RPC 설정');
  });
  it('invalidates results while rechecking and clears the old report when revision changes', async () => {
    vi.mocked(validateRoute).mockResolvedValueOnce(result()).mockImplementation(() => new Promise(() => {}));
    const view = render(<RoutePanel input={routeInput} revision={0} />);
    await screen.findByText('기본 경로 설정이 일치합니다');
    fireEvent.click(screen.getByRole('button', { name: '경로 다시 검증' }));
    expect(screen.queryByText('기본 경로 설정이 일치합니다')).toBeNull();
    const signal = vi.mocked(validateRoute).mock.calls.at(-1)![2]!;
    view.rerender(<RoutePanel input={routeInput} revision={1} />);
    expect(signal.aborted).toBe(true);
    expect(screen.queryByText(BRIDGE)).toBeNull();
  });
  it('ignores a late response from the previously selected candidate', async () => {
    let resolve!: (r: RouteResult) => void;
    vi.mocked(validateRoute).mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValueOnce({ ...result(), configurationStatus: 'UNKNOWN', destination: undefined });
    const view = render(<RoutePanel input={routeInput} revision={0} />);
    await waitFor(() => expect(validateRoute).toHaveBeenCalledTimes(1));
    view.rerender(<RoutePanel input={{ ...routeInput, bridgeAddress: OTHER }} revision={0} />);
    await screen.findByText('경로 설정에 미확인 항목이 있습니다');
    await act(async () => { resolve(result()); });
    expect(screen.queryByText('기본 경로 설정이 일치합니다')).toBeNull();
    expect(screen.queryByText(BRIDGE)).toBeNull();
  });
});

it('prioritizes an execution failure over a passing configuration headline', async () => {
  const value = result(); value.status = 'FAIL';
  value.checks.push({ id: 'pause', title: '토큰 일시정지', scope: 'execution', status: 'FAIL', detail: 'paused() = true' });
  vi.mocked(validateRoute).mockResolvedValue(value);
  render(<RoutePanel input={routeInput} revision={0} />);
  expect(await screen.findByText('전송 조건에서 문제를 발견했습니다')).toBeTruthy();
  expect(screen.queryByText('기본 경로 설정이 일치합니다')).toBeNull();
});
