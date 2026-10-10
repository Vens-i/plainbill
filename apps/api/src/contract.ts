/**
 * Response shapes shared with apps/web (imported as types only). Money is integer cents.
 */
import type {
  AgingBucket,
  BalanceStatus,
  IsoDate,
  PatientShare,
  PlanOption,
} from '@plainbill/core';

export interface BalanceLine {
  code: string;
  description: string;
  chargeCents: number;
}

/** One row of the adjustments panel: "CO-45 → Insurance discount (contract rate) −$400.00". */
export interface DisplayAdjustment {
  /** "CO-45", "PAID", "M62", "SELF". */
  code: string;
  label: string;
  /** Signed: write-offs and insurance payments are negative, patient share positive. */
  amountCents: number | null;
  kind: 'writeoff' | 'payment' | 'patient' | 'remark' | 'self-pay';
}

export interface BalanceRow {
  id: number;
  status: BalanceStatus;
  patientName: string;
  patientFirstName: string;
  /** "Dr. Patel" */
  provider: string | null;
  /** "Dr. Anand Patel" */
  providerFullName: string | null;
  /** Second line under the patient's name, depends on status. */
  sub: string;
  visitDate: IsoDate;
  payerId: string;
  payerName: string;
  payerShortName: string;
  payerKind: 'insurance' | 'self-pay';
  claimId: string;
  sourceKind: '835' | 'self-pay-csv' | 'eob';
  sourceFile: string | null;
  billedCents: number;
  /** Null for self-pay ("—"). */
  insurancePaidCents: number | null;
  contractualCents: number;
  patientResponsibilityCents: number;
  patientPaidCents: number;
  remainingCents: number;
  /** "Patient owes" column: remaining; the full patient share once paid; null when denied ("—"). */
  owesCents: number | null;
  /** Days since the visit; null once paid. */
  daysOut: number | null;
  agingBucket: AgingBucket | null;
  /** Visit → final payment, for paid rows. */
  paidInDays: number | null;
  /** Calendar date the balance was settled (demo-aware). */
  paidOn: IsoDate | null;
  /** Wall-clock time of the final payment (for "just now"). */
  paidAt: string | null;
  paidVia: string | null;
  aiSuggestion: string | null;
  reviewReason: string | null;
  denialReason: string | null;
  lines: BalanceLine[];
  adjustments: DisplayAdjustment[];
  patientShare: PatientShare;
  /** The 3-month plan option ("Plan-eligible: 3 × $80"), when there is something to pay. */
  plan: PlanOption | null;
  invoice: { status: string; sentOn: IsoDate | null; openCount: number } | null;
}

export interface PracticeInfo {
  name: string;
  phone: string;
  address: string;
  user: { name: string; firstName: string; initials: string };
  today: IsoDate;
}

export interface Kpis {
  today: IsoDate;
  outstanding: { cents: number; patients: number };
  collectedThisMonth: {
    cents: number;
    previousCents: number;
    month: string;
    previousMonth: string;
  };
  avgDaysToPay: { days: number | null; paidCount: number; paperBaselineDays: number | null };
  review: {
    count: number;
    cents: number;
    firstPatientName: string | null;
    firstBalanceId: number | null;
  };
  ready: { count: number; cents: number };
  /** Rough time to clear today's to-dos (1 min per review, 30 s per bill to send). */
  todoMinutes: number;
}

export interface AgingChart {
  totalCents: number;
  buckets: Array<{ bucket: AgingBucket; label: string; cents: number; count: number }>;
}

export interface DenialsChart {
  windowDays: number;
  total: number;
  payers: Array<{ payerId: string; payer: string; shortName: string; count: number }>;
  mostCommon: { code: string; label: string; count: number } | null;
}

export interface IntakeResult {
  fileName: string;
  created: Array<{
    balanceId: number;
    claimId: string;
    patientName: string;
    status: BalanceStatus;
    owesCents: number;
  }>;
  skipped: Array<{ claimId: string; reason: 'duplicate' }>;
}

export interface PaymentEvent {
  balance: BalanceRow;
  payment: { id: number; amountCents: number; method: string; source: string; receivedAt: string };
}

export interface BalancesChangedEvent {
  ids: number[];
}

export type ServerEvent =
  | { type: 'payment'; data: PaymentEvent }
  | { type: 'balances.changed'; data: BalancesChangedEvent };
