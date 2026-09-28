import { decodeEventLog, decodeFunctionResult, encodeFunctionData, type Hex } from 'viem';
import { chainById, type ChainId } from '../../shared/chains';
import { OFT_QUOTE_ABI, OFT_RECEIVE_ABI, OFT_SEND_ABI } from '../../shared/oft-abi';
import type { ExecutionRecord, ScanResult } from '../../shared/execution';
import { transactionCandidates } from './transaction-candidates';
import { assertFinalityAvailable } from './network-execution';
export interface TrackingIO { rpc(chain: ChainId, method: string, params: unknown[]): Promise<unknown>; scan(hash: string): Promise<ScanResult> }
const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const hash = (x: unknown): x is Hex => typeof x === 'string' && /^0x[0-9a-f]{64}$/i.test(x);
const hex = (x: unknown): x is Hex => typeof x === 'string' && /^0x[0-9a-f]+$/i.test(x);
const obj = (x: unknown): Record<string, any> => x && typeof x === 'object' && !Array.isArray(x) ? x : {};
function receiptLogs(receipt: Record<string, any>) {
  if (!Array.isArray(receipt.logs) || receipt.logs.length > 2048) throw new Error('거래 로그 형식이 잘못되었습니다.');
  return receipt.logs.filter(l => !l.removed && same(l.transactionHash, receipt.transactionHash) && same(l.blockHash, receipt.blockHash) && l.blockNumber === receipt.blockNumber);
}
async function observed(io: TrackingIO, chain: ChainId, txHash: string) {
  const [txRaw, receiptRaw] = await Promise.all([io.rpc(chain, 'eth_getTransactionByHash', [txHash]), io.rpc(chain, 'eth_getTransactionReceipt', [txHash])]);
  if (!txRaw || !receiptRaw) return null;
  const tx = obj(txRaw), receipt = obj(receiptRaw);
  if (!same(tx.hash, txHash) || !same(receipt.transactionHash, txHash) || !same(receipt.to, tx.to) || !same(receipt.from, tx.from) || !hash(receipt.blockHash) || !hex(receipt.blockNumber) || !same(tx.blockHash, receipt.blockHash) || tx.blockNumber !== receipt.blockNumber || !['0x0', '0x1'].includes(receipt.status) || (tx.chainId !== undefined && (!hex(tx.chainId) || BigInt(tx.chainId) !== BigInt(chain)))) throw new Error('거래·영수증·체인 응답이 일치하지 않습니다.');
  const block = obj(await io.rpc(chain, 'eth_getBlockByNumber', [receipt.blockNumber, false]));
  if (block.number !== receipt.blockNumber || !same(block.hash, receipt.blockHash)) return null; // Reorg or inconsistent RPC: never retain a prior completion verdict.
  const finalized = await assertFinalityAvailable(chain, io);
  return { tx, receipt, finalized: BigInt(finalized.number) >= BigInt(receipt.blockNumber) };
}
function matchesRequest(row: ExecutionRecord, tx: Record<string, any>) {
  const t = row.review.transaction;
  return same(tx.from, t.from) && same(tx.to, t.to) && same(tx.input, t.data) && hex(tx.value) && BigInt(tx.value) === BigInt(t.value) && hex(tx.nonce) && BigInt(tx.nonce) === BigInt(row.nonce);
}
export async function attachSourceHash(row: ExecutionRecord, reference: string, io: TrackingIO): Promise<ExecutionRecord> {
  if (!hash(reference)) throw new Error('66자리 출발 또는 교체 거래 해시를 입력하세요.');
  const chain = row.review.plan.input.route.sourceChain;
  const tx = obj(await io.rpc(chain, 'eth_getTransactionByHash', [reference]));
  if (!same(tx.hash, reference) || !same(tx.from, row.review.transaction.from) || !hex(tx.nonce) || BigInt(tx.nonce) !== BigInt(row.nonce) || (tx.chainId !== undefined && (!hex(tx.chainId) || BigInt(tx.chainId) !== BigInt(chain)))) throw new Error('같은 출발 체인·계정·nonce의 거래가 아닙니다.');
  return { ...row, originalHash: row.originalHash ?? row.hash, hash: reference, guid: undefined, destinationHash: undefined, destinationHashSource: undefined, destinationAmountLD: undefined, actualSentLD: undefined, actualReceivedLD: undefined, scanStatus: undefined, sourceFinalized: false, status: 'pending', detail: '입력한 거래의 내용·영수증을 다시 확인합니다.', trackingError: undefined, updatedAt: new Date().toISOString() };
}
export async function trackExecution(previous: ExecutionRecord, io: TrackingIO): Promise<ExecutionRecord> {
  const row = structuredClone(previous); row.updatedAt = new Date().toISOString(); row.trackingError = undefined;
  if (!row.hash) return row;
  row.destinationAmountLD = undefined;
  row.sourceFinalized = false;
  const p = row.review.plan, source = p.input.route.sourceChain, destination = p.input.route.destinationChain;
  try {
    const src = await observed(io, source, row.hash);
    if (!src) { row.status = 'pending'; row.sourceFinalized = false; row.guid = undefined; row.detail = '출발 거래 미확정 또는 RPC 전파·블록 재확인 중입니다. 자동 재전송하지 않습니다.'; return row; }
    const { tx, receipt } = src;
    if (!same(tx.from, row.review.transaction.from) || !hex(tx.nonce) || BigInt(tx.nonce) !== BigInt(row.nonce)) throw new Error('Rabby가 반환한 거래가 요청 계정·nonce와 다릅니다.');
    row.sourceFinalized = src.finalized;
    if (!matchesRequest(row, tx)) {
      row.status = src.finalized ? 'replaced' : 'pending'; row.detail = src.finalized ? '요청과 다른 내용의 거래가 같은 nonce로 확정됐습니다. 취소·변경 거래를 탐색기에서 확인하세요.' : '취소·변경 거래의 확정을 기다립니다.'; return row;
    }
    if (receipt.status === '0x0') { row.status = src.finalized ? 'source-failed' : 'pending'; row.detail = src.finalized ? '출발 거래 실행 실패가 확정됐습니다. 브릿지 전송은 발생하지 않았으며 출발 가스비는 소모될 수 있습니다.' : '출발 실행 실패 관찰 · 블록 확정 대기'; return row; }
    if (row.review.kind !== 'send') {
      if (!src.finalized) { row.status = 'pending'; row.detail = '승인 거래 실행 성공 · 블록 확정 대기'; return row; }
      const raw = await io.rpc(source, 'eth_call', [{ to: p.approval.token, data: encodeFunctionData({ abi: OFT_QUOTE_ABI, functionName: 'allowance', args: [p.input.sender as Hex, p.approval.spender as Hex] }) }, receipt.blockNumber]);
      const allowance = decodeFunctionResult({ abi: OFT_QUOTE_ABI, functionName: 'allowance', data: raw as Hex });
      const correct = row.review.kind === 'approve-reset' ? allowance === 0n : allowance >= BigInt(p.approval.amountLD);
      if (!correct) throw new Error('승인 거래는 성공했지만 확정 블록의 allowance가 요청을 충족하지 않습니다.');
      row.status = 'approval-confirmed'; row.detail = row.review.kind === 'approve-reset' ? '기존 allowance 0으로 초기화 완료 · 다시 검증해 필요 수량을 승인하세요.' : '필요 수량 승인 확인 · 다시 검증하면 send를 시뮬레이션합니다. 자동으로 전송하지 않습니다.'; return row;
    }
    const events = [];
    for (const log of receiptLogs(receipt)) {
      if (!same(log.address, p.input.route.bridgeAddress)) continue;
      try {
        const event = decodeEventLog({ abi: OFT_SEND_ABI, eventName: 'OFTSent', topics: log.topics, data: log.data }).args;
        if (same(event.fromAddress, p.input.sender) && event.dstEid === chainById(destination).eid) events.push(event);
      } catch { /* Other event. */ }
    }
    if (events.length !== 1) throw new Error('출발 성공 영수증에서 요청에 해당하는 OFTSent를 하나로 확인하지 못했습니다.');
    const sent = events[0], sourceRate = 10n ** BigInt(p.amounts.sourceDecimals - p.amounts.sharedDecimals);
    if (sent.amountSentLD <= 0n || sent.amountSentLD > BigInt(p.sendParam.amountLD) || sent.amountReceivedLD < BigInt(p.sendParam.minAmountLD) || sent.amountReceivedLD % sourceRate !== 0n) throw new Error('OFTSent 수량이 검토한 요청 범위와 다릅니다.');
    row.guid = sent.guid; row.actualSentLD = sent.amountSentLD.toString(); row.actualReceivedLD = sent.amountReceivedLD.toString();
    row.status = 'source-confirmed'; row.detail = src.finalized ? '출발 거래 확정 · 목적지 전달 확인 중' : '출발 실행 성공 관찰 · 출발 블록 확정 대기';
    const expectedDestination = sent.amountReceivedLD / sourceRate * 10n ** BigInt(p.amounts.destinationDecimals - p.amounts.sharedDecimals);
    try {
      const scan = await io.scan(row.hash);
      const matches = scan.messages.filter(m => same(m.guid, row.guid) && same(m.sourceHash, row.hash) && m.srcEid === chainById(source).eid && m.dstEid === chainById(destination).eid && same(m.sender, p.input.route.bridgeAddress) && same(m.receiver, p.route.destination!.identity!.bridgeAddress));
      if (matches.length > 1) throw new Error('같은 메시지의 Scan 결과가 여러 개여서 도착 거래를 확정하지 못했습니다.');
      const message = matches[0];
      if (message) { row.scanStatus = message.status; if (message.destinationHash && row.destinationHashSource !== 'manual') { row.destinationHash = message.destinationHash; row.destinationHashSource = 'scan'; } }
      if (message && /FAILED|BLOCKED|PAYLOAD_STORED/.test(message.status)) { row.status = 'destination-failed'; row.detail = 'Scan에서 목적지 처리 문제를 보고했습니다. 출발 전송을 반복하지 말고 메시지를 확인하세요.'; }
      else { row.status = 'destination-pending'; row.detail = message ? 'LayerZero 검증·전달 진행 중 · 목적지 수령 증거 확인 대기' : 'Scan 인덱싱 대기 · 출발 거래 실패가 아닙니다.'; }
    } catch (error) { row.trackingError = error instanceof Error ? error.message : 'LayerZero Scan 조회 오류'; }
    if (!row.destinationHash) return row;
    const dst = await observed(io, destination, row.destinationHash);
    if (!dst || dst.receipt.status !== '0x1') { row.status = 'destination-pending'; row.detail = '목적지 거래의 성공 영수증을 아직 확인하지 못했습니다.'; return row; }
    const evidence = await transactionCandidates(row.destinationHash, destination, p.route.destination!.identity!.token.address, (m, a) => io.rpc(destination, m, a));
    const received = evidence.find(e => e.kind === 'receive' && same(e.guid, row.guid) && same(e.bridgeAddress, p.route.destination!.identity!.bridgeAddress) && e.srcEid === chainById(source).eid && same(e.recipient, p.input.recipient));
    if (!received) throw new Error('목적지 수신 이벤트·GUID·토큰·받는 주소가 이 전송과 일치하지 않습니다.');
    const amounts: bigint[] = [];
    for (const log of receiptLogs(dst.receipt)) {
      if (!same(log.address, received.bridgeAddress)) continue;
      try { const event = decodeEventLog({ abi: OFT_RECEIVE_ABI, eventName: 'OFTReceived', topics: log.topics, data: log.data }).args; if (same(event.guid, row.guid) && same(event.toAddress, p.input.recipient)) amounts.push(event.amountReceivedLD); } catch { /* Other event. */ }
    }
    if (amounts.length !== 1 || amounts[0] !== expectedDestination) throw new Error('목적지 실제 수령량이 출발 OFTSent의 공유 수량과 다릅니다.');
    row.destinationAmountLD = expectedDestination.toString();
    row.status = src.finalized && dst.finalized ? 'delivered' : 'destination-confirming';
    row.detail = row.status === 'delivered' ? '양쪽 거래 확정 · OFT 수신·Endpoint 전달·토큰 이동과 실제 수령량 확인 완료' : '목적지 수령 이벤트 확인 · 양쪽 블록 최종 확정 대기';
    return row;
  } catch (error) {
    // Observation errors never become a transaction failure or an unverified success.
    row.trackingError = `추적 조회 오류 — ${error instanceof Error ? error.message : '응답 미확인'}`;
    if (row.status === 'delivered' || row.status === 'approval-confirmed') { row.status = row.guid ? 'source-confirmed' : 'pending'; row.detail = '이전 확인 이후 최신 증거 조회를 완료하지 못했습니다.'; }
    return row;
  }
}
