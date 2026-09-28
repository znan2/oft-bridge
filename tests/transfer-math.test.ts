import { describe, expect, it } from 'vitest';
import { conversionRate, decimalAmount, destinationAmount, slippageBps, UINT256_MAX, UINT64_MAX } from '../src/lib/transfer-math';
import { combinedOptions, inspectOptions, receiveOption } from '../src/lib/transfer-options';
describe('exact transfer amounts', () => {
  it('preserves values beyond JS safe integers without rounding', () => {
    expect(decimalAmount('9007199254740993.123456789012345678', 18)).toBe(9007199254740993123456789012345678n);
    expect(decimalAmount(UINT256_MAX.toString(), 0)).toBe(UINT256_MAX);
  });
  it.each(['1e3', '-1', '+1', '.5', '01', '1,000', ' 1', '1.', '0x12', '', '1.1234567'])('rejects ambiguous or excessive precision: %s', value => expect(() => decimalAmount(value, 6)).toThrow());
  it('enforces integer bounds and slippage precision', () => {
    expect(() => decimalAmount((UINT256_MAX + 1n).toString(), 0)).toThrow(/uint256/);
    expect(slippageBps('0.25')).toBe(25n); expect(slippageBps('100')).toBe(10000n);
    expect(() => slippageBps('100.01')).toThrow(); expect(() => slippageBps('0.001')).toThrow();
  });
  it('converts between different local decimals through shared decimals', () => {
    expect(destinationAmount(1234567000000000000n, conversionRate(18, 6), conversionRate(8, 6))).toBe(123456700n);
    expect(() => destinationAmount(1n, 10n ** 12n, 100n)).toThrow(/단위/);
    expect(() => destinationAmount(UINT64_MAX + 1n, 1n, 1n)).toThrow(/uint64/);
    expect(() => destinationAmount(UINT64_MAX, 1n, 10n ** 77n)).toThrow(/uint256/);
    expect(() => conversionRate(5, 6)).toThrow(); expect(() => conversionRate(255, 6)).toThrow();
  });
});
describe('executor Type 3 options', () => {
  it('decodes the DOS gas/value layout and adds extra gas', () => {
    const dos = '0x000301002101000000000000000000000000000186a000000000000000000000000000000000';
    expect(inspectOptions(dos).gas).toBe(100000n);
    expect(receiveOption('0')).toBe('0x');
    expect(combinedOptions(dos, '0x')).toBe(dos);
    expect(inspectOptions(combinedOptions(dos, receiveOption('50000'))).gas).toBe(150000n);
    expect(inspectOptions(combinedOptions(receiveOption('1'), '0x000301000104')).ordered).toBe(true);
  });
  it.each(['0x0001', '0x0', '0x000301', '0x000301000001', '0x00030100110100', '0x000302000101', '0x000301000102', '0x000301000103', '0x000301000105', '0x00030100020400'])('rejects unsupported or malformed options %s', value => expect(() => inspectOptions(value)).toThrow());
  it('rejects native value, duplicate gas overflow and fractions', () => {
    expect(() => inspectOptions('0x000301002101' + '0'.repeat(31) + '1' + '0'.repeat(31) + '1')).toThrow(/네이티브/);
    expect(() => combinedOptions(receiveOption(((1n << 128n) - 1n).toString()), receiveOption('1'))).toThrow(/합산/);
    expect(() => receiveOption('1.5')).toThrow(); expect(() => receiveOption((1n << 128n).toString())).toThrow();
  });
});
