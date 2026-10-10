import { addMonths, type IsoDate } from './dates';
import { assertCents, type Cents } from './money';

/**
 * Interest-free payment plans: 3 or 6 monthly payments, the first one today. Any leftover
 * cents go on the first payment, so every later auto-pay is the same amount, and the plan
 * always sums to exactly the balance.
 */
export type PlanMonths = 3 | 6;

export const PLAN_MONTHS: readonly PlanMonths[] = [3, 6];

/** Each installment must be at least $20 (matches the "partial, $20 min" invoice option). */
export const MIN_INSTALLMENT_CENTS = 2000;

export interface Installment {
  number: number;
  dueDate: IsoDate;
  amountCents: Cents;
}

export interface PlanOption {
  months: PlanMonths;
  firstCents: Cents;
  regularCents: Cents;
  eligible: boolean;
}

function assertMonths(months: number): asserts months is PlanMonths {
  if (!PLAN_MONTHS.includes(months as PlanMonths)) {
    throw new RangeError(`payment plans are 3 or 6 months, got ${months}`);
  }
}

export function planOption(totalCents: Cents, months: PlanMonths): PlanOption {
  assertCents(totalCents, 'plan total');
  assertMonths(months);
  const regularCents = Math.floor(totalCents / months);
  const firstCents = totalCents - regularCents * (months - 1);
  return { months, firstCents, regularCents, eligible: regularCents >= MIN_INSTALLMENT_CENTS };
}

export function buildPaymentPlan(
  totalCents: Cents,
  months: PlanMonths,
  startDate: IsoDate,
): Installment[] {
  assertCents(totalCents, 'plan total');
  assertMonths(months);
  if (totalCents < months) {
    throw new RangeError(
      `a ${months}-month plan needs at least ${months} cents, got ${totalCents}`,
    );
  }
  const { firstCents, regularCents } = planOption(totalCents, months);
  return Array.from({ length: months }, (_, i) => ({
    number: i + 1,
    dueDate: addMonths(startDate, i),
    amountCents: i === 0 ? firstCents : regularCents,
  }));
}
