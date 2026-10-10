import { describe, expect, it } from 'vitest';
import type { BalanceRow, Kpis } from '@plainbill/api/contract';
import {
  collectedDelta,
  greeting,
  groupMeta,
  isPaidNow,
  needsAction,
  plainGroupMeta,
  relativeTime,
  todoSummary,
} from '../src/lib/dashboard';

const row = (over: Partial<BalanceRow>): BalanceRow =>
  ({
    status: 'ready',
    billedCents: 0,
    remainingCents: 0,
    patientPaidCents: 0,
    paidAt: null,
    paidOn: null,
    ...over,
  }) as BalanceRow;

describe('groupMeta', () => {
  it('matches the design copy for each status', () => {
    const review = [16000, 36800, 31000, 24000].map((c) =>
      row({ status: 'review', remainingCents: c }),
    );
    expect(groupMeta('review', review)).toBe('4 visits · $1,078 to confirm');
    expect(groupMeta('denied', [row({ billedCents: 240000 }), row({ billedCents: 61000 })])).toBe(
      '2 visits · $3,010 billed',
    );
    expect(
      groupMeta('ready', [row({ remainingCents: 24000 }), row({ remainingCents: 27500 })]),
    ).toBe('2 visits · $515 to invoice');
    expect(
      groupMeta('sent', [row({ remainingCents: 25000 }), row({ remainingCents: 15000 })]),
    ).toBe('2 visits · $400 outstanding');
    expect(groupMeta('partial', [row({ remainingCents: 60000 })])).toBe('1 visit · $600 remaining');
    expect(
      groupMeta('paid', [row({ patientPaidCents: 8000 }), row({ patientPaidCents: 10000 })]),
    ).toBe('2 visits · $180 collected');
  });

  it('summarizes payer/provider groups by open balance', () => {
    expect(
      plainGroupMeta([
        row({ status: 'sent', remainingCents: 8000 }),
        row({ status: 'paid', remainingCents: 0 }),
        row({ status: 'denied', remainingCents: 0 }),
      ]),
    ).toBe('3 visits · $80 open');
  });
});

describe('greeting and to-do line', () => {
  it('greets by time of day', () => {
    expect(greeting(8)).toBe('Good morning');
    expect(greeting(13)).toBe('Good afternoon');
    expect(greeting(19)).toBe('Good evening');
  });

  const kpis = (review: number, ready: number, todoMinutes: number) =>
    ({ review: { count: review }, ready: { count: ready }, todoMinutes }) as Pick<
      Kpis,
      'review' | 'ready' | 'todoMinutes'
    >;

  it('writes the design sentence from counts', () => {
    expect(todoSummary(kpis(4, 2, 5))).toBe(
      '4 visits need a quick check, then 2 bills are ready to send. About 5 minutes.',
    );
    expect(todoSummary(kpis(1, 0, 1))).toBe('1 visit needs a quick check. About 1 minute.');
    expect(todoSummary(kpis(0, 1, 1))).toBe('1 bill is ready to send. About 1 minute.');
    expect(todoSummary(kpis(0, 0, 0))).toMatch(/Nothing waiting/);
  });
});

describe('live payment helpers', () => {
  const now = Date.parse('2026-10-10T14:00:00.000Z');

  it('formats relative time', () => {
    expect(relativeTime('2026-10-10T13:59:30.000Z', now)).toBe('just now');
    expect(relativeTime('2026-10-10T13:57:00.000Z', now)).toBe('3 min ago');
    expect(relativeTime('2026-10-10T11:00:00.000Z', now)).toBe('3 hr ago');
    expect(relativeTime('2026-10-08T14:00:00.000Z', now)).toBe('2 days ago');
  });

  it('treats a payment as "paid now" for 15 minutes', () => {
    expect(isPaidNow(row({ status: 'paid', paidAt: '2026-10-10T13:50:00.000Z' }), now)).toBe(true);
    expect(isPaidNow(row({ status: 'paid', paidAt: '2026-10-10T13:40:00.000Z' }), now)).toBe(false);
    expect(isPaidNow(row({ status: 'paid', paidAt: '2026-09-16T17:00:00.000Z' }), now)).toBe(false);
    expect(isPaidNow(row({ status: 'sent', paidAt: null }), now)).toBe(false);
  });

  it('"Needs action" keeps recent payments and hides old ones', () => {
    expect(needsAction(row({ status: 'sent' }), '2026-10-10')).toBe(true);
    expect(needsAction(row({ status: 'paid', paidOn: '2026-09-16' }), '2026-10-10')).toBe(true);
    expect(needsAction(row({ status: 'paid', paidOn: '2026-08-01' }), '2026-10-10')).toBe(false);
  });

  it('describes month-over-month collections', () => {
    const base = { month: 'October', previousMonth: 'September' };
    expect(collectedDelta({ ...base, cents: 30000, previousCents: 10000 })).toEqual({
      text: '▲ $200 vs. September',
      tone: 'good',
    });
    expect(collectedDelta({ ...base, cents: 5000, previousCents: 10000 })).toEqual({
      text: '▼ $50 vs. September',
      tone: 'bad',
    });
    expect(collectedDelta({ ...base, cents: 100, previousCents: 100 })).toEqual({
      text: 'Same as September',
      tone: 'neutral',
    });
  });
});
