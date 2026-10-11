/**
 * Pure presentation helpers for the dashboard (unit-tested in test/dashboard.test.ts). Amounts
 * are already computed by the API from @plainbill/core; these only choose words.
 */
import { addDays, formatMoneyShort, type BalanceStatus, type IsoDate } from '@plainbill/core';
import type { BalanceRow, Kpis } from '@plainbill/api/contract';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A group row's parts: "4 visits" in a chip, then "$1,078" + " to confirm" on the right. */
export interface GroupSummary {
  visits: string;
  amount: string;
  what: string;
}

export function groupSummary(status: BalanceStatus, rows: readonly BalanceRow[]): GroupSummary {
  const sum = (f: (r: BalanceRow) => number) =>
    formatMoneyShort(rows.reduce((t, r) => t + f(r), 0));
  const visits = plural(rows.length, 'visit');
  switch (status) {
    case 'review':
      return { visits, amount: sum((r) => r.remainingCents), what: 'to confirm' };
    case 'denied':
      return { visits, amount: sum((r) => r.billedCents), what: 'billed' };
    case 'ready':
      return { visits, amount: sum((r) => r.remainingCents), what: 'to invoice' };
    case 'sent':
      return { visits, amount: sum((r) => r.remainingCents), what: 'outstanding' };
    case 'partial':
      return { visits, amount: sum((r) => r.remainingCents), what: 'remaining' };
    case 'paid':
      return { visits, amount: sum((r) => r.patientPaidCents), what: 'collected' };
  }
}

/** Summary when grouping by payer or provider. */
export function plainGroupSummary(rows: readonly BalanceRow[]): GroupSummary {
  const open = rows.filter((r) => r.status !== 'paid' && r.status !== 'denied');
  return {
    visits: plural(rows.length, 'visit'),
    amount: formatMoneyShort(open.reduce((t, r) => t + r.remainingCents, 0)),
    what: 'open',
  };
}

const metaLine = ({ visits, amount, what }: GroupSummary) => `${visits} · ${amount} ${what}`;

/** Group-row meta line: "4 visits · $1,078 to confirm". */
export function groupMeta(status: BalanceStatus, rows: readonly BalanceRow[]): string {
  return metaLine(groupSummary(status, rows));
}

/** Meta line when grouping by payer or provider. */
export function plainGroupMeta(rows: readonly BalanceRow[]): string {
  return metaLine(plainGroupSummary(rows));
}

export function greeting(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/** "4 visits need a quick check, then 2 bills are ready to send. About 5 minutes." */
export function todoSummary(kpis: Pick<Kpis, 'review' | 'ready' | 'todoMinutes'>): string {
  const review = kpis.review.count;
  const ready = kpis.ready.count;
  if (review === 0 && ready === 0)
    return 'Nothing waiting on you right now. Payments will show up here live.';
  const parts: string[] = [];
  if (review > 0)
    parts.push(`${plural(review, 'visit')} ${review === 1 ? 'needs' : 'need'} a quick check`);
  if (ready > 0) {
    const bills = `${plural(ready, 'bill')} ${ready === 1 ? 'is' : 'are'} ready to send`;
    parts.push(review > 0 ? `then ${bills}` : bills);
  }
  const sentence = parts.join(', ');
  const minutes = Math.max(1, kpis.todoMinutes);
  return `${sentence[0]!.toUpperCase()}${sentence.slice(1)}. About ${plural(minutes, 'minute')}.`;
}

/** "just now", "3 min ago", "2 hr ago" — for the live "Paid via PayPal" badge. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return plural(Math.round(hours / 24), 'day') + ' ago';
}

/** How long a payment stays highlighted as "paid now" on the dashboard. */
export const PAID_NOW_WINDOW_MS = 15 * 60 * 1000;

export function isPaidNow(
  row: Pick<BalanceRow, 'status' | 'paidAt'>,
  now: number = Date.now(),
): boolean {
  return (
    row.status === 'paid' && row.paidAt != null && now - Date.parse(row.paidAt) < PAID_NOW_WINDOW_MS
  );
}

/**
 * "Needs action" hides balances that were settled more than 30 days ago; recent payments stay
 * visible as confirmation (the design shows the Paid group under this view).
 */
export function needsAction(row: Pick<BalanceRow, 'status' | 'paidOn'>, today: IsoDate): boolean {
  if (row.status !== 'paid') return true;
  return row.paidOn != null && row.paidOn >= addDays(today, -30);
}

/** "▲ $2,140 vs. September" */
export function collectedDelta(k: Kpis['collectedThisMonth']): {
  text: string;
  tone: 'good' | 'bad' | 'neutral';
} {
  const delta = k.cents - k.previousCents;
  if (delta === 0) return { text: `Same as ${k.previousMonth}`, tone: 'neutral' };
  return delta > 0
    ? { text: `▲ ${formatMoneyShort(delta)} vs. ${k.previousMonth}`, tone: 'good' }
    : { text: `▼ ${formatMoneyShort(-delta)} vs. ${k.previousMonth}`, tone: 'bad' };
}
