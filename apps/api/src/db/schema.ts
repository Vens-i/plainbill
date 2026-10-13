/**
 * SQLite schema (Drizzle). Money columns are integer cents; calendar dates are ISO text
 * ("2026-10-03"); timestamps are ISO-8601 UTC text. JSON columns hold small string arrays.
 */
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { EobExtraction } from '@plainbill/ai';
import type { NormalizedClaim } from '@plainbill/core';

const createdAt = () =>
  text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);

export const practices = sqliteTable('practices', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  addressLine1: text('address_line1').notNull(),
  addressLine2: text('address_line2'),
  city: text('city').notNull(),
  state: text('state').notNull(),
  zip: text('zip').notNull(),
  phone: text('phone').notNull(),
  /** Phone hours shown in patient emails ("Mon–Fri 8–5"). */
  hours: text('hours'),
  npi: text('npi'),
  /** Average days-to-pay on paper statements, for the KPI comparison. */
  paperBaselineDays: integer('paper_baseline_days'),
  /** Phase 1 has a single front-desk user; auth arrives later. */
  staffName: text('staff_name').notNull(),
  staffFirstName: text('staff_first_name').notNull(),
  staffInitials: text('staff_initials').notNull(),
  createdAt: createdAt(),
});

export const patients = sqliteTable(
  'patients',
  {
    id: integer('id').primaryKey(),
    practiceId: integer('practice_id')
      .notNull()
      .references(() => practices.id),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    dob: text('dob'),
    email: text('email'),
    memberId: text('member_id'),
    /** Mailing address, printed in the statement's window. */
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    state: text('state'),
    zip: text('zip'),
    createdAt: createdAt(),
  },
  (t) => [index('patients_name_idx').on(t.practiceId, t.lastName, t.firstName)],
);

export const visits = sqliteTable(
  'visits',
  {
    id: integer('id').primaryKey(),
    practiceId: integer('practice_id')
      .notNull()
      .references(() => practices.id),
    patientId: integer('patient_id')
      .notNull()
      .references(() => patients.id),
    serviceDate: text('service_date').notNull(),
    providerFirstName: text('provider_first_name'),
    providerLastName: text('provider_last_name'),
    providerNpi: text('provider_npi'),
    payerId: text('payer_id').notNull(),
    payerName: text('payer_name').notNull(),
    payerShortName: text('payer_short_name').notNull(),
    payerKind: text('payer_kind', { enum: ['insurance', 'self-pay'] }).notNull(),
    sourceKind: text('source_kind', { enum: ['835', 'self-pay-csv', 'eob'] }).notNull(),
    sourceFile: text('source_file'),
    /** CLP01 / visit id: the practice's own claim number. */
    claimId: text('claim_id').notNull(),
    payerClaimNumber: text('payer_claim_number'),
    claimStatusCode: text('claim_status_code').notNull(),
    denied: integer('denied', { mode: 'boolean' }).notNull(),
    remarks: text('remarks', { mode: 'json' }).$type<string[]>().notNull(),
    traceNumber: text('trace_number'),
    paymentDate: text('payment_date'),
    receivedDate: text('received_date'),
    billedCents: integer('billed_cents').notNull(),
    insurancePaidCents: integer('insurance_paid_cents').notNull(),
    reportedPatientResponsibilityCents: integer('reported_patient_responsibility_cents').notNull(),
    selfPayRateApplied: integer('self_pay_rate_applied', { mode: 'boolean' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('visits_claim_unique').on(t.practiceId, t.payerId, t.claimId)],
);

export const claimLines = sqliteTable(
  'claim_lines',
  {
    id: integer('id').primaryKey(),
    visitId: integer('visit_id')
      .notNull()
      .references(() => visits.id),
    lineNumber: integer('line_number').notNull(),
    codeQualifier: text('code_qualifier').notNull(),
    procedureCode: text('procedure_code').notNull(),
    modifiers: text('modifiers', { mode: 'json' }).$type<string[]>().notNull(),
    chargeCents: integer('charge_cents').notNull(),
    paidCents: integer('paid_cents').notNull(),
    allowedCents: integer('allowed_cents'),
    units: integer('units'),
    serviceDate: text('service_date'),
    remarks: text('remarks', { mode: 'json' }).$type<string[]>().notNull(),
  },
  (t) => [index('claim_lines_visit_idx').on(t.visitId)],
);

export const adjustments = sqliteTable(
  'adjustments',
  {
    id: integer('id').primaryKey(),
    visitId: integer('visit_id')
      .notNull()
      .references(() => visits.id),
    /** Null for claim-level CAS. */
    claimLineId: integer('claim_line_id').references(() => claimLines.id),
    groupCode: text('group_code', { enum: ['CO', 'PR', 'OA', 'PI', 'CR'] }).notNull(),
    reasonCode: text('reason_code').notNull(),
    amountCents: integer('amount_cents').notNull(),
    quantity: integer('quantity'),
  },
  (t) => [index('adjustments_visit_idx').on(t.visitId)],
);

export const balanceStatuses = ['review', 'ready', 'sent', 'partial', 'paid', 'denied'] as const;

export const balances = sqliteTable(
  'balances',
  {
    id: integer('id').primaryKey(),
    visitId: integer('visit_id')
      .notNull()
      .references(() => visits.id),
    status: text('status', { enum: balanceStatuses }).notNull(),
    billedCents: integer('billed_cents').notNull(),
    contractualCents: integer('contractual_cents').notNull(),
    insurancePaidCents: integer('insurance_paid_cents').notNull(),
    patientResponsibilityCents: integer('patient_responsibility_cents').notNull(),
    deductibleCents: integer('deductible_cents').notNull(),
    coinsuranceCents: integer('coinsurance_cents').notNull(),
    copayCents: integer('copay_cents').notNull(),
    otherPatientCents: integer('other_patient_cents').notNull(),
    selfPayCents: integer('self_pay_cents').notNull(),
    patientPaidCents: integer('patient_paid_cents').notNull().default(0),
    reviewReason: text('review_reason'),
    aiSuggestion: text('ai_suggestion'),
    /** What the suggestion's one-click button does (see @plainbill/ai SUGGESTION_ACTIONS). */
    aiAction: text('ai_action'),
    /** "claude" or "rules"; null for suggestions set by the seed or intake. */
    aiSuggestionBy: text('ai_suggestion_by'),
    /** Calendar date (demo-aware) the balance was settled. */
    paidOn: text('paid_on'),
    createdAt: createdAt(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('balances_visit_unique').on(t.visitId),
    index('balances_status_idx').on(t.status),
  ],
);

export const invoices = sqliteTable(
  'invoices',
  {
    id: integer('id').primaryKey(),
    balanceId: integer('balance_id')
      .notNull()
      .references(() => balances.id),
    status: text('status', { enum: ['draft', 'sent', 'paid', 'void'] }).notNull(),
    amountCents: integer('amount_cents').notNull(),
    sentOn: text('sent_on'),
    dueDate: text('due_date'),
    openCount: integer('open_count').notNull().default(0),
    lastOpenedAt: text('last_opened_at'),
    /** "INV2-…" once the PayPal draft exists (kept so a retried send never makes a second one). */
    paypalInvoiceId: text('paypal_invoice_id'),
    /** PayPal's auto-incremented invoice number ("0007"). */
    paypalInvoiceNumber: text('paypal_invoice_number'),
    /** Last status PayPal reported (UNPAID, PARTIALLY_PAID, PAID, MARKED_AS_PAID…). */
    paypalStatus: text('paypal_status'),
    /** PayPal's payer-view link: what the email's PayPal button opens. */
    paypalPayerUrl: text('paypal_payer_url'),
    /** "paypal" when PayPal accepted the invoice; "local" when PayPal isn't configured. */
    sentVia: text('sent_via', { enum: ['paypal', 'local'] }),
    /** Unguessable token in the patient's /pay/:token link. */
    payToken: text('pay_token'),
    /** Wrong last-name/DOB attempts since the last success, and the lockout they trigger. */
    verifyFailures: integer('verify_failures').notNull().default(0),
    verifyLockedUntil: text('verify_locked_until'),
    /** The plain-language message staff approved (AI draft or template, possibly edited). */
    message: text('message'),
    messageSource: text('message_source', { enum: ['ai', 'template', 'edited'] }),
    paymentOption: text('payment_option', { mode: 'json' }).$type<PaymentOptionJson>(),
    createdAt: createdAt(),
  },
  (t) => [
    index('invoices_balance_idx').on(t.balanceId),
    uniqueIndex('invoices_pay_token_unique').on(t.payToken),
    uniqueIndex('invoices_paypal_invoice_unique').on(t.paypalInvoiceId),
  ],
);

export type PaymentOptionJson =
  { type: 'full' } | { type: 'partial'; minimumCents: number } | { type: 'plan'; months: 3 | 6 };

/** Where a payment came from. The paypal-* sources are real (sandbox or live) money movements. */
export const paymentSources = [
  'seed',
  'simulated',
  'manual',
  'paypal-checkout',
  'paypal-invoice',
  'paypal-plan',
] as const;
export type PaymentSource = (typeof paymentSources)[number];

export const payments = sqliteTable(
  'payments',
  {
    id: integer('id').primaryKey(),
    balanceId: integer('balance_id')
      .notNull()
      .references(() => balances.id),
    invoiceId: integer('invoice_id').references(() => invoices.id),
    amountCents: integer('amount_cents').notNull(),
    method: text('method', { enum: ['paypal', 'card', 'cash'] }).notNull(),
    source: text('source', { enum: paymentSources }).notNull(),
    /**
     * PayPal's id for the money movement (order capture, invoice transaction, subscription
     * sale). Unique, so a webhook, a capture response and a reconciliation poll that all report
     * the same payment record it once.
     */
    externalId: text('external_id'),
    /** The copy we recorded on the PayPal invoice ("EXTR-…"), so the poll doesn't count it twice. */
    paypalInvoiceTxnId: text('paypal_invoice_txn_id'),
    planId: integer('plan_id').references(() => paymentPlans.id),
    /** Calendar date the payment counts toward (demo-aware). */
    postedOn: text('posted_on').notNull(),
    /** Wall-clock time it arrived, for "just now". */
    receivedAt: text('received_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('payments_balance_idx').on(t.balanceId),
    uniqueIndex('payments_external_unique').on(t.externalId),
    uniqueIndex('payments_invoice_txn_unique').on(t.paypalInvoiceTxnId),
  ],
);

// ── PayPal: orders from the patient page, payment plans, webhooks ───────────

export const paypalOrders = sqliteTable(
  'paypal_orders',
  {
    /** PayPal's order id. */
    id: text('id').primaryKey(),
    invoiceId: integer('invoice_id')
      .notNull()
      .references(() => invoices.id),
    /** What we asked PayPal to collect, computed server-side from the balance. */
    amountCents: integer('amount_cents').notNull(),
    status: text('status', { enum: ['created', 'captured', 'failed'] }).notNull(),
    captureId: text('capture_id'),
    createdAt: createdAt(),
    capturedAt: text('captured_at'),
  },
  (t) => [index('paypal_orders_invoice_idx').on(t.invoiceId)],
);

export const paymentPlans = sqliteTable(
  'payment_plans',
  {
    id: integer('id').primaryKey(),
    invoiceId: integer('invoice_id')
      .notNull()
      .references(() => invoices.id),
    balanceId: integer('balance_id')
      .notNull()
      .references(() => balances.id),
    months: integer('months').notNull(),
    firstCents: integer('first_cents').notNull(),
    regularCents: integer('regular_cents').notNull(),
    paypalPlanId: text('paypal_plan_id'),
    paypalSubscriptionId: text('paypal_subscription_id'),
    /** pending: created, waiting for the patient's approval in PayPal. */
    status: text('status', { enum: ['pending', 'active', 'completed', 'cancelled'] }).notNull(),
    startedOn: text('started_on'),
    createdAt: createdAt(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('payment_plans_invoice_idx').on(t.invoiceId),
    uniqueIndex('payment_plans_subscription_unique').on(t.paypalSubscriptionId),
  ],
);

/** Every webhook delivery we accepted, so a redelivered event is handled once. */
export const webhookEvents = sqliteTable('webhook_events', {
  /** PayPal's event id ("WH-…"). */
  id: text('id').primaryKey(),
  eventType: text('event_type').notNull(),
  resourceId: text('resource_id'),
  status: text('status', { enum: ['processed', 'ignored', 'failed'] }).notNull(),
  detail: text('detail'),
  receivedAt: text('received_at').notNull(),
});

/** Bill emails as rendered and sent (or kept in the outbox when no email provider is set). */
export const emails = sqliteTable(
  'emails',
  {
    id: integer('id').primaryKey(),
    invoiceId: integer('invoice_id')
      .notNull()
      .references(() => invoices.id),
    /** The patient's address on file. */
    intendedTo: text('intended_to'),
    /** Where it actually went (EMAIL_TO_OVERRIDE in demos); null when kept in the outbox. */
    deliveredTo: text('delivered_to'),
    subject: text('subject').notNull(),
    html: text('html').notNull(),
    text: text('text').notNull(),
    provider: text('provider', { enum: ['resend', 'outbox'] }).notNull(),
    providerMessageId: text('provider_message_id'),
    status: text('status', { enum: ['sent', 'outbox', 'failed'] }).notNull(),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [index('emails_invoice_idx').on(t.invoiceId)],
);

/** Small key/value store: cached PayPal catalog product and plan ids. */
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const events = sqliteTable('events', {
  id: integer('id').primaryKey(),
  type: text('type').notNull(),
  balanceId: integer('balance_id').references(() => balances.id),
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  createdAt: createdAt(),
});

// ── Intake staging: uploaded files wait here until staff approve them ────────

export const intakeBatches = sqliteTable('intake_batches', {
  id: integer('id').primaryKey(),
  practiceId: integer('practice_id')
    .notNull()
    .references(() => practices.id),
  status: text('status', { enum: ['open', 'approved', 'discarded'] }).notNull(),
  createdAt: createdAt(),
  closedAt: text('closed_at'),
});

export const intakeFiles = sqliteTable(
  'intake_files',
  {
    id: integer('id').primaryKey(),
    batchId: integer('batch_id')
      .notNull()
      .references(() => intakeBatches.id),
    fileName: text('file_name').notNull(),
    kind: text('kind', { enum: ['835', 'eob', 'self-pay-csv'] }).notNull(),
    sha256: text('sha256').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    status: text('status', { enum: ['parsed', 'error'] }).notNull(),
    error: text('error'),
    /** Which EOB reader produced the extraction ("claude", "recorded"); null for 835/CSV. */
    reader: text('reader'),
    createdAt: createdAt(),
  },
  (t) => [index('intake_files_batch_idx').on(t.batchId)],
);

export const intakeItems = sqliteTable(
  'intake_items',
  {
    id: integer('id').primaryKey(),
    batchId: integer('batch_id')
      .notNull()
      .references(() => intakeBatches.id),
    fileId: integer('file_id')
      .notNull()
      .references(() => intakeFiles.id),
    kind: text('kind', { enum: ['835', 'eob', 'self-pay-csv'] }).notNull(),
    /** Parsed claim for 835/CSV items. EOB items rebuild their claim from `extraction`. */
    claim: text('claim', { mode: 'json' }).$type<NormalizedClaim>(),
    /** Single-claim EOB extraction (paths are "claims.0.…"), updated as staff resolve flags. */
    extraction: text('extraction', { mode: 'json' }).$type<EobExtraction>(),
    resolutions: text('resolutions', { mode: 'json' }).$type<IntakeResolution[]>().notNull(),
    status: text('status', { enum: ['pending', 'approved', 'duplicate', 'discarded'] }).notNull(),
    balanceId: integer('balance_id').references(() => balances.id),
    createdAt: createdAt(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('intake_items_batch_idx').on(t.batchId),
    index('intake_items_balance_idx').on(t.balanceId),
  ],
);

export interface IntakeResolution {
  path: string;
  label: string;
  from: string;
  to: string;
  at: string;
}

/**
 * Payment actions the bill helper proposed. The amounts were computed by code when the card was
 * shown; "Confirm" can only run an action stored here, for the same bill, recently.
 */
export const assistantActions = sqliteTable(
  'assistant_actions',
  {
    /** Random id the card carries. */
    id: text('id').primaryKey(),
    invoiceId: integer('invoice_id')
      .notNull()
      .references(() => invoices.id),
    kind: text('kind', { enum: ['pay_in_full', 'payment_plan', 'partial_payment'] }).notNull(),
    months: integer('months'),
    amountCents: integer('amount_cents').notNull(),
    /** The balance's remaining amount when proposed; a changed balance voids the card. */
    remainingCents: integer('remaining_cents').notNull(),
    status: text('status', { enum: ['proposed', 'confirmed'] }).notNull(),
    paypalOrderId: text('paypal_order_id'),
    paypalSubscriptionId: text('paypal_subscription_id'),
    createdAt: text('created_at').notNull(),
    confirmedAt: text('confirmed_at'),
  },
  (t) => [index('assistant_actions_invoice_idx').on(t.invoiceId)],
);
