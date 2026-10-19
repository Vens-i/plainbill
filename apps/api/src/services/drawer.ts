/**
 * Review & Send drawer: drafts and review-flag resolution. The send itself is in send.ts.
 *
 * Every amount here comes from the computed balance. The AI only drafts wording, and a message
 * can't be sent if it mentions a figure the core didn't produce.
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import {
  checkMessage,
  eobToClaims,
  messageTemplate,
  reviewSummary,
  withFieldValue,
  type MessageDrafter,
  type MessageFacts,
} from '@plainbill/ai';
import {
  addDays,
  formatMoney,
  formatMonthDay,
  nextStatus,
  noteLanguage,
  PLAN_MONTHS,
  planOption,
  type IsoDate,
} from '@plainbill/core';
import type { BalanceRow, DrawerData, MessageVariant, PaymentOption } from '../contract';
import type { Db } from '../db/client';
import { balances, events, intakeItems, invoices, patients, practices, visits } from '../db/schema';
import { getBalanceRows } from '../queries/rows';
import { replaceVisitClaim } from './ingest';
import { IntakeError, itemForBalance, resolveFlag } from './intake';

export const PARTIAL_MINIMUM_CENTS = 2000;

export class DrawerError extends Error {
  override name = 'DrawerError';
  constructor(
    message: string,
    readonly status = 400,
    readonly details?: string[],
  ) {
    super(message);
  }
}

export function practiceName(db: Db): string {
  return db.select().from(practices).orderBy(asc(practices.id)).get()?.name ?? 'your provider';
}

export function balanceRow(db: Db, balanceId: number, today: IsoDate): BalanceRow {
  const [r] = getBalanceRows(db, today, [balanceId]);
  if (!r) throw new DrawerError('No such balance.', 404);
  return r;
}

/** Facts for one payment option (what the draft talks about). */
export function buildMessageFacts(
  r: BalanceRow,
  practice: string,
  option: PaymentOption,
  dueDate: IsoDate | null,
): MessageFacts {
  const plan = option.type === 'plan' ? planOption(r.remainingCents, option.months) : null;
  return {
    patientFirstName: r.patientFirstName,
    practiceName: practice,
    providerName: r.provider,
    visitDate: r.visitDate,
    payerShortName: r.payerKind === 'self-pay' ? null : r.payerShortName,
    selfPay: r.payerKind === 'self-pay',
    billedCents: r.billedCents,
    discountCents: r.contractualCents,
    insurancePaidCents: r.insurancePaidCents ?? 0,
    owesCents: r.remainingCents,
    deductibleCents: r.patientShare.deductibleCents,
    coinsuranceCents: r.patientShare.coinsuranceCents,
    copayCents: r.patientShare.copayCents,
    otherPatientCents: r.patientShare.otherCents,
    plan:
      plan && plan.eligible
        ? { months: plan.months, firstCents: plan.firstCents, regularCents: plan.regularCents }
        : null,
    partialMinimumCents: option.type === 'partial' ? option.minimumCents : null,
    dueDate,
  };
}

/** Facts covering every option staff could pick — what a message is checked against. */
function guardFacts(r: BalanceRow, practice: string): MessageFacts {
  const base = buildMessageFacts(
    r,
    practice,
    { type: 'partial', minimumCents: PARTIAL_MINIMUM_CENTS },
    null,
  );
  return {
    ...base,
    otherPlans: PLAN_MONTHS.map((m) => planOption(r.remainingCents, m)).filter((p) => p.eligible),
  };
}

function defaultOption(r: BalanceRow): PaymentOption {
  const wantsPlan = /plan/i.test(r.aiSuggestion ?? '');
  const months = /6-month/i.test(r.aiSuggestion ?? '') ? 6 : 3;
  return wantsPlan && planOption(r.remainingCents, months).eligible
    ? { type: 'plan', months }
    : { type: 'full' };
}

export function maskEmail(email: string | null): string {
  if (!email || !email.includes('@')) return 'no email on file';
  const [local, domain] = email.split('@');
  return `${local!.slice(0, 1)}•••••@${domain}`;
}

export function dueDateFor(r: BalanceRow, today: IsoDate): IsoDate {
  const thirtyAfterVisit = addDays(r.visitDate, 30);
  const twoWeeksOut = addDays(today, 14);
  return thirtyAfterVisit > twoWeeksOut ? thirtyAfterVisit : twoWeeksOut;
}

const PROVENANCE: Record<BalanceRow['sourceKind'], string> = {
  '835': 'Written from the 835 remittance. No diagnosis details are included.',
  eob: 'Written from the EOB. No diagnosis details are included.',
  'self-pay-csv': 'Written from the self-pay visit summary. No diagnosis details are included.',
};

function reviewInfo(db: Db, r: BalanceRow): DrawerData['review'] {
  if (r.status !== 'review') return null;
  const linked = itemForBalance(db, r.id);
  const flags = linked?.built.flags ?? [];
  const resolved = (linked?.item.resolutions ?? []).map(({ path, label, from, to }) => ({
    path,
    label,
    from,
    to,
  }));
  return {
    flags,
    resolved,
    reason: r.reviewReason,
    canMarkReady: flags.length === 0 && (linked ? linked.built.claim !== null : true),
  };
}

/**
 * The language the patient last chose (or read) on any of their statements, across all their
 * bills; null if they have never opened one.
 */
export function patientLanguage(db: Db, patientId: number): string | null {
  const latest = db
    .select({ payload: events.payload })
    .from(events)
    .innerJoin(balances, eq(events.balanceId, balances.id))
    .innerJoin(visits, eq(balances.visitId, visits.id))
    .where(
      and(
        eq(visits.patientId, patientId),
        inArray(events.type, ['statement.viewed', 'statement.language']),
      ),
    )
    .orderBy(desc(events.id))
    .get();
  return noteLanguage(String(latest?.payload.lang ?? ''))?.code ?? null;
}

export function getDrawerData(
  db: Db,
  balanceId: number,
  today: IsoDate,
  ai: { available: boolean; model: string | null },
): DrawerData {
  const r = balanceRow(db, balanceId, today);
  const practice = practiceName(db);
  const visit = db
    .select()
    .from(balances)
    .innerJoin(visits, eq(balances.visitId, visits.id))
    .where(eq(balances.id, balanceId))
    .get()!;
  const patient = db.select().from(patients).where(eq(patients.id, visit.visits.patientId)).get();
  const draft = db
    .select()
    .from(invoices)
    .where(and(eq(invoices.balanceId, balanceId), eq(invoices.status, 'draft')))
    .get();
  const dueDate = dueDateFor(r, today);
  const option = (draft?.paymentOption as PaymentOption | null) ?? defaultOption(r);
  const patientLang = patient ? patientLanguage(db, patient.id) : null;
  // A saved draft keeps its message and language. A new one starts in the patient's language:
  // the template when there is one in it, else English until the AI drafts it.
  const requestedLang = draft ? (draft.messageLang ?? 'en') : (patientLang ?? 'en');
  const template = draft?.message
    ? null
    : messageTemplate(buildMessageFacts(r, practice, option, dueDate), 'default', requestedLang);

  return {
    balance: r,
    review: reviewInfo(db, r),
    draft: {
      message: template ? template.text : draft!.message!,
      messageSource: draft?.messageSource ?? 'template',
      variant: 'default',
      lang: template?.lang ?? requestedLang,
      requestedLang,
      paymentOption: option,
      saved: Boolean(draft),
    },
    patientLang,
    messageProvenance: PROVENANCE[r.sourceKind],
    plans: PLAN_MONTHS.map((months) => ({ ...planOption(r.remainingCents, months), months })),
    partialMinimumCents: PARTIAL_MINIMUM_CENTS,
    email: {
      to: maskEmail(patient?.email ?? null),
      subject: `Your ${formatMonthDay(r.visitDate)} visit — ${formatMoney(r.remainingCents)} due ${formatMonthDay(dueDate)}`,
      dueDate,
    },
    ai,
  };
}

export async function draftMessage(
  db: Db,
  balanceId: number,
  today: IsoDate,
  drafter: MessageDrafter,
  request: { variant: MessageVariant; lang: string },
  option: PaymentOption,
) {
  const r = balanceRow(db, balanceId, today);
  return drafter.draft(
    buildMessageFacts(r, practiceName(db), option, dueDateFor(r, today)),
    request,
  );
}

export interface DraftInput {
  message: string;
  messageSource: 'ai' | 'template' | 'edited';
  /** The message's language (a NOTE_LANGUAGES code); null when the client didn't say. */
  messageLang: string | null;
  paymentOption: PaymentOption;
}

export function validateOption(r: BalanceRow, option: PaymentOption): void {
  if (option.type === 'plan') {
    const p = planOption(r.remainingCents, option.months);
    if (!p.eligible)
      throw new DrawerError(
        `A ${option.months}-month plan would be under ${formatMoney(PARTIAL_MINIMUM_CENTS)} a month.`,
      );
  }
  if (option.type === 'partial' && option.minimumCents !== PARTIAL_MINIMUM_CENTS) {
    throw new DrawerError(`The partial-payment minimum is ${formatMoney(PARTIAL_MINIMUM_CENTS)}.`);
  }
}

export function checkAmounts(db: Db, r: BalanceRow, message: string): void {
  const issues = checkMessage(message, guardFacts(r, practiceName(db)));
  if (issues.length) {
    throw new DrawerError(
      "The message mentions something it shouldn't.",
      422,
      issues.map((i) => i.detail),
    );
  }
}

export function saveDraft(db: Db, balanceId: number, today: IsoDate, input: DraftInput): number {
  const r = balanceRow(db, balanceId, today);
  validateOption(r, input.paymentOption);
  const existing = db
    .select()
    .from(invoices)
    .where(and(eq(invoices.balanceId, balanceId), eq(invoices.status, 'draft')))
    .get();
  const values = {
    message: input.message,
    messageSource: input.messageSource,
    messageLang: input.messageLang,
    paymentOption: input.paymentOption,
    amountCents: r.remainingCents,
  };
  if (existing) {
    db.update(invoices).set(values).where(eq(invoices.id, existing.id)).run();
    return existing.id;
  }
  return db
    .insert(invoices)
    .values({ balanceId, status: 'draft', ...values })
    .returning({ id: invoices.id })
    .get().id;
}

/** Resolve an AI flag on a balance that is already on the dashboard (status "review"). */
export function resolveBalanceFlag(
  db: Db,
  balanceId: number,
  today: IsoDate,
  path: string,
  value: string,
  now = new Date().toISOString(),
): void {
  const r = balanceRow(db, balanceId, today);
  if (r.status !== 'review')
    throw new DrawerError('Only balances in review have fields to confirm.', 409);
  const linked = itemForBalance(db, balanceId);
  if (!linked?.item.extraction) throw new DrawerError('This balance has no AI-read fields.', 404);
  // Check before saving: on a live balance, the corrected claim must still add up.
  const [candidate] = eobToClaims(withFieldValue(linked.item.extraction, path, value.trim()), {
    fileName: linked.fileName,
  });
  if (!candidate?.claim) {
    throw new DrawerError(
      `That reading doesn't add up with the rest of the EOB. ${candidate?.error ?? ''}`.trim(),
      422,
    );
  }
  try {
    resolveFlag(db, linked.item.id, path, value, now);
  } catch (err) {
    if (err instanceof IntakeError) throw new DrawerError(err.message, err.status);
    throw err;
  }
  replaceVisitClaim(db, balanceId, candidate.claim, now);
  const summary = reviewSummary(candidate.flags);
  db.update(balances)
    .set({ reviewReason: summary?.reviewReason ?? 'Checked — ready to mark ready', updatedAt: now })
    .where(eq(balances.id, balanceId))
    .run();
}

/** Review → Ready, once nothing is left to confirm. */
export function markReady(
  db: Db,
  balanceId: number,
  today: IsoDate,
  now = new Date().toISOString(),
): void {
  const r = balanceRow(db, balanceId, today);
  const review = reviewInfo(db, r);
  if (review && !review.canMarkReady) {
    throw new DrawerError(
      'Confirm the flagged fields first.',
      409,
      review.flags.map((f) => f.label),
    );
  }
  const status = nextStatus(r.status, { type: 'approve' });
  db.update(balances)
    .set({
      status,
      reviewReason: null,
      aiSuggestion: 'Send invoice',
      aiAction: 'send_invoice',
      aiSuggestionBy: null,
      updatedAt: now,
    })
    .where(eq(balances.id, balanceId))
    .run();
}

/** Balance ids that came from an intake batch (for tests and seed checks). */
export function balanceIdsFromIntake(db: Db): number[] {
  return db
    .select({ id: intakeItems.balanceId })
    .from(intakeItems)
    .all()
    .map((r) => r.id)
    .filter((id): id is number => id !== null);
}
