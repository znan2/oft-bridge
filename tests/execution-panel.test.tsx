// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useConnection } from 'wagmi';
import { ExecutionPanel } from '../src/components/ExecutionPanel';
import { prepareExecution, submitExecution } from '../src/lib/execution';
import { executionStore } from '../src/lib/execution-store';
import type { ExecutionReview, ExecutionRecord } from '../shared/execution';
import fixture from './fixtures/m5-dos-tracking.json';
vi.mock('wagmi',()=>({useConnection:vi.fn()}));
vi.mock('../src/lib/execution',()=>({prepareExecution:vi.fn(),submitExecution:vi.fn()}));
vi.mock('../src/lib/route-io',()=>({browserRouteIO:vi.fn(()=>({}))}));
vi.mock('../src/lib/execution-store',()=>({executionStore:{list:vi.fn()}}));
const runtime = vi.hoisted(() => ({ value: { ready: true, network: 'mainnet', executionMode: 'live', mismatch: false } }));
const fresh = vi.hoisted(() => ({ value: { ready: true, network: 'mainnet', executionMode: 'live', mismatch: false } }));
vi.mock('../src/lib/runtime',()=>({useRuntime:()=>runtime.value,currentRuntime:async()=>fresh.value}));
let review: ExecutionReview;
beforeEach(()=>{
  review=structuredClone(fixture.record.review) as ExecutionReview; review.expiresAt=new Date(Date.now()+60_000).toISOString();
  vi.mocked(useConnection).mockReturnValue({isConnected:true,address:review.plan.input.sender,chainId:56,connector:{id:'io.rabby',uid:review.plan.input.providerUid,getProvider:async()=>({request:vi.fn()})}} as never);
  vi.mocked(prepareExecution).mockResolvedValue(review);
  vi.mocked(submitExecution).mockResolvedValue({...fixture.record,status:'pending',review} as ExecutionRecord);
  vi.mocked(executionStore.list).mockResolvedValue([]);
});
afterEach(()=>{cleanup();vi.clearAllMocks();vi.useRealTimers();runtime.value={...runtime.value,executionMode:'live'};fresh.value={...fresh.value,executionMode:'live'};});
async function prepare(){await act(async()=>{});await act(async()=>fireEvent.click(screen.getByRole('button',{name:'전송 직전 재검증'})));}
describe('dry-run UI',()=>{
  it('shows the reviewed route and fee but offers no signing action unless the server runs --live',async()=>{
    runtime.value={...runtime.value,executionMode:'dry-run'};
    render(<ExecutionPanel plan={review.plan}/>); await prepare();
    expect(prepareExecution).toHaveBeenCalledTimes(1); expect(screen.getByText('브릿지 수수료')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull(); expect(screen.queryByRole('button',{name:'Rabby에서 브릿지 전송'})).toBeNull();
    expect((screen.getByRole('button',{name:'Dry-run · 서명 요청 비활성'}) as HTMLButtonElement).disabled).toBe(true);
    expect(submitExecution).not.toHaveBeenCalled();
  });
  it('re-reads the server mode at click time and refuses when it was restarted without --live',async()=>{
    render(<ExecutionPanel plan={review.plan}/>); await prepare(); fireEvent.click(screen.getByRole('checkbox'));
    fresh.value={...fresh.value,executionMode:'dry-run'};
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Rabby에서 브릿지 전송'})));
    expect(submitExecution).not.toHaveBeenCalled(); expect(screen.getByText(/서버가 dry-run 모드로 바뀌었습니다/)).toBeTruthy();
  });
});
describe('M5 review and explicit Rabby action',()=>{
  it('blocks a new review until the existing approval is finalized', async () => {
    const approval = { ...structuredClone(fixture.record), review: { ...review, kind: 'approve' }, status: 'pending', sourceFinalized: false, detail: '승인 거래 실행 성공 · 블록 확정 대기' } as ExecutionRecord;
    vi.mocked(executionStore.list).mockResolvedValue([approval]);
    render(<ExecutionPanel plan={review.plan}/>); await prepare();
    expect((screen.getByRole('button',{name:'전송 직전 재검증'}) as HTMLButtonElement).disabled).toBe(true);
    expect(prepareExecution).not.toHaveBeenCalled();
    expect(screen.getByText(/승인 거래 실행 성공 · 블록 확정 대기/)).toBeTruthy();
    vi.mocked(executionStore.list).mockResolvedValue([{...approval,status:'approval-confirmed',sourceFinalized:true}]);
    await act(async()=>{window.dispatchEvent(new Event('oft-executions'));});
    expect((screen.getByRole('button',{name:'전송 직전 재검증'}) as HTMLButtonElement).disabled).toBe(false);
    expect(prepareExecution).not.toHaveBeenCalled(); expect(submitExecution).not.toHaveBeenCalled();
    await prepare(); expect(prepareExecution).toHaveBeenCalledTimes(1);
  });
  it('disables a prepared send when another same-account request appears', async () => {
    render(<ExecutionPanel plan={review.plan}/>); await prepare(); fireEvent.click(screen.getByRole('checkbox'));
    vi.mocked(executionStore.list).mockResolvedValue([{...fixture.record,review,status:'pending',sourceFinalized:false} as ExecutionRecord]);
    await act(async()=>{window.dispatchEvent(new Event('oft-executions'));});
    const send=screen.queryByRole('button',{name:'Rabby에서 브릿지 전송'}) as HTMLButtonElement|null;
    expect(!send||send.disabled).toBe(true); expect(submitExecution).not.toHaveBeenCalled();
  });
  it('blocks on a history read error without preparing a wallet action', async () => {
    vi.mocked(executionStore.list).mockRejectedValue(new Error('IndexedDB unavailable'));
    render(<ExecutionPanel plan={review.plan}/>); await prepare();
    expect(screen.getByRole('alert').textContent).toContain('전송 이력 조회 오류');
    expect(prepareExecution).not.toHaveBeenCalled(); expect(submitExecution).not.toHaveBeenCalled();
  });
  it('does not block for another account or source chain', async () => {
    const pending = { ...fixture.record, review, status: 'pending', sourceFinalized: false } as ExecutionRecord;
    vi.mocked(executionStore.list).mockResolvedValue([
      { ...pending, review: { ...review, transaction: { ...review.transaction, chainId: 1 } } },
      { ...pending, review: { ...review, transaction: { ...review.transaction, from: '0x0000000000000000000000000000000000000001' } } },
    ]);
    render(<ExecutionPanel plan={review.plan}/>); await prepare();
    expect(prepareExecution).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button',{name:'Rabby에서 브릿지 전송'})).toBeTruthy();
  });
  it('discards a review when a request appears during revalidation', async () => {
    let resolve!: (value: ExecutionReview) => void;
    vi.mocked(prepareExecution).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const onPlanReviewed = vi.fn();
    render(<ExecutionPanel plan={review.plan} onPlanReviewed={onPlanReviewed}/>); await prepare();
    vi.mocked(executionStore.list).mockResolvedValue([{ ...fixture.record, review, status:'pending', sourceFinalized:false } as ExecutionRecord]);
    await act(async () => { resolve(review); });
    expect(screen.queryByRole('button',{name:'Rabby에서 브릿지 전송'})).toBeNull();
    expect(onPlanReviewed).not.toHaveBeenCalled(); expect(submitExecution).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('미확정');
  });
  it('checks history again before requesting the provider even without a UI event', async () => {
    const getProvider = vi.fn();
    vi.mocked(useConnection).mockReturnValue({isConnected:true,address:review.plan.input.sender,chainId:56,connector:{id:'io.rabby',uid:review.plan.input.providerUid,getProvider}} as never);
    render(<ExecutionPanel plan={review.plan}/>); await prepare(); fireEvent.click(screen.getByRole('checkbox'));
    vi.mocked(executionStore.list).mockResolvedValue([{ ...fixture.record, review, status:'pending', sourceFinalized:false } as ExecutionRecord]);
    await act(async () => { fireEvent.click(screen.getByRole('button',{name:'Rabby에서 브릿지 전송'})); });
    expect(getProvider).not.toHaveBeenCalled(); expect(submitExecution).not.toHaveBeenCalled();
    expect(screen.queryByRole('button',{name:'Rabby에서 브릿지 전송'})).toBeNull();
  });
  it('shows refreshed request and requires a separate confirmation before signing',async()=>{
    render(<ExecutionPanel plan={review.plan}/>);expect(prepareExecution).not.toHaveBeenCalled();await prepare();
    const send=screen.getByRole('button',{name:'Rabby에서 브릿지 전송'}) as HTMLButtonElement;expect(send.disabled).toBe(true);expect(submitExecution).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox'));expect(send.disabled).toBe(false);
    await act(async()=>{fireEvent.click(send);fireEvent.click(send);});expect(submitExecution).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link',{name:'전송 이력·도착 추적 보기 ↓'})).toBeTruthy();expect(send.disabled).toBe(true);
  });
  it('expires the reviewed wallet action',async()=>{vi.useFakeTimers();render(<ExecutionPanel plan={review.plan}/>);await prepare();fireEvent.click(screen.getByRole('checkbox'));await act(async()=>vi.advanceTimersByTime(60_000));expect((screen.getByRole('button',{name:'Rabby에서 브릿지 전송'}) as HTMLButtonElement).disabled).toBe(true);expect(submitExecution).not.toHaveBeenCalled();});
  it('shows approval as a distinct step without automatically sending afterward',async()=>{review.kind='approve';render(<ExecutionPanel plan={review.plan}/>);await prepare();expect(screen.getByRole('button',{name:'Rabby에서 필요 수량 승인'})).toBeTruthy();expect(screen.queryByRole('button',{name:'Rabby에서 브릿지 전송'})).toBeNull();expect(submitExecution).not.toHaveBeenCalled();});
  it('reports revalidation failure without retaining an older ready action',async()=>{render(<ExecutionPanel plan={review.plan}/>);await prepare();vi.mocked(prepareExecution).mockRejectedValue(new Error('RPC unavailable'));await prepare();expect(screen.getByRole('alert').textContent).toContain('RPC');expect(screen.queryByRole('button',{name:'Rabby에서 브릿지 전송'})).toBeNull();});
});
