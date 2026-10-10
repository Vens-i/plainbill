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
  invoice: {
    status: string;
    sentOn: IsoDate | null;
    openCount: number;
    /** For staff: the patient's /pay/:token link (relative to the web app). */
    payPath: string | null;
    sentVia: 'paypal' | 'local' | null;
    paypalInvoiceNumber: string | null;
    paypalStatus: string | null;
  } | null;
  /** A PayPal payment plan in progress or finished. */
  activePlan: { months: number; paidCount: number; status: string } | null;
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

// ── Intake ──────────────────────────────────────────────────────────────────

export type IntakeKind = '835' | 'eob' | 'self-pay-csv';

/** A field the AI was unsure about, with every reading checked against the claim's math. */
export interface IntakeFlagView {
  path: string;
  kind: 'money' | 'code' | 'date' | 'text';
  label: string;
  column: 'insurancePaid' | 'adjustments' | 'billed' | 'patient' | 'visit' | 'payer' | 'other';
  current: { value: string; display: string; reconciles: boolean };
  alternatives: Array<{ value: string; display: string; reconciles: boolean }>;
  confidence: number;
  note: string | null;
  problem?: string;
}

export interface IntakeItemView {
  id: number;
  fileId: number;
  fileName: string;
  kind: IntakeKind;
  /** "835 · bcbs_era_1008", "EOB · aetna_eob_raman", "Self-pay · selfpay_0929" */
  sourceLabel: string;
  claimId: string;
  patientName: string;
  visitDate: string | null;
  payerName: string;
  billedCents: number | null;
  /** Null for self-pay. */
  insurancePaidCents: number | null;
  owesCents: number | null;
  /** "Insurance discount · Deductible · Coinsurance" */
  adjustmentsSummary: string;
  flags: IntakeFlagView[];
  resolved: Array<{ path: string; label: string; from: string; to: string }>;
  reconciles: boolean;
  error: string | null;
  status: 'pending' | 'approved' | 'duplicate' | 'discarded';
  balanceId: number | null;
}

export interface IntakeFileView {
  id: number;
  fileName: string;
  kind: IntakeKind;
  status: 'parsed' | 'error';
  error: string | null;
  visitCount: number;
  reader: string | null;
}

export interface IntakeBatchView {
  id: number;
  status: 'open' | 'approved' | 'discarded';
  files: IntakeFileView[];
  items: IntakeItemView[];
  /** Open flags across pending items. */
  openFlagCount: number;
  /** Pending items that reconcile and can be approved. */
  approvableCount: number;
}

export interface IntakeApproveResult {
  approved: Array<{ itemId: number; balanceId: number; status: BalanceStatus }>;
  skipped: Array<{ itemId: number; reason: string }>;
  batch: IntakeBatchView;
}

// ── Review & Send drawer ────────────────────────────────────────────────────

export type PaymentOption =
  { type: 'full' } | { type: 'partial'; minimumCents: number } | { type: 'plan'; months: 3 | 6 };

export type MessageVariant = 'default' | 'simpler' | 'spanish';

export interface DrawerData {
  balance: BalanceRow;
  /** Open AI flags still blocking a review row (from Intake), with resolutions so far. */
  review: {
    flags: IntakeFlagView[];
    resolved: Array<{ path: string; label: string; from: string; to: string }>;
    reason: string | null;
    canMarkReady: boolean;
  } | null;
  draft: {
    message: string;
    messageSource: 'ai' | 'template' | 'edited';
    variant: MessageVariant;
    paymentOption: PaymentOption;
    saved: boolean;
  };
  /** "Written from the 835 remittance." */
  messageProvenance: string;
  plans: Array<{ months: 3 | 6; firstCents: number; regularCents: number; eligible: boolean }>;
  partialMinimumCents: number;
  email: { to: string; subject: string; dueDate: string };
  ai: { available: boolean; model: string | null };
}

export interface DraftMessageResult {
  text: string;
  variant: MessageVariant;
  source: 'ai' | 'template';
  notes: string[];
}

export interface SendResult {
  balance: BalanceRow;
  invoiceId: number;
  /** The patient's link (absolute, APP_BASE_URL). */
  payUrl: string;
  /** Null when PayPal isn't configured (the invoice is local only). */
  paypal: { invoiceId: string; number: string | null; payerUrl: string } | null;
  email: {
    id: number;
    status: 'sent' | 'outbox' | 'failed';
    provider: 'resend' | 'outbox';
    deliveredTo: string | null;
    error: string | null;
  };
}

/** Staff email preview (/email-preview/:balanceId). */
export interface EmailPreview {
  /** "sent" emails come from the outbox log; "draft" is rendered from the saved draft. */
  kind: 'sent' | 'draft';
  subject: string;
  html: string;
  to: string;
  status: 'sent' | 'outbox' | 'failed' | 'draft';
  provider: 'resend' | 'outbox' | null;
  error: string | null;
  createdAt: string | null;
  patientName: string;
  payPath: string | null;
  paypalPayerUrl: string | null;
}

// ── Patient pay page ────────────────────────────────────────────────────────

export interface PayLinkInfo {
  practice: { name: string; phone: string; hours: string | null };
  /** True when this browser already has a session for this bill. */
  verified: boolean;
}

export interface WaterfallStep {
  key: 'billed' | 'discount' | 'insurance' | 'paid' | 'owes';
  label: string;
  /** Negative for amounts taken off the bill. */
  amountCents: number;
  title: string;
  body: string;
}

export interface PatientBill {
  practice: { name: string; phone: string; hours: string | null; address: string };
  firstName: string;
  status: BalanceStatus;
  visit: { date: IsoDate; provider: string | null };
  dueDate: IsoDate;
  selfPay: boolean;
  payerShortName: string;
  amounts: {
    billedCents: number;
    discountCents: number;
    allowedCents: number;
    insurancePaidCents: number | null;
    patientShareCents: number;
    paidCents: number;
    remainingCents: number;
  };
  waterfall: WaterfallStep[];
  /** Plain-language service names (never codes). */
  services: Array<{ name: string; chargeCents: number }>;
  terms: Array<{ term: string; body: string }>;
  options: {
    /** Set when staff allowed partial payments. */
    partialMinimumCents: number | null;
    /** Set when staff offered a plan and none is active yet. */
    plans: Array<{ months: 3 | 6; firstCents: number; regularCents: number; selected: boolean }>;
  };
  payments: Array<{
    id: number;
    amountCents: number;
    paidAt: string;
    via: string;
    confirmation: string;
    planId: number | null;
  }>;
  plan: {
    id: number;
    months: 3 | 6;
    status: string;
    totalCents: number;
    paidCount: number;
    schedule: Array<{ number: number; dueDate: IsoDate; amountCents: number; paid: boolean }>;
  } | null;
  paypal: { enabled: boolean; clientId: string | null; env: 'sandbox' | 'live' };
}

/** After a capture or plan approval: the refreshed bill and the payment to confirm. */
export interface PayResult {
  bill: PatientBill;
  paymentId: number | null;
  /** PayPal accepted it but hasn't settled it yet (it lands via sync/webhook). */
  pending: boolean;
}
