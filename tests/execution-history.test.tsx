// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ExecutionHistory } from '../src/components/ExecutionHistory';
import { executionStore } from '../src/lib/execution-store';
import { attachSourceHash, trackExecution } from '../src/lib/tracking';
import type { ExecutionRecord } from '../shared/execution';
import fixture from './fixtures/m5-dos-tracking.json';
vi.mock('../src/lib/execution-store',()=>({executionStore:{list:vi.fn(),put:vi.fn()}}));
vi.mock('../src/lib/route-io',()=>({browserRouteIO:vi.fn(()=>({rpc:vi.fn()}))}));
vi.mock('../src/lib/tracking',()=>({trackExecution:vi.fn(),attachSourceHash:vi.fn()}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
it('resumes saved pending history without a wallet and preserves completion on remount',async()=>{
  let saved=[structuredClone(fixture.record) as ExecutionRecord];
  vi.mocked(executionStore.list).mockImplementation(async()=>saved);
  vi.mocked(executionStore.put).mockImplementation(async r=>{saved=[r];});
  vi.mocked(trackExecution).mockResolvedValue(fixture.result as ExecutionRecord);
  const first=render(<ExecutionHistory revision={0}/>);
  await waitFor(()=>expect(screen.getByText('목적지 수령 완료')).toBeTruthy());expect(trackExecution).toHaveBeenCalledTimes(1);
  first.unmount();render(<ExecutionHistory revision={0}/>);
  await waitFor(()=>expect(screen.getByText('목적지 수령 완료')).toBeTruthy());expect(trackExecution).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/확인한 수령량: 437/)).toBeTruthy();
});
it('reports unreadable storage without claiming there are no pending requests', async () => {
  vi.mocked(executionStore.list).mockRejectedValue(new Error('기록 읽기 실패'));
  render(<ExecutionHistory revision={0}/>);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('기록 읽기 실패'));
  expect(screen.queryByText('아직 승인·전송 요청이 없습니다.')).toBeNull();
});
it('saves a manually supplied destination hash conditionally before tracking', async () => {
  const row = { ...structuredClone(fixture.record), hash: undefined, guid: fixture.result.guid } as ExecutionRecord;
  vi.mocked(executionStore.list).mockResolvedValue([row]);
  vi.mocked(executionStore.put).mockResolvedValue(true);
  render(<ExecutionHistory revision={0}/>);
  const input = await screen.findByLabelText('목적지 수신 거래 해시');
  fireEvent.change(input, { target: { value: fixture.result.destinationHash } });
  fireEvent.click(screen.getByText('목적지 해시 연결·검증'));
  await waitFor(() => expect(executionStore.put).toHaveBeenCalledWith(expect.objectContaining({ destinationHash: fixture.result.destinationHash, destinationHashSource: 'manual', destinationAmountLD: undefined }), row));
  expect(trackExecution).not.toHaveBeenCalled();
});
it('cancels an old recovery on RPC revision change and allows another attempt', async () => {
  const row = { ...structuredClone(fixture.record), hash: undefined, status: 'unknown' } as ExecutionRecord;
  vi.mocked(executionStore.list).mockResolvedValue([row]);
  vi.mocked(executionStore.put).mockResolvedValue(true);
  let finish!: (row: ExecutionRecord) => void;
  vi.mocked(attachSourceHash).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ ...row, hash: fixture.record.hash });
  const ui = render(<ExecutionHistory revision={0}/>);
  fireEvent.change(await screen.findByLabelText('출발·교체 거래 해시'), { target: { value: fixture.record.hash } });
  const button = screen.getByText('해시 연결·검증') as HTMLButtonElement;
  fireEvent.click(button); expect(button.disabled).toBe(true);
  ui.rerender(<ExecutionHistory revision={1}/>);
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(executionStore.put).toHaveBeenCalledTimes(1));
  await act(async () => { finish({ ...row, hash: fixture.record.hash }); });
  expect(executionStore.put).toHaveBeenCalledTimes(1);
  expect(button.disabled).toBe(false);
});
