/**
 * Response shapes shared with apps/web (imported as types only). Money is integer cents.
 */
import type {
  AgingBucket,
  BalanceStatus,
  IsoDate,
  PatientShare,
  SplitVisit,
  SplitVisitShare,
  PlanOption,
  StatementLayout,
} from '@plainbill/core';

export type { Anchor, AnchorKind, Op, Rect, StatementLayout } from '@plainbill/core';

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
  patientId: number;
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
  /** What the ✦ button does for this suggestion (send_invoice, send_reminder, offer_plan…). */
  aiAction: string | null;
  /** "claude" or "rules" after a refresh; null for seeded/intake suggestions. */
  aiSuggestionBy: string | null;
  reviewReason: string | null;
  denialReason: string | null;
  lines: BalanceLine[];
  adjustments: DisplayAdjustment[];
  patientShare: PatientShare;
  /**
   * A covered checkup with a problem visit billed separately (modifier 25), detected by
   * @plainbill/core from the adjudicated lines; the indexes point into `lines`.
   */
  splitVisit: (SplitVisit & { preventiveIndex: number; problemIndex: number }) | null;
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
    /** The patient's latest look at the itemized statement, and the notes' language. */
    statementView: { at: string; lang: string; language: string } | null;
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

export interface ReminderResult {
  email: SendResult['email'];
  payUrl: string;
  /** Set when the reminder offered a payment plan. */
  planMonths: 3 | 6 | null;
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
  /** "D", for "Secure bill for Maria D." */
  lastInitial: string;
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
  /** How the patient's share breaks down (deductible, coinsurance, copay…). */
  patientShare: PatientShare;
  waterfall: WaterfallStep[];
  /** Plain-language service names (never codes). */
  services: Array<{ name: string; chargeCents: number }>;
  /** A covered checkup with a problem visit billed separately; the amounts are that visit's. */
  splitVisit: {
    checkupChargeCents: number;
    visitChargeCents: number;
    share: SplitVisitShare;
  } | null;
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

// ── Itemized statement, explained ───────────────────────────────────────────

/** The practice's statement as drawing ops + anchors (PDF points, top-left origin). */
export interface PatientStatement {
  layout: StatementLayout;
  /** "S0000014" */
  statementId: string;
  /** The same statement as a PDF (behind the same session cookie). */
  pdfPath: string;
}

/** One margin note. `n` and `quote` come from code; the model only writes title and body. */
export interface StatementNote {
  anchorId: string;
  /** 1…k, the badge number. */
  n: number;
  title: string;
  body: string;
  /** The printed line, for the "On your bill:" chip. */
  quote: string;
}

export interface StatementNotes {
  lang: string;
  notes: StatementNote[];
  /** "mixed": some notes fell back to the template. */
  source: 'ai' | 'template' | 'mixed';
  /** True when this language wasn't available and the notes are in English. */
  fallback: boolean;
}

// ── Patient bill helper ─────────────────────────────────────────────────────

export type AssistantActionKind = 'pay_in_full' | 'payment_plan' | 'partial_payment' | 'phone_call';

/** A card under a helper answer. Amounts come from code; Confirm runs only what's stored. */
export interface AssistantCard {
  id: string | null;
  kind: AssistantActionKind;
  title: string;
  detail: string[];
  amountCents: number | null;
  confirmLabel: string | null;
}

export interface AssistantAnswer {
  text: string;
  /** "Based on BlueCross's statement for your Oct 3 visit" */
  source: string;
  cards: AssistantCard[];
  /** "claude" or "rules" (offline, or when the model's answer failed the checks). */
  via: 'claude' | 'rules';
}

/** After Confirm: the PayPal order or subscription to approve with PayPal's button. */
export interface AssistantConfirmResult {
  kind: 'pay_in_full' | 'payment_plan' | 'partial_payment';
  amountCents: number;
  orderId: string | null;
  subscriptionId: string | null;
}

/** After a capture or plan approval: the refreshed bill and the payment to confirm. */
export interface PayResult {
  bill: PatientBill;
  paymentId: number | null;
  /** PayPal accepted it but hasn't settled it yet (it lands via sync/webhook). */
  pending: boolean;
}

/** GET /api/insights/data: the AG Studio report's sources. Dollars, no patient names. */
/**
 * How patients appear in Practice insights (whose data goes to the AI analyst): "Aisha Bello",
 * "Aisha B.", or "Patient 7" with no name at all.
 */
export type PatientNamesMode = 'full' | 'initials' | 'off';

export interface InsightsData {
  today: IsoDate;
  patientNames: PatientNamesMode;
  balances: Array<{
    balanceId: number;
    patientId: number;
    patient: string;
    status: string;
    payer: string;
    provider: string;
    visitDate: IsoDate;
    billed: number;
    insuranceDiscount: number;
    insurancePaid: number;
    patientShare: number;
    patientPaid: number;
    stillOwed: number;
    daysOut: number;
    aging: string;
    invoiceOpened: boolean;
    onPlan: boolean;
    splitVisit: boolean;
  }>;
  payments: Array<{
    paymentId: number;
    balanceId: number;
    patientId: number;
    patient: string;
    paidOn: IsoDate;
    amount: number;
    method: string;
    payer: string;
  }>;
  adjustments: Array<{
    balanceId: number;
    payer: string;
    date: IsoDate;
    code: string;
    reason: string;
    whoPays: 'Patient' | 'Written off';
    amount: number;
    denied: boolean;
  }>;
}
