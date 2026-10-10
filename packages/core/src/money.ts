/**
 * Money is always an integer number of cents. Nothing in Plainbill does arithmetic on
 * floating-point dollars: amounts are parsed from text straight into cents, and only turned
 * back into text for display.
 */
export type Cents = number;

const MINUS = '−';

export function assertCents(value: number, label = 'amount'): asserts value is Cents {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a safe integer number of cents, got ${String(value)}`);
  }
}

export function sumCents(values: readonly Cents[]): Cents {
  let total = 0;
  for (const v of values) {
    assertCents(v);
    total += v;
  }
  assertCents(total, 'sum');
  return total;
}

const DECIMAL_RE = /^([+-])?(\d*)(?:\.(\d*))?$/;

/**
 * Parse a decimal string ("850", "850.5", "-12.34", ".5") into integer cents without
 * touching floating point. Trailing zeros past the cents place are allowed ("12.500");
 * real sub-cent amounts ("12.345") are rejected.
 */
export function parseDecimalToCents(input: string): Cents {
  const text = input.trim();
  const match = DECIMAL_RE.exec(text);
  const whole = match?.[2] ?? '';
  const frac = match?.[3] ?? '';
  if (!match || (whole === '' && frac === '')) {
    throw new SyntaxError(`not a decimal amount: ${JSON.stringify(input)}`);
  }
  if (/[1-9]/.test(frac.slice(2))) {
    throw new RangeError(`sub-cent amount not allowed: ${JSON.stringify(input)}`);
  }
  const cents = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2));
  const signed = match[1] === '-' ? -cents : cents;
  assertCents(signed);
  return signed === 0 ? 0 : signed; // normalize -0
}

/** Cents → minimal decimal string, as X12 expects ("850", "850.5", "0.07"). */
export function centsToDecimalString(value: Cents): string {
  assertCents(value);
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const whole = Math.trunc(abs / 100);
  const frac = String(abs % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return sign + String(whole) + (frac ? `.${frac}` : '');
}

/**
 * Whole dollars → cents, for literals in seed data and tests. Accepts at most two decimals and
 * converts via the string form so 0.29 stays 29 cents.
 */
export function dollars(amount: number): Cents {
  if (!Number.isFinite(amount)) throw new TypeError(`not a finite amount: ${amount}`);
  return parseDecimalToCents(String(amount));
}

function groupThousands(whole: number): string {
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export interface FormatMoneyOptions {
  /** 'auto' prints a minus for negatives only; 'always' also prints + for positives. */
  sign?: 'auto' | 'always';
}

/** 85000 → "$850.00", -40000 → "−$400.00" (true minus sign, as in the design). */
export function formatMoney(value: Cents, options: FormatMoneyOptions = {}): string {
  assertCents(value);
  const abs = Math.abs(value);
  const body = `$${groupThousands(Math.trunc(abs / 100))}.${String(abs % 100).padStart(2, '0')}`;
  if (value < 0) return MINUS + body;
  if (options.sign === 'always' && value > 0) return '+' + body;
  return body;
}

/** Compact form for summaries: "$1,078" when the cents are zero, "$33.34" otherwise. */
export function formatMoneyShort(value: Cents): string {
  const full = formatMoney(value);
  return full.endsWith('.00') ? full.slice(0, -3) : full;
}
