import { describe, expect, it } from 'vitest';
import {
  assertCents,
  centsToDecimalString,
  dollars,
  formatMoney,
  formatMoneyShort,
  parseDecimalToCents,
  sumCents,
} from '../src/money';

describe('parseDecimalToCents', () => {
  it.each([
    ['850', 85000],
    ['850.00', 85000],
    ['850.5', 85050],
    ['0.07', 7],
    ['.5', 50],
    ['1480', 148000],
    ['-12.34', -1234],
    ['+3', 300],
    ['0', 0],
  ])('parses %s exactly', (input, expected) => {
    expect(parseDecimalToCents(input)).toBe(expected);
  });

  it('never goes through floating point (0.29 is a classic float trap)', () => {
    expect(parseDecimalToCents('0.29')).toBe(29);
    expect(parseDecimalToCents('1234567.89')).toBe(123456789);
  });

  it('accepts trailing zeros beyond cents but rejects real sub-cent amounts', () => {
    expect(parseDecimalToCents('12.500')).toBe(1250);
    expect(() => parseDecimalToCents('12.345')).toThrow(/sub-cent/);
  });

  it.each(['', ' ', 'abc', '12.3.4', '1,000', '$5', '-', '.'])('rejects %j', (input) => {
    expect(() => parseDecimalToCents(input)).toThrow();
  });
});

describe('centsToDecimalString', () => {
  it.each([
    [85000, '850'],
    [85050, '850.5'],
    [7, '0.07'],
    [-1234, '-12.34'],
    [0, '0'],
  ])('formats %i as %s (X12 style: no needless zeros)', (input, expected) => {
    expect(centsToDecimalString(input)).toBe(expected);
  });
});

describe('formatMoney', () => {
  it('formats with thousands separators and cents', () => {
    expect(formatMoney(85000)).toBe('$850.00');
    expect(formatMoney(148000)).toBe('$1,480.00');
    expect(formatMoney(1)).toBe('$0.01');
    expect(formatMoney(0)).toBe('$0.00');
  });

  it('uses a true minus sign for negatives, matching the design', () => {
    expect(formatMoney(-40000)).toBe('−$400.00');
  });

  it('can force a sign for adjustments', () => {
    expect(formatMoney(-21000, { sign: 'always' })).toBe('−$210.00');
    expect(formatMoney(20000, { sign: 'always' })).toBe('+$200.00');
  });

  it('short form drops .00 but keeps real cents', () => {
    expect(formatMoneyShort(107800)).toBe('$1,078');
    expect(formatMoneyShort(1842000)).toBe('$18,420');
    expect(formatMoneyShort(3334)).toBe('$33.34');
    expect(formatMoneyShort(-40000)).toBe('−$400');
  });
});

describe('cents helpers', () => {
  it('dollars() converts whole and two-decimal literals exactly', () => {
    expect(dollars(850)).toBe(85000);
    expect(dollars(0.29)).toBe(29);
    expect(dollars(1480.5)).toBe(148050);
    expect(() => dollars(1.005)).toThrow();
  });

  it('assertCents rejects fractions, NaN and unsafe numbers', () => {
    expect(() => assertCents(10.5)).toThrow(/integer/);
    expect(() => assertCents(Number.NaN)).toThrow();
    expect(() => assertCents(Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() => assertCents(100)).not.toThrow();
  });

  it('sumCents adds integers and validates inputs', () => {
    expect(sumCents([40000, 21000, 24000])).toBe(85000);
    expect(sumCents([])).toBe(0);
    expect(() => sumCents([1, 0.5])).toThrow();
  });
});
