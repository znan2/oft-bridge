import { decodeEventLog, decodeFunctionData, encodeFunctionData, encodePacked, getAddress, isAddress, isHex, keccak256, pad, zeroAddress, type Hex } from 'viem';
import { chainById, type ChainId } from '../../shared/chains';
import { PROTOCOL } from '../../shared/protocol';
import { OFT_RECEIVE_ABI, OFT_SEND_ABI } from '../../shared/oft-abi';
import type { TransactionEvidence } from '../../shared/discovery';

export class TransactionError extends Error {}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const address = (x: unknown): x is Hex => typeof x === 'string' && isAddress(x, { strict: false });
const quantity = (x: unknown): x is Hex => typeof x === 'string' && /^0x[0-9a-f]+$/i.test(x);
const hash = (x: unknown): x is Hex => typeof x === 'string' && /^0x[0-9a-f]{64}$/i.test(x);
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

export function transactionHash(reference: string, chainId: ChainId): string {
  const value = reference.trim();
  if (hash(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error();
    if (url.hostname !== new URL(chainById(chainId).explorer).hostname) throw new TransactionError(`선택한 ${chainById(chainId).shortName} 네트워크의 스캔 링크를 입력하세요. 거래가 발생한 체인을 출발 네트워크로 선택해야 합니다.`);
    const match = url.pathname.match(/^\/tx\/(0x[0-9a-f]{64})\/?$/i);
    if (match) return match[1];
  } catch (error) { if (error instanceof TransactionError) throw error; }
  throw new TransactionError('성공한 OFT 전송·수신 거래의 66자리 해시 또는 해당 네트워크의 스캔 거래 링크를 입력하세요.');
}

export function messageGuid(nonce: bigint, srcEid: number, sender: Hex, dstEid: number, receiver: Hex): Hex {
  return keccak256(encodePacked(['uint64', 'uint32', 'bytes32', 'uint32', 'bytes32'], [nonce, srcEid, sender, dstEid, pad(receiver)]));
}
type ReceiptLog = { address: Hex; data: Hex; topics: [Hex, ...Hex[]] };

// Receipt evidence locates candidates only. Current OFT/token() identity and the requested route
// must still be checked by discovery/route validation before building any transfer plan.
export async function transactionCandidates(txHash: string, chainId: ChainId, tokenAddress: string, rpc: (method: string, params: unknown[]) => Promise<unknown>): Promise<TransactionEvidence[]> {
  const tx = await rpc('eth_getTransactionByHash', [txHash]);
  if (tx === null) throw new TransactionError('선택한 출발 네트워크에서 거래를 찾지 못했습니다. OFT를 보냈거나 받은 거래가 발생한 체인을 선택하세요.');
  if (!record(tx) || !hash(tx.hash) || !same(tx.hash, txHash) || !address(tx.to) || !address(tx.from) || !hash(tx.blockHash) || !quantity(tx.blockNumber)) throw new TransactionError('확정된 거래인지 확인하지 못했습니다.');
  if (tx.chainId !== undefined && (!quantity(tx.chainId) || BigInt(tx.chainId) !== BigInt(chainId))) throw new TransactionError('거래가 선택한 출발 네트워크와 일치하지 않습니다.');
  const receipt = await rpc('eth_getTransactionReceipt', [txHash]);
  if (receipt === null) throw new TransactionError('거래 영수증을 아직 확인할 수 없습니다. 확정 후 다시 조회하거나 주소를 직접 입력하세요.');
  if (!record(receipt) || receipt.status !== '0x1') throw new TransactionError('성공한 거래 영수증이 아닙니다.');
  if (!hash(receipt.transactionHash) || !same(receipt.transactionHash, txHash) || !address(receipt.to) || !same(receipt.to, tx.to) || !address(receipt.from) || !same(receipt.from, tx.from) || receipt.blockNumber !== tx.blockNumber || receipt.blockHash !== tx.blockHash || !Array.isArray(receipt.logs)) throw new TransactionError('거래와 영수증의 주소·블록이 일치하지 않습니다.');
  if (receipt.logs.length > 2048) throw new TransactionError('이벤트가 너무 많은 거래입니다. 브릿지 주소를 직접 입력하세요.');
  const logs = receipt.logs.filter((log): log is ReceiptLog => record(log) && address(log.address) && typeof log.data === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(log.data) && Array.isArray(log.topics) && log.topics.length > 0 && log.topics.every(hash) && log.removed !== true && log.transactionHash === tx.hash && log.blockHash === tx.blockHash && log.blockNumber === tx.blockNumber);
  const candidates: TransactionEvidence[] = [];
  try {
    if (typeof tx.input !== 'string' || !isHex(tx.input)) throw new Error();
    const decoded = decodeFunctionData({ abi: OFT_SEND_ABI, data: tx.input });
    if (decoded.functionName !== 'send' || encodeFunctionData({ abi: OFT_SEND_ABI, functionName: 'send', args: decoded.args }).toLowerCase() !== tx.input.toLowerCase()) throw new Error();
    for (const log of logs) {
      if (!same(log.address, tx.to) || log.topics.length !== 3 || log.data.length !== 194) continue;
      try {
        const event = decodeEventLog({ abi: OFT_SEND_ABI, eventName: 'OFTSent', data: log.data, topics: log.topics });
        if (event.args.dstEid === decoded.args[0].dstEid && same(event.args.fromAddress, tx.from)) candidates.push({ kind: 'send', hash: txHash, bridgeAddress: getAddress(tx.to), blockNumber: tx.blockNumber, dstEid: event.args.dstEid, guid: event.args.guid });
      } catch { /* Unrelated log. */ }
    }
  } catch { /* Receive transactions normally target an Executor, not the OFT. */ }
  const deliveries: { receiver: Hex; srcEid: number; guid: Hex }[] = [];
  const credits: { from: Hex; to: Hex; value: bigint }[] = [];
  for (const log of logs) {
    if (same(log.address, PROTOCOL[chainId].endpoint) && log.topics.length === 1 && log.data.length === 258) {
      try {
        const { origin, receiver } = decodeEventLog({ abi: OFT_RECEIVE_ABI, eventName: 'PacketDelivered', data: log.data, topics: log.topics }).args;
        if (origin.nonce > 0n && origin.srcEid > 0) deliveries.push({ receiver, srcEid: origin.srcEid, guid: messageGuid(origin.nonce, origin.srcEid, origin.sender, chainById(chainId).eid, receiver) });
      } catch { /* A random or malformed delivery log is not evidence. */ }
    }
    if (same(log.address, tokenAddress) && log.topics.length === 3 && log.data.length === 66) {
      try { credits.push(decodeEventLog({ abi: OFT_RECEIVE_ABI, eventName: 'Transfer', data: log.data, topics: log.topics }).args); } catch { /* Unrelated log. */ }
    }
  }
  for (const log of logs) {
    if (log.topics.length !== 3 || log.data.length !== 130) continue;
    try {
      const event = decodeEventLog({ abi: OFT_RECEIVE_ABI, eventName: 'OFTReceived', data: log.data, topics: log.topics }).args;
      const delivered = deliveries.some(d => same(d.receiver, log.address) && d.srcEid === event.srcEid && same(d.guid, event.guid));
      const credited = credits.some(c => same(c.to, event.toAddress) && c.value === event.amountReceivedLD && (same(c.from, zeroAddress) || same(c.from, log.address)));
      if (delivered && credited) candidates.push({ kind: 'receive', hash: txHash, bridgeAddress: getAddress(log.address), blockNumber: tx.blockNumber, srcEid: event.srcEid, guid: event.guid, recipient: event.toAddress, endpoint: PROTOCOL[chainId].endpoint });
    } catch { /* A token Transfer or failed lzReceive attempt is not an OFT receive. */ }
  }
  const unique = [...new Map(candidates.map(c => [`${c.kind}:${c.bridgeAddress.toLowerCase()}:${c.guid.toLowerCase()}`, c])).values()];
  if (new Set(unique.map(c => c.bridgeAddress.toLowerCase())).size > 20) throw new TransactionError('거래에 브릿지 후보가 너무 많습니다. 사용할 브릿지 주소를 직접 입력하세요.');
  if (!unique.length) throw new TransactionError('성공한 직접 OFT send 또는 입력 토큰의 OFT 수신 근거를 확인하지 못했습니다. 수신 거래는 OFTReceived·공식 Endpoint의 PacketDelivered·토큰 Transfer가 일치해야 합니다. 토큰 CA·네트워크를 확인하거나 브릿지 주소를 직접 입력하세요.');
  return unique;
}
