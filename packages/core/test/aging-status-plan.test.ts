import { describe, expect, it } from 'vitest';
import { AGING_BUCKETS, agingBucket, bucketTotals } from '../src/aging';
import {
  InvalidTransitionError,
  initialStatus,
  nextStatus,
  STATUS_META,
  STATUS_ORDER,
  type BalanceStatus,
} from '../src/status';
import { buildPaymentPlan, MIN_INSTALLMENT_CENTS, planOption } from '../src/plan';

describe('aging buckets', () => {
  it.each([
    [0, '0-30'],
    [9, '0-30'],
    [30, '0-30'],
    [31, '31-60'],
    [60, '31-60'],
    [61, '61-90'],
    [69, '61-90'],
    [90, '61-90'],
    [91, '90+'],
    [112, '90+'],
  ])('%i days → %s', (days, bucket) => {
    expect(agingBucket(days)).toBe(bucket);
  });

  it('rejects negative or fractional day counts', () => {
    expect(() => agingBucket(-1)).toThrow(RangeError);
    expect(() => agingBucket(2.5)).toThrow(RangeError);
  });

  it('labels buckets with en dashes like the design', () => {
    expect(AGING_BUCKETS.map((b) => b.label)).toEqual(['0–30', '31–60', '61–90', '90+']);
  });

  it('totals amounts per bucket in display order, including empty buckets', () => {
    expect(
      bucketTotals([
        { days: 9, cents: 16000 },
        { days: 28, cents: 36800 },
        { days: 46, cents: 24000 },
        { days: 112, cents: 60000 },
      ]),
    ).toEqual([
      { bucket: '0-30', label: '0–30', cents: 52800, count: 2 },
      { bucket: '31-60', label: '31–60', cents: 24000, count: 1 },
      { bucket: '61-90', label: '61–90', cents: 0, count: 0 },
      { bucket: '90+', label: '90+', cents: 60000, count: 1 },
    ]);
  });
});

describe('status machine', () => {
  it('has icon + label for every status, in the design group order', () => {
    expect(STATUS_ORDER).toEqual(['review', 'denied', 'ready', 'sent', 'partial', 'paid']);
    expect(STATUS_META.review).toEqual({ label: 'Needs review', icon: '!' });
    expect(STATUS_META.denied).toEqual({ label: 'Denied', icon: '×' });
    expect(STATUS_META.ready).toEqual({ label: 'Ready to invoice', icon: '→' });
    expect(STATUS_META.sent).toEqual({ label: 'Sent', icon: '↗' });
    expect(STATUS_META.partial).toEqual({ label: 'Partially paid', icon: '◐' });
    expect(STATUS_META.paid).toEqual({ label: 'Paid', icon: '✓' });
  });

  it('walks the happy path review → ready → sent → partial → paid', () => {
    let s: BalanceStatus = 'review';
    s = nextStatus(s, { type: 'approve' });
    expect(s).toBe('ready');
    s = nextStatus(s, { type: 'send' });
    expect(s).toBe('sent');
    s = nextStatus(s, { type: 'payment', remainingCents: 16000 });
    expect(s).toBe('partial');
    s = nextStatus(s, { type: 'payment', remainingCents: 8000 });
    expect(s).toBe('partial');
    s = nextStatus(s, { type: 'payment', remainingCents: 0 });
    expect(s).toBe('paid');
  });

  it('supports denial and resubmission', () => {
    expect(nextStatus('review', { type: 'deny' })).toBe('denied');
    expect(nextStatus('denied', { type: 'resubmit' })).toBe('review');
  });

  it('lets staff send a row back to review, and take a front-desk payment before sending', () => {
    expect(nextStatus('ready', { type: 'flag' })).toBe('review');
    expect(nextStatus('sent', { type: 'flag' })).toBe('review');
    expect(nextStatus('ready', { type: 'payment', remainingCents: 0 })).toBe('paid');
  });

  it.each([
    ['review', { type: 'send' }],
    ['review', { type: 'payment', remainingCents: 0 }],
    ['denied', { type: 'payment', remainingCents: 0 }],
    ['paid', { type: 'payment', remainingCents: 0 }],
    ['paid', { type: 'send' }],
    ['sent', { type: 'approve' }],
  ] as const)('refuses %s + %o', (from, event) => {
    expect(() => nextStatus(from, event)).toThrow(InvalidTransitionError);
  });

  it('refuses a negative remaining balance', () => {
    expect(() => nextStatus('sent', { type: 'payment', remainingCents: -1 })).toThrow(RangeError);
  });

  it('picks an initial status from the claim', () => {
    expect(initialStatus({ denied: true, patientOwesCents: 0, needsReview: false })).toBe('denied');
    expect(initialStatus({ denied: false, patientOwesCents: 24000, needsReview: true })).toBe(
      'review',
    );
    expect(initialStatus({ denied: false, patientOwesCents: 24000, needsReview: false })).toBe(
      'ready',
    );
    expect(initialStatus({ denied: false, patientOwesCents: 0, needsReview: false })).toBe('paid');
  });
});

describe('payment plans', () => {
  it('splits $240 into 3 × $80 starting today, monthly', () => {
    expect(buildPaymentPlan(24000, 3, '2026-10-10')).toEqual([
      { number: 1, dueDate: '2026-10-10', amountCents: 8000 },
      { number: 2, dueDate: '2026-11-10', amountCents: 8000 },
      { number: 3, dueDate: '2026-12-10', amountCents: 8000 },
    ]);
  });

  it('splits $600 into 6 × $100', () => {
    const plan = buildPaymentPlan(60000, 6, '2026-10-10');
    expect(plan.map((i) => i.amountCents)).toEqual([10000, 10000, 10000, 10000, 10000, 10000]);
    expect(plan.at(-1)!.dueDate).toBe('2027-03-10');
  });

  it('puts leftover cents on the first payment so the auto-pays are equal, and always sums exactly', () => {
    const plan = buildPaymentPlan(10000, 3, '2026-01-31');
    expect(plan.map((i) => i.amountCents)).toEqual([3334, 3333, 3333]);
    expect(plan.map((i) => i.dueDate)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    for (const total of [1, 99, 10001, 36800, 123457]) {
      for (const months of [3, 6] as const) {
        const sum = buildPaymentPlan(Math.max(total, months), months, '2026-10-10').reduce(
          (s, i) => s + i.amountCents,
          0,
        );
        expect(sum).toBe(Math.max(total, months));
      }
    }
  });

  it('rejects bad input', () => {
    expect(() => buildPaymentPlan(0, 3, '2026-10-10')).toThrow();
    expect(() => buildPaymentPlan(100.5, 3, '2026-10-10')).toThrow();
    expect(() => buildPaymentPlan(24000, 4 as 3, '2026-10-10')).toThrow(/3 or 6/);
  });

  it('describes plan options and eligibility (each installment at least $20)', () => {
    expect(MIN_INSTALLMENT_CENTS).toBe(2000);
    expect(planOption(24000, 3)).toEqual({
      months: 3,
      firstCents: 8000,
      regularCents: 8000,
      eligible: true,
    });
    expect(planOption(24000, 6)).toEqual({
      months: 6,
      firstCents: 4000,
      regularCents: 4000,
      eligible: true,
    });
    expect(planOption(10000, 6)).toEqual({
      months: 6,
      firstCents: 1670,
      regularCents: 1666,
      eligible: false,
    });
    expect(planOption(10000, 3)).toEqual({
      months: 3,
      firstCents: 3334,
      regularCents: 3333,
      eligible: true,
    });
  });
});
