export const UINT256_MAX = (1n << 256n) - 1n;
export const UINT64_MAX = (1n << 64n) - 1n;
export class TransferError extends Error {
  constructor(public code: string, message: string, public data?: string) { super(message); }
}
export function fail(message: string, code = 'INVALID_INPUT'): never { throw new TransferError(code, message); }
export function decimalAmount(value: string, decimals: number, label = '수량'): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) fail('지원할 수 없는 decimals입니다.', 'UNSUPPORTED');
  if (value.length > 160 || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value)) fail(`${label}: 음수·지수·쉼표 없이 숫자를 입력하세요.`);
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) fail(`${label}: 소수점 이하 ${decimals}자리까지만 입력할 수 있습니다.`);
  const amount = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (amount > UINT256_MAX) fail(`${label}: uint256 범위를 초과합니다.`);
  return amount;
}
export function slippageBps(value: string) {
  const bps = decimalAmount(value, 2, '슬리피지');
  if (bps > 10000n) fail('슬리피지는 0~100% 범위여야 합니다.');
  return bps;
}
export function conversionRate(local: number, shared: number) {
  if (![local, shared].every(n => Number.isInteger(n) && n >= 0 && n <= 77) || local < shared) fail('decimals 변환을 지원하지 않습니다.', 'UNSUPPORTED');
  return 10n ** BigInt(local - shared);
}
export function destinationAmount(sourceLD: bigint, sourceRate: bigint, destinationRate: bigint) {
  if (sourceLD % sourceRate !== 0n) fail('견적 수령량이 sharedDecimals 단위와 일치하지 않습니다.', 'UNSUPPORTED');
  const sd = sourceLD / sourceRate;
  if (sd > UINT64_MAX) fail('전송량이 LayerZero uint64 공유 단위 범위를 초과합니다.', 'AMOUNT_OVERFLOW');
  const ld = sd * destinationRate;
  if (ld > UINT256_MAX) fail('목적지 수량이 uint256 범위를 초과합니다.', 'AMOUNT_OVERFLOW');
  return ld;
}
