/**
 * The only facts a patient message may draw on. Built from @plainbill/core's computed balance.
 * Deliberately minimal (CLAUDE.md): first name, provider, visit date and amounts — no service
 * descriptions, procedure or diagnosis codes, or insurance IDs, so the model cannot leak them.
 */
export type MessageVariant = 'default' | 'simpler' | 'spanish';

export interface MessageFacts {
  patientFirstName: string;
  practiceName: string;
  /** "Dr. Patel" */
  providerName: string | null;
  /** ISO date of the visit. */
  visitDate: string;
  /** Short payer name ("BlueCross"); null for self-pay. */
  payerShortName: string | null;
  selfPay: boolean;
  billedCents: number;
  /** Contract discount (insurance) or self-pay discount. */
  discountCents: number;
  insurancePaidCents: number;
  owesCents: number;
  deductibleCents: number;
  coinsuranceCents: number;
  copayCents: number;
  otherPatientCents: number;
  /** Interest-free plan on offer, if any. */
  plan: { months: number; firstCents: number; regularCents: number } | null;
  /** Minimum partial payment, if partial payments are allowed. */
  partialMinimumCents: number | null;
  /** ISO due date, if known. */
  dueDate: string | null;
}

/** Every dollar amount a message is allowed to mention. */
export function allowedAmounts(f: MessageFacts): Set<number> {
  const amounts = [
    f.billedCents,
    f.discountCents,
    f.billedCents - f.discountCents, // the plan's allowed amount ("lowered that to $450")
    f.insurancePaidCents,
    f.owesCents,
    f.deductibleCents,
    f.coinsuranceCents,
    f.copayCents,
    f.otherPatientCents,
    f.plan?.firstCents,
    f.plan?.regularCents,
    f.partialMinimumCents,
  ];
  return new Set(amounts.filter((a): a is number => typeof a === 'number' && a > 0));
}
