/**
 * The practice's itemized patient statement ("Your statement, explained"). Everything comes
 * from the computed balance and the stored claim; @plainbill/core builds the rows, the layout and
 * the anchors. Statements are cheap, so they're recomputed on every request (no cache) and
 * dated today: a statement shows all activity to date, including payments after the send.
 *
 * The patient sees it only after verification (routes/patient.ts); staff can preview it from
 * the drawer before sending, with a placeholder statement ID.
 */
import { asc, desc, eq } from 'drizzle-orm';
import {
  buildPaymentPlan,
  buildStatementModel,
  daysBetween,
  layoutStatement,
  planOption,
  statementAging,
  type PlanMonths,
  type StatementInput,
  type StatementLayout,
  type StatementModel,
} from '@plainbill/core';
import type { BalanceRow, PaymentOption } from '../contract';
import { balances, invoices, patients, payments, practices, visits } from '../db/schema';
import { getBalanceRows } from '../queries/rows';
import type { RouteContext } from '../routes/context';
import { DrawerError, dueDateFor } from './drawer';
import { activePlan } from './patient';
import { payUrl } from './sessions';

type Ctx = Pick<RouteContext, 'db' | 'today' | 'appBaseUrl'>;
type InvoiceRow = typeof invoices.$inferSelect;

/** "S0000014" */
export function statementIdFor(invoiceId: number): string {
  return `S${String(invoiceId).padStart(7, '0')}`;
}

/** "Harborview-statement-S0000014.pdf" */
export function statementFileName(practiceName: string, statementId: string): string {
  const short = practiceName.split(/\s+/)[0]!.replace(/[^A-Za-z0-9-]/g, '') || 'Practice';
  return `${short}-statement-${statementId}.pdf`;
}

/** The main write-off code as printed ("CO45"); the biggest one when there are several. */
function contractualCode(r: BalanceRow): string {
  const main = r.adjustments
    .filter((a) => a.kind === 'writeoff' && a.amountCents !== null)
    .sort((a, b) => a.amountCents! - b.amountCents!)[0];
  return main ? main.code.replace('-', '') : 'CO45';
}

function planInfo(
  ctx: Ctx,
  r: BalanceRow,
  invoice: InvoiceRow | null,
  option: PaymentOption,
): Pick<StatementInput, 'planOffer' | 'planActive'> {
  const plan = invoice ? activePlan(ctx, invoice.id) : undefined;
  if (plan) {
    const paidCount = ctx.db
      .select()
      .from(payments)
      .where(eq(payments.planId, plan.id))
      .all().length;
    const total = plan.firstCents + plan.regularCents * (plan.months - 1);
    const next = buildPaymentPlan(total, plan.months as PlanMonths, plan.startedOn ?? ctx.today())[
      paidCount
    ];
    return {
      planOffer: null,
      planActive: {
        months: plan.months,
        paidCount,
        nextDate: next?.dueDate ?? null,
        nextCents: next?.amountCents ?? null,
      },
    };
  }
  if (option.type === 'plan' && r.remainingCents > 0) {
    const p = planOption(r.remainingCents, option.months);
    if (p.eligible) {
      return {
        planOffer: { months: p.months, firstCents: p.firstCents, regularCents: p.regularCents },
        planActive: null,
      };
    }
  }
  return { planOffer: null, planActive: null };
}

/**
 * Everything the statement needs, for a balance and (once sent) its invoice. Without an invoice
 * it's a staff preview: placeholder statement ID and pay link, the draft's payment option.
 */
export function statementInput(
  ctx: Ctx,
  balanceId: number,
  invoice: InvoiceRow | null,
  draftOption: PaymentOption = { type: 'full' },
): StatementInput {
  const { db } = ctx;
  const today = ctx.today();
  const [r] = getBalanceRows(db, today, [balanceId]);
  if (!r) throw new DrawerError('No such balance.', 404);
  if (r.status === 'denied') {
    throw new DrawerError('Denied claims are not billed to the patient.', 409);
  }
  const row = db
    .select({ visit: visits, patient: patients })
    .from(balances)
    .innerJoin(visits, eq(balances.visitId, visits.id))
    .innerJoin(patients, eq(visits.patientId, patients.id))
    .where(eq(balances.id, balanceId))
    .get()!;
  const { visit, patient } = row;
  const p = db.select().from(practices).orderBy(asc(practices.id)).get()!;
  const paymentRows = db
    .select()
    .from(payments)
    .where(eq(payments.balanceId, balanceId))
    .orderBy(asc(payments.id))
    .all();
  const option = invoice?.paymentOption ?? draftOption;
  const cityLine = [patient.city, patient.state, patient.zip].filter(Boolean).join(' ');
  const host = new URL(ctx.appBaseUrl).host;

  return {
    practice: {
      name: p.name,
      addressLine1: p.addressLine1,
      addressLine2: p.addressLine2,
      city: p.city,
      state: p.state,
      zip: p.zip,
      phone: p.phone,
      hours: p.hours,
      payUrlHost: host,
    },
    patient: {
      firstName: patient.firstName,
      lastName: patient.lastName,
      addressLines: [
        [patient.addressLine1, patient.addressLine2].filter(Boolean).join(' '),
        cityLine,
      ].filter(Boolean),
    },
    accountNumber: String(patient.id).padStart(6, '0'),
    statementId: invoice ? statementIdFor(invoice.id) : 'PREVIEW',
    statementDate: today,
    dueDate: invoice?.dueDate ?? dueDateFor(r, today),
    payUrl: invoice?.payToken
      ? payUrl(ctx.appBaseUrl, invoice.payToken)
      : `${ctx.appBaseUrl}/pay/(your link is in the email)`,
    visit: {
      date: r.visitDate,
      providerName: r.provider,
      payerName: r.payerName,
      payerShortName: r.payerShortName,
      selfPay: r.payerKind === 'self-pay',
      claimFiledDate: visit.receivedDate,
      paymentDate: visit.paymentDate,
      traceNumber: visit.traceNumber,
    },
    lines: r.lines.map((l) => ({ code: l.code, chargeCents: l.chargeCents })),
    contractualCents: r.contractualCents,
    contractualCode: contractualCode(r),
    insurancePaidCents: r.insurancePaidCents,
    patientShare: r.patientShare,
    splitVisit: r.splitVisit
      ? {
          preventiveLineIndex: r.splitVisit.preventiveIndex,
          problemLineIndex: r.splitVisit.problemIndex,
          problemShare: r.splitVisit.problem.patientShare,
        }
      : null,
    payments: paymentRows.map((x) => ({ date: x.postedOn, amountCents: x.amountCents })),
    remainingCents: r.remainingCents,
    aging: statementAging(r.remainingCents, Math.max(0, daysBetween(r.visitDate, today))),
    ...planInfo(ctx, r, invoice, option),
  };
}

export interface Statement {
  model: StatementModel;
  layout: StatementLayout;
}

export function buildStatement(input: StatementInput): Statement {
  const model = buildStatementModel(input);
  return { model, layout: layoutStatement(model) };
}

/** The statement for a sent invoice (what the patient sees). */
export function statementFor(ctx: Ctx, invoiceId: number): Statement {
  const invoice = ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
  if (!invoice) throw new DrawerError('No such invoice.', 404);
  return buildStatement(statementInput(ctx, invoice.balanceId, invoice));
}

/** Staff preview from the drawer: the latest sent invoice if there is one, else a draft. */
export function statementPreview(
  ctx: Ctx,
  balanceId: number,
  draftOption: PaymentOption,
): Statement {
  const invoice =
    ctx.db
      .select()
      .from(invoices)
      .where(eq(invoices.balanceId, balanceId))
      .orderBy(desc(invoices.id))
      .all()
      .find((i) => i.status !== 'draft') ?? null;
  return buildStatement(statementInput(ctx, balanceId, invoice, draftOption));
}
