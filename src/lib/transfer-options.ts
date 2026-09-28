import { toHex, type Hex } from 'viem';
import { decimalAmount, fail } from './transfer-math';
const MAX_GAS = (1n << 128n) - 1n;
export function receiveOption(value: string): Hex {
  const gas = decimalAmount(value, 0, '추가 수신 gas');
  if (gas > MAX_GAS) fail('추가 수신 gas가 uint128 범위를 초과합니다.');
  return gas === 0n ? '0x' : `0x000301001101${toHex(gas, { size: 16 }).slice(2)}`;
}
export function inspectOptions(options: string) {
  if (!/^0x(?:[0-9a-f]{2})*$/i.test(options) || options.length > 16386) fail('실행 옵션의 hex 형식 또는 길이가 잘못되었습니다.', 'UNSUPPORTED_OPTIONS');
  let gas = 0n, ordered = false;
  if (options === '0x') return { gas, ordered };
  if (!options.startsWith('0x0003')) fail('Type 3 실행 옵션만 지원합니다.', 'UNSUPPORTED_OPTIONS');
  for (let cursor = 6; cursor < options.length;) {
    if (cursor + 8 > options.length) fail('실행 옵션 헤더가 잘렸습니다.', 'UNSUPPORTED_OPTIONS');
    const worker = parseInt(options.slice(cursor, cursor + 2), 16);
    const size = parseInt(options.slice(cursor + 2, cursor + 6), 16);
    const type = parseInt(options.slice(cursor + 6, cursor + 8), 16);
    const end = cursor + 6 + size * 2;
    if (size < 1 || end > options.length) fail('실행 옵션 길이가 맞지 않습니다.', 'UNSUPPORTED_OPTIONS');
    const payload = options.slice(cursor + 8, end);
    if (worker !== 1) fail(`worker ${worker} 옵션은 현재 자동 생성 범위 밖입니다.`, 'UNSUPPORTED_OPTIONS');
    if (type === 1) {
      if (![32, 64].includes(payload.length)) fail('lzReceive 옵션 크기가 잘못되었습니다.', 'UNSUPPORTED_OPTIONS');
      gas += BigInt(`0x${payload.slice(0, 32)}`);
      if (payload.length === 64 && BigInt(`0x${payload.slice(32)}`) !== 0n) fail('네이티브 토큰을 목적지로 전달하는 옵션은 현재 미지원입니다.', 'UNSUPPORTED_OPTIONS');
    } else if (type === 4 && payload === '') ordered = true;
    else fail(`Executor 옵션 ${type}는 현재 자동 생성 범위 밖입니다. lzReceive·ordered만 지원합니다.`, 'UNSUPPORTED_OPTIONS');
    if (gas > MAX_GAS) fail('합산 수신 gas가 uint128 범위를 초과합니다.', 'UNSUPPORTED_OPTIONS');
    cursor = end;
  }
  return { gas, ordered };
}
export function combinedOptions(enforced: string, extra: string): Hex {
  inspectOptions(enforced); inspectOptions(extra);
  const combined = enforced === '0x' ? extra : extra === '0x' ? enforced : enforced + extra.slice(6);
  inspectOptions(combined);
  return combined as Hex;
}
