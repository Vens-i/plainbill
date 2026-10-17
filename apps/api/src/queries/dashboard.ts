/**
 * KPI strip and side-panel charts. Everything is computed from rows and payments; nothing is
 * hardcoded from the design mock.
 */
import { asc } from 'drizzle-orm';
import {
  bucketTotals,
  daysBetween,
  describeAdjustment,
  isGroupCode,
  monthKey,
  monthName,
  previousMonthKey,
  type BalanceStatus,
  type IsoDate,
} from '@plainbill/core';
import type { AgingChart, BalanceRow, DenialsChart, Kpis } from '../contract';
import type { DbLike } from '../db/client';
import { payments, practices } from '../db/schema';

const OPEN: readonly BalanceStatus[] = ['review', 'ready', 'sent', 'partial'];

/** A balance with money still owed by the patient: what Outstanding adds up. */
export const isOpen = (r: BalanceRow) => OPEN.includes(r.status) && r.remainingCents > 0;

export function computeKpis(db: DbLike, rows: BalanceRow[], today: IsoDate): Kpis {
  const open = rows.filter(isOpen);
  const outstandingPatients = new Set(open.map((r) => r.patientName)).size;

  const thisMonth = monthKey(today);
  const lastMonth = previousMonthKey(thisMonth);
  const allPayments = db.select().from(payments).all();
  const collectedIn = (key: string) =>
    allPayments.filter((p) => monthKey(p.postedOn) === key).reduce((s, p) => s + p.amountCents, 0);

  const paidRows = rows.filter(
    (r) => r.status === 'paid' && r.patientPaidCents > 0 && r.paidInDays != null,
  );
  const avgDays = paidRows.length
    ? Math.round(paidRows.reduce((s, r) => s + r.paidInDays!, 0) / paidRows.length)
    : null;

  const review = rows.filter((r) => r.status === 'review');
  const ready = rows.filter((r) => r.status === 'ready');
  const practice = db.select().from(practices).orderBy(asc(practices.id)).get();

  return {
    today,
    outstanding: {
      cents: open.reduce((s, r) => s + r.remainingCents, 0),
      patients: outstandingPatients,
    },
    collectedThisMonth: {
      cents: collectedIn(thisMonth),
      previousCents: collectedIn(lastMonth),
      month: monthName(thisMonth),
      previousMonth: monthName(lastMonth),
    },
    avgDaysToPay: {
      days: avgDays,
      paidCount: paidRows.length,
      paperBaselineDays: practice?.paperBaselineDays ?? null,
    },
    review: {
      count: review.length,
      cents: review.reduce((s, r) => s + r.remainingCents, 0),
      firstPatientName: review[0]?.patientName ?? null,
      firstBalanceId: review[0]?.id ?? null,
    },
    ready: { count: ready.length, cents: ready.reduce((s, r) => s + r.remainingCents, 0) },
    todoMinutes: Math.ceil(review.length * 1 + ready.length * 0.5),
  };
}

export function computeAgingChart(rows: BalanceRow[]): AgingChart {
  const open = rows.filter(isOpen);
  const buckets = bucketTotals(
    open.map((r) => ({ days: r.daysOut ?? 0, cents: r.remainingCents })),
  );
  return { totalCents: open.reduce((s, r) => s + r.remainingCents, 0), buckets };
}

export const DENIAL_WINDOW_DAYS = 90;

export function computeDenialsChart(rows: BalanceRow[], today: IsoDate): DenialsChart {
  const insurancePayers = new Map<string, { payer: string; shortName: string }>();
  for (const r of rows) {
    if (r.payerKind === 'insurance')
      insurancePayers.set(r.payerId, { payer: r.payerName, shortName: r.payerShortName });
  }
  const denied = rows.filter(
    (r) => r.status === 'denied' && daysBetween(r.visitDate, today) <= DENIAL_WINDOW_DAYS,
  );

  const counts = new Map<string, number>();
  for (const r of denied) counts.set(r.payerId, (counts.get(r.payerId) ?? 0) + 1);
  const payers = [...insurancePayers]
    .map(([payerId, p]) => ({ payerId, ...p, count: counts.get(payerId) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.shortName.localeCompare(b.shortName));

  // Most common reason: each denial counts under its largest write-off code; ties go to the code
  // with more dollars behind it.
  const byCode = new Map<string, { count: number; cents: number }>();
  for (const r of denied) {
    const main = r.adjustments
      .filter((a) => a.kind === 'writeoff')
      .sort((a, b) => (a.amountCents ?? 0) - (b.amountCents ?? 0))[0];
    if (!main) continue;
    const entry = byCode.get(main.code) ?? { count: 0, cents: 0 };
    entry.count += 1;
    entry.cents += -(main.amountCents ?? 0);
    byCode.set(main.code, entry);
  }
  const top = [...byCode].sort((a, b) => b[1].count - a[1].count || b[1].cents - a[1].cents)[0];
  let mostCommon: DenialsChart['mostCommon'] = null;
  if (top) {
    const [group = '', reason = ''] = top[0].split('-');
    mostCommon = {
      code: top[0],
      label: isGroupCode(group) ? describeAdjustment(group, reason).label : top[0],
      count: top[1].count,
    };
  }

  return { windowDays: DENIAL_WINDOW_DAYS, total: denied.length, payers, mostCommon };
}
