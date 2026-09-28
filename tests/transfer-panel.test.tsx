// @vitest-environment jsdom
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useConnection } from 'wagmi';
import { TransferPanel } from '../src/components/TransferPanel';
import { prepareTransfer, QUOTE_TTL_MS } from '../src/lib/transfer';
import { prepareExecution, submitExecution } from '../src/lib/execution';
import { executionStore } from '../src/lib/execution-store';
import type { ExecutionRecord, ExecutionReview } from '../shared/execution';
import type { TransferPlan } from '../shared/transfer';
import { transferHarness, transferInput, SENDER, RECIPIENT } from './helpers/transfer';
import { routeInput } from './helpers/route';
vi.mock('wagmi', () => ({ useConnection: vi.fn() }));
vi.mock('../src/lib/route-io', () => ({ browserRouteIO: vi.fn(() => ({})) }));
vi.mock('../src/lib/transfer', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/transfer')>(), prepareTransfer: vi.fn() }));
vi.mock('../src/lib/execution', () => ({ prepareExecution: vi.fn(), submitExecution: vi.fn() }));
vi.mock('../src/lib/execution-store', () => ({ executionStore: { list: vi.fn() } }));
vi.mock('../src/lib/runtime', () => {
  const live = { ready: true, network: 'mainnet', executionMode: 'live', mismatch: false };
  return { useRuntime: () => live, currentRuntime: async () => live };
});
let fixture: TransferPlan;
beforeAll(async () => {
  const actual = await vi.importActual<typeof import('../src/lib/transfer')>('../src/lib/transfer');
  fixture = await actual.prepareTransfer(transferInput, transferHarness().io);
});
function wallet(address = SENDER, chainId = 56, uid = 'rabby-1') {
  vi.mocked(useConnection).mockReturnValue({ isConnected: true, address, chainId, connector: { id: 'io.rabby', uid } } as never);
}
beforeEach(() => {
  wallet();
  vi.mocked(executionStore.list).mockResolvedValue([]);
  vi.mocked(prepareTransfer).mockImplementation(async input => ({ ...structuredClone(fixture), input, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + QUOTE_TTL_MS).toISOString() }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });
async function generate() {
  fireEvent.change(screen.getByLabelText('보낼 수량'), { target: { value: '1.123456789' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '견적 생성 · 시뮬레이션' })); });
}
describe('transfer form context and readiness', () => {
  it('defaults recipient/refund to Rabby and only requests a read-only plan on explicit submit', async () => {
    render(<TransferPanel routeResult={fixture.route} input={routeInput} revision={4} />);
    expect((screen.getByLabelText('받는 주소 · 0x 주소') as HTMLInputElement).value).toBe(SENDER);
    expect((screen.getByLabelText('환불 주소 · 출발 네트워크') as HTMLInputElement).value).toBe(SENDER);
    expect(prepareTransfer).not.toHaveBeenCalled();
    await generate();
    expect(screen.getByText('출발 시뮬레이션 통과 · 전송 전 단계')).toBeTruthy();
    expect(vi.mocked(prepareTransfer).mock.calls[0][0]).toMatchObject({ sender: SENDER, recipient: SENDER, refundAddress: SENDER, walletChainId: 56, providerUid: 'rabby-1', rpcRevision: 4 });
    expect(screen.queryByRole('button', { name: /^전송$|^승인$|^approve$|^send$/ })).toBeNull();
  });
  it.each(['disconnect', 'chain'])('shows a disabled amount field and a wallet reason after %s', change => {
    if (change === 'disconnect') vi.mocked(useConnection).mockReturnValue({ isConnected: false } as never);
    else wallet(SENDER, 1);
    render(<TransferPanel routeResult={fixture.route} input={routeInput} revision={0} />);
    expect((screen.getByLabelText('보낼 수량') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain(change === 'disconnect' ? 'Rabby를 연결하세요' : 'BSC로 전환하세요');
    expect((screen.getByRole('button', { name: '견적 생성 · 시뮬레이션' }) as HTMLButtonElement).disabled).toBe(true);
    expect(prepareTransfer).not.toHaveBeenCalled();
  });
  it('discards a prior quote when a new route check fails while keeping the amount field visible', async () => {
    const view = render(<TransferPanel routeResult={fixture.route} input={routeInput} revision={0} />); await generate();
    const failed = { ...fixture.route, configurationStatus: 'FAIL' as const, checks: [{ id: 'source-peer', title: '목적지 peer', status: 'FAIL' as const, scope: 'configuration' as const, detail: 'Ethereum 목적지 미설정' }] };
    view.rerender(<TransferPanel routeResult={failed} input={routeInput} revision={0} />);
    expect(screen.queryByText('출발 시뮬레이션 통과 · 전송 전 단계')).toBeNull();
    expect(screen.queryByText(fixture.transaction.data)).toBeNull();
    expect((screen.getByLabelText('보낼 수량') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('Ethereum 목적지 미설정');
    fireEvent.click(screen.getByRole('button', { name: '견적 생성 · 시뮬레이션' }));
    expect(prepareTransfer).toHaveBeenCalledTimes(1);
  });
  it('invalidates the result immediately on amount/recipient/options changes', async () => {
    render(<TransferPanel routeResult={fixture.route} input={routeInput} revision={0} />); await generate();
    fireEvent.change(screen.getByLabelText('추가 수신 gas'), { target: { value: '50000' } });
    expect(screen.queryByText('출발 시뮬레이션 통과 · 전송 전 단계')).toBeNull();
    await generate();
    fireEvent.change(screen.getByLabelText('받는 주소 · 0x 주소'), { target: { value: RECIPIENT } });
    expect(screen.queryByText('출발 시뮬레이션 통과 · 전송 전 단계')).toBeNull();
  });
  it.each(['account', 'chain', 'provider', 'rpc', 'route', 'disconnect'])('clears old values for a changed %s context', async change => {
    const view = render(<TransferPanel routeResult={fixture.route} input={routeInput} revision={0} />); await generate();
    if (change === 'account') wallet(RECIPIENT);
    if (change === 'chain') wallet(SENDER, 1);
    if (change === 'provider') wallet(SENDER, 56, 'rabby-2');
    if (change === 'disconnect') vi.mocked(useConnection).mockReturnValue({ isConnected: false } as never);
    view.rerender(<TransferPanel routeResult={fixture.route} input={change === 'route' ? { ...routeInput, bridgeAddress: RECIPIENT } : routeInput} revision={change === 'rpc' ? 1 : 0} />);
    expect(screen.queryByText('출발 시뮬레이션 통과 · 전송 전 단계')).toBeNull();
    expect(screen.queryByText(fixture.transaction.data)).toBeNull();
    if (change === 'account') expect((screen.getByLabelText('받는 주소 · 0x 주소') as HTMLInputElement).value).toBe(RECIPIENT);
  });
  it('aborts pending work and ignores a late response after input changes', async () => {
    let resolve!: (plan: TransferPlan) => void;
    vi.mocked(prepareTransfer).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    render(<TransferPanel routeResult={fixture.route} input={routeInput} revision={0} />); await generate();
    const signal = vi.mocked(prepareTransfer).mock.calls[0][2]!;
    fireEvent.change(screen.getByLabelText('보낼 수량'), { target: { value: '2' } });
    expect(signal.aborted).toBe(true);
    await act(async () => { resolve(fixture); });
    expect(screen.queryByText('출발 시뮬레이션 통과 · 전송 전 단계')).toBeNull();
  });
  it('expires a displayed quote and disables parameter copies', async () => {
    vi.useFakeTimers(); render(<TransferPanel routeResult={fixture.route} input={routeInput} revision={0} />); await generate();
    expect(screen.getByText('출발 시뮬레이션 통과 · 전송 전 단계')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(QUOTE_TTL_MS); });
    expect(screen.getByText('견적 만료 · 다시 생성하세요')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'calldata 복사', hidden: true }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('shows approval pending without claiming the simulation passed', async () => {
    vi.mocked(prepareTransfer).mockResolvedValue({ ...fixture, simulation: { status: 'blocked', detail: '승인 대기' }, blockers: [{ code: 'APPROVAL_REQUIRED', message: '필요 승인량을 확인하세요.' }] });
    render(<TransferPanel routeResult={fixture.route} input={routeInput} revision={0} />); await generate();
    expect(screen.getByText('견적 생성됨 · 전송 조건 확인 필요')).toBeTruthy(); expect(screen.getByText('승인 대기')).toBeTruthy();
  });
  it('replaces a stale approval warning and updates the quote from the next reviewed send', async () => {
    const oldPlan = { ...structuredClone(fixture), createdAt: new Date(Date.now()-20_000).toISOString(), expiresAt: new Date(Date.now()+40_000).toISOString(), approval: { ...fixture.approval, required:true, needed:true, allowanceLD:'0' }, simulation: { status:'blocked', detail:'승인 전 시뮬레이션 대기' }, blockers:[{code:'APPROVAL_REQUIRED',message:'이전 견적은 승인 필요'}] } as TransferPlan;
    const approvalReview = { kind:'approve', plan:oldPlan, expiresAt:oldPlan.expiresAt, transaction: {chainId:oldPlan.input.route.sourceChain,from:oldPlan.input.sender,to:oldPlan.input.route.tokenAddress,data:'0x',value:'0',gas:'100000',gasPrice:'1'} } as ExecutionReview;
    const approval = {version:1,id:'approval',createdAt:new Date(Date.now()-10_000).toISOString(),updatedAt:new Date().toISOString(),review:approvalReview,nonce:'1',status:'pending',sourceFinalized:false,detail:'승인 거래 실행 성공 · 블록 확정 대기'} as ExecutionRecord;
    vi.mocked(prepareTransfer).mockResolvedValue(oldPlan);
    vi.mocked(executionStore.list).mockResolvedValue([approval]);
    render(<TransferPanel routeResult={fixture.route} input={routeInput} revision={0} />); await generate();
    expect(screen.getByText('승인 요청 처리 중 · 전송 이력을 확인하세요')).toBeTruthy();
    expect(screen.queryByText('이전 견적은 승인 필요')).toBeNull();
    expect((screen.getByRole('button',{name:'calldata 복사',hidden:true}) as HTMLButtonElement).disabled).toBe(true);
    vi.mocked(executionStore.list).mockResolvedValue([{...approval,status:'approval-confirmed',sourceFinalized:true}]);
    await act(async () => { window.dispatchEvent(new Event('oft-executions')); });
    expect(screen.getByText('승인 요청 이후 재검증이 필요합니다')).toBeTruthy();
    expect(prepareExecution).not.toHaveBeenCalled(); expect(submitExecution).not.toHaveBeenCalled();
    const freshPlan = {...oldPlan,fingerprint:'fresh-reviewed-send',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString(),blockers:[],approval:{...oldPlan.approval,needed:false,allowanceLD:oldPlan.approval.amountLD},simulation:{status:'passed',detail:'최신 send 시뮬레이션 통과'}} as TransferPlan;
    vi.mocked(prepareExecution).mockResolvedValue({...approvalReview,kind:'send',plan:freshPlan,expiresAt:freshPlan.expiresAt});
    await act(async () => { fireEvent.click(screen.getByRole('button',{name:'전송 직전 재검증'})); });
    expect(screen.getByText('최신 send 시뮬레이션 통과')).toBeTruthy();
    expect(screen.getByText('승인 수량 충분')).toBeTruthy();
    expect(screen.queryByText('승인 요청 이후 재검증이 필요합니다')).toBeNull();
    expect((screen.getByRole('button',{name:'calldata 복사',hidden:true}) as HTMLButtonElement).disabled).toBe(false);
    // Updating the quote must retain the reviewed request and require fresh consent.
    expect((screen.getByRole('button',{name:'Rabby에서 브릿지 전송'}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect((screen.getByRole('button',{name:'Rabby에서 브릿지 전송'}) as HTMLButtonElement).disabled).toBe(false);
    expect(submitExecution).not.toHaveBeenCalled();
  });
  it('identifies an RPC error and does not retain the previous quote', async () => {
    render(<TransferPanel routeResult={fixture.route} input={routeInput} revision={0} />); await generate();
    vi.mocked(prepareTransfer).mockRejectedValue(new Error('public node timeout'));
    await generate();
    expect(screen.getByRole('alert').textContent).toContain('RPC 오류');
    expect(screen.queryByText('출발 시뮬레이션 통과 · 전송 전 단계')).toBeNull();
  });
});
