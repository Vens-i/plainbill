import type { Cents } from './money';

export type AgingBucket = '0-30' | '31-60' | '61-90' | '90+';

export const AGING_BUCKETS: ReadonlyArray<{ key: AgingBucket; label: string; maxDays: number }> = [
  { key: '0-30', label: '0–30', maxDays: 30 },
  { key: '31-60', label: '31–60', maxDays: 60 },
  { key: '61-90', label: '61–90', maxDays: 90 },
  { key: '90+', label: '90+', maxDays: Number.POSITIVE_INFINITY },
];

/** Days since the visit → aging bucket. */
export function agingBucket(days: number): AgingBucket {
  if (!Number.isInteger(days) || days < 0) {
    throw new RangeError(`days out must be a non-negative integer, got ${days}`);
  }
  return AGING_BUCKETS.find((b) => days <= b.maxDays)!.key;
}

export function agingLabel(bucket: AgingBucket): string {
  return AGING_BUCKETS.find((b) => b.key === bucket)!.label;
}

export interface BucketTotal {
  bucket: AgingBucket;
  label: string;
  cents: Cents;
  count: number;
}

/** Sum amounts into every bucket, in display order (empty buckets included). */
export function bucketTotals(items: ReadonlyArray<{ days: number; cents: Cents }>): BucketTotal[] {
  const totals = AGING_BUCKETS.map((b) => ({ bucket: b.key, label: b.label, cents: 0, count: 0 }));
  for (const item of items) {
    const total = totals.find((t) => t.bucket === agingBucket(item.days))!;
    total.cents += item.cents;
    total.count += 1;
  }
  return totals;
}

/**
 * The five aging boxes on a paper patient statement. Coarser than the dashboard's buckets at the
 * old end, because statements traditionally split 91–120 from "over 120".
 */
export type StatementAgingKey = 'current' | '31-60' | '61-90' | '91-120' | '120+';

export const STATEMENT_AGING: ReadonlyArray<{
  key: StatementAgingKey;
  label: string;
  maxDays: number;
}> = [
  { key: 'current', label: 'CURRENT', maxDays: 30 },
  { key: '31-60', label: '31–60 DAYS', maxDays: 60 },
  { key: '61-90', label: '61–90 DAYS', maxDays: 90 },
  { key: '91-120', label: '91–120 DAYS', maxDays: 120 },
  { key: '120+', label: 'OVER 120 DAYS', maxDays: Number.POSITIVE_INFINITY },
];

export function statementAgingKey(days: number): StatementAgingKey {
  if (!Number.isInteger(days) || days < 0) {
    throw new RangeError(`days out must be a non-negative integer, got ${days}`);
  }
  return STATEMENT_AGING.find((b) => days <= b.maxDays)!.key;
}

/** A one-visit statement: the whole open balance sits in the box for the days since the visit. */
export function statementAging(
  remainingCents: Cents,
  daysSinceVisit: number,
): Record<StatementAgingKey, Cents> {
  const aging = { current: 0, '31-60': 0, '61-90': 0, '91-120': 0, '120+': 0 };
  aging[statementAgingKey(daysSinceVisit)] = remainingCents;
  return aging;
}
