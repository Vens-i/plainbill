/**
 * SQLite schema (Drizzle). Money columns are integer cents; calendar dates are ISO text
 * ("2026-10-03"); timestamps are ISO-8601 UTC text. JSON columns hold small string arrays.
 */
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
    paypalInvoiceId: text('paypal_invoice_id'),
    createdAt: createdAt(),
  },
  (t) => [index('invoices_balance_idx').on(t.balanceId)],
);

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
    source: text('source', { enum: ['seed', 'simulated', 'paypal-webhook', 'manual'] }).notNull(),
    externalId: text('external_id'),
    /** Calendar date the payment counts toward (demo-aware). */
    postedOn: text('posted_on').notNull(),
    /** Wall-clock time it arrived, for "just now". */
    receivedAt: text('received_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('payments_balance_idx').on(t.balanceId)],
);

export const events = sqliteTable('events', {
  id: integer('id').primaryKey(),
  type: text('type').notNull(),
  balanceId: integer('balance_id').references(() => balances.id),
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  createdAt: createdAt(),
});
