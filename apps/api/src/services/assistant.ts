/**
 * The patient's bill helper, server side.
 *
 * - `billFacts`: the only things the model sees — this bill, as computed by @plainbill/core.
 * - `proposalHandler`: what the model's tools do. A proposal is validated against the bill and
 *   the options staff offered, turned into a card with code-computed amounts, and stored.
 * - `confirmAction`: the patient tapped Confirm. Only now does anything reach PayPal, through
 *   the PayPal Agent Toolkit, with code-built input. The patient then approves in PayPal, and
 *   the usual capture / plan-confirm routes record the payment.
 */
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { BillFacts, ProposalCard, ProposalHandler, ProposalInput } from '@plainbill/ai';
import {
  buildPaymentPlan,
  formatLongDate,
  formatMoneyShort,
  formatMonthDay,
  planOption,
  type PlanMonths,
} from '@plainbill/core';
import type { AssistantConfirmResult, PatientBill } from '../contract';
import type { invoices } from '../db/schema';
import { assistantActions, paymentPlans, paypalOrders } from '../db/schema';
import { getBalanceRows } from '../queries/rows';
import type { RouteContext } from '../routes/context';
import { activePlan, billingPlan, openBalance, PatientError, patientBill } from './patient';
import { serviceLine } from './send';

type Ctx = Pick<RouteContext, 'db' | 'bus' | 'today' | 'paypal' | 'queue' | 'log' | 'appBaseUrl'>;
type InvoiceRow = typeof invoices.$inferSelect;

/** A card is good for this long after it's shown. */
const ACTION_TTL_MS = 30 * 60_000;
const $ = formatMoneyShort;

export function billFacts(bill: PatientBill, payerShortName: string | null): BillFacts {
  const { amounts } = bill;
  return {
    patientFirstName: bill.firstName,
    practice: { name: bill.practice.name, phone: bill.practice.phone, hours: bill.practice.hours },
    visitDate: bill.visit.date,
    provider: bill.visit.provider,
    selfPay: bill.selfPay,
    payerShortName: bill.selfPay ? null : payerShortName,
    billedCents: amounts.billedCents,
    discountCents: amounts.discountCents,
    allowedCents: amounts.allowedCents,
    insurancePaidCents: amounts.insurancePaidCents ?? 0,
    deductibleCents: bill.patientShare.deductibleCents,
    coinsuranceCents: bill.patientShare.coinsuranceCents,
    copayCents: bill.patientShare.copayCents,
    otherPatientCents: bill.patientShare.otherCents,
    patientShareCents: amounts.patientShareCents,
    paidCents: amounts.paidCents,
    remainingCents: amounts.remainingCents,
    dueDate: bill.dueDate,
    services: bill.services,
    options: {
      payInFull: amounts.remainingCents > 0,
      partialMinimumCents: bill.options.partialMinimumCents,
      plans: bill.options.plans.map(({ months, firstCents, regularCents }) => ({
        months,
        firstCents,
        regularCents,
      })),
    },
    activePlan: bill.plan
      ? {
          months: bill.plan.months,
          paidCount: bill.plan.paidCount,
          schedule: bill.plan.schedule.map((s) => ({
            dueDate: s.dueDate,
            amountCents: s.amountCents,
            paid: s.paid,
          })),
        }
      : null,
  };
}

export function factsFor(ctx: Ctx, invoice: InvoiceRow): BillFacts {
  const bill = patientBill(ctx, invoice.id);
  return billFacts(bill, bill.payerShortName);
}

function storeAction(
  ctx: Ctx,
  invoice: InvoiceRow,
  kind: 'pay_in_full' | 'payment_plan' | 'partial_payment',
  amountCents: number,
  remainingCents: number,
  months: number | null,
): string {
  const id = randomBytes(12).toString('base64url');
  ctx.db
    .insert(assistantActions)
    .values({
      id,
      invoiceId: invoice.id,
      kind,
      months,
      amountCents,
      remainingCents,
      status: 'proposed',
      createdAt: new Date().toISOString(),
    })
    .run();
  return id;
}

/** What the model's tools do: validate, build the card with code-computed amounts, store it. */
export function proposalHandler(ctx: Ctx, invoice: InvoiceRow): ProposalHandler {
  return {
    async propose(input: ProposalInput) {
      const bill = patientBill(ctx, invoice.id);
      const remaining = bill.amounts.remainingCents;
      const practice = bill.practice;
      const short = practice.name.split(' ')[0]!;

      if (input.kind === 'phone_call') {
        const card: ProposalCard = {
          id: null,
          kind: 'phone_call',
          title: `Talk to someone at ${short}`,
          detail: [practice.phone, ...(practice.hours ? [practice.hours] : [])],
          amountCents: null,
          confirmLabel: null,
        };
        return { ok: true, card, summary: `Shown: call ${practice.phone}.` };
      }
      if (remaining <= 0 || invoice.status !== 'sent') {
        return { ok: false, reason: 'Nothing is owed on this bill anymore.' };
      }

      if (input.kind === 'pay_in_full') {
        const id = storeAction(ctx, invoice, 'pay_in_full', remaining, remaining, null);
        return {
          ok: true,
          card: {
            id,
            kind: 'pay_in_full',
            title: `Pay ${$(remaining)} in full`,
            detail: [
              'PayPal, Pay Later or a card',
              'Nothing is charged until you approve in PayPal',
            ],
            amountCents: remaining,
            confirmLabel: 'Confirm and continue to PayPal',
          },
          summary: `A card to pay ${$(remaining)} in full is shown. The patient must tap Confirm, then approve in PayPal.`,
        };
      }

      if (input.kind === 'payment_plan') {
        const offered = bill.options.plans.find((p) => p.months === input.months);
        if (!offered) {
          return {
            ok: false,
            reason: bill.plan
              ? 'A payment plan is already set up for this bill.'
              : bill.options.plans.length
                ? `Only ${bill.options.plans.map((p) => `${p.months}-month`).join(' or ')} plans are offered.`
                : 'Payment plans were not offered for this bill. The patient can call the office to ask.',
          };
        }
        const schedule = buildPaymentPlan(remaining, input.months, ctx.today());
        const id = storeAction(
          ctx,
          invoice,
          'payment_plan',
          offered.firstCents,
          remaining,
          input.months,
        );
        const lines = schedule.map(
          (i) => `${i.number === 1 ? 'Today' : formatMonthDay(i.dueDate)}: ${$(i.amountCents)}`,
        );
        return {
          ok: true,
          card: {
            id,
            kind: 'payment_plan',
            title:
              offered.firstCents === offered.regularCents
                ? `${input.months} payments of ${$(offered.regularCents)}`
                : `${input.months} payments: ${$(offered.firstCents)}, then ${$(offered.regularCents)}`,
            detail: [...lines, 'No interest or fees · PayPal takes each payment automatically'],
            amountCents: offered.firstCents,
            confirmLabel: 'Confirm plan',
          },
          summary: `A card for ${input.months} monthly payments (${lines.join(', ')}) is shown. The patient must tap Confirm, then approve in PayPal.`,
          amounts: schedule.map((i) => i.amountCents),
        };
      }

      // Partial payment, at an amount the patient named.
      const min = bill.options.partialMinimumCents;
      if (min === null) {
        return { ok: false, reason: 'Paying part was not offered for this bill.' };
      }
      if (input.amountCents < min) {
        return { ok: false, reason: `The smallest payment is ${$(min)}.` };
      }
      if (input.amountCents >= remaining) {
        return {
          ok: false,
          reason: `That covers the whole ${$(remaining)}; offer paying in full.`,
        };
      }
      const id = storeAction(ctx, invoice, 'partial_payment', input.amountCents, remaining, null);
      return {
        ok: true,
        card: {
          id,
          kind: 'partial_payment',
          title: `Pay ${$(input.amountCents)} now`,
          detail: [
            `${$(remaining - input.amountCents)} left, due ${formatLongDate(bill.dueDate)}`,
            'Nothing is charged until you approve in PayPal',
          ],
          amountCents: input.amountCents,
          confirmLabel: 'Confirm and continue to PayPal',
        },
        summary: `A card to pay ${$(input.amountCents)} now is shown; ${$(remaining - input.amountCents)} would be left. The patient must tap Confirm, then approve in PayPal.`,
        amounts: [input.amountCents, remaining - input.amountCents],
      };
    },
  };
}

/** The patient confirmed a card: create the PayPal order or subscription through the toolkit. */
export async function confirmAction(
  ctx: Ctx,
  invoice: InvoiceRow,
  actionId: string,
): Promise<AssistantConfirmResult> {
  const action = ctx.db
    .select()
    .from(assistantActions)
    .where(and(eq(assistantActions.id, actionId), eq(assistantActions.invoiceId, invoice.id)))
    .get();
  if (!action) throw new PatientError('That option is no longer available.', 404, 'not_found');
  if (action.status === 'confirmed') {
    return {
      kind: action.kind,
      amountCents: action.amountCents,
      orderId: action.paypalOrderId,
      subscriptionId: action.paypalSubscriptionId,
    };
  }
  if (Date.now() - Date.parse(action.createdAt) > ACTION_TTL_MS) {
    throw new PatientError('That option has expired. Please ask again.', 410, 'expired');
  }
  const agent = ctx.paypal.agent;
  if (!agent || !ctx.paypal.api) {
    throw new PatientError(
      'Online payment is not set up yet. Please call the office.',
      503,
      'no_paypal',
    );
  }
  const r = openBalance(ctx, invoice);
  if (r.remainingCents !== action.remainingCents) {
    throw new PatientError('Your balance changed. Please ask again.', 409, 'changed');
  }
  const confirmedAt = new Date().toISOString();

  if (action.kind === 'payment_plan') {
    if (activePlan(ctx, invoice.id)) {
      throw new PatientError('A payment plan is already set up for this bill.', 409, 'plan_exists');
    }
    const months = action.months as PlanMonths;
    const option = planOption(r.remainingCents, months);
    const planId = await billingPlan(ctx, months, option.firstCents, option.regularCents);
    const subscriptionId = await agent.createSubscription(planId);
    ctx.db
      .insert(paymentPlans)
      .values({
        invoiceId: invoice.id,
        balanceId: invoice.balanceId,
        months,
        firstCents: option.firstCents,
        regularCents: option.regularCents,
        paypalPlanId: planId,
        paypalSubscriptionId: subscriptionId,
        status: 'pending',
        updatedAt: confirmedAt,
      })
      .run();
    ctx.db
      .update(assistantActions)
      .set({ status: 'confirmed', paypalSubscriptionId: subscriptionId, confirmedAt })
      .where(eq(assistantActions.id, action.id))
      .run();
    ctx.log.info(`Bill helper: plan ${months}× for invoice ${invoice.id} → ${subscriptionId}`);
    return { kind: action.kind, amountCents: option.firstCents, orderId: null, subscriptionId };
  }

  const [row] = getBalanceRows(ctx.db, ctx.today(), [invoice.balanceId]);
  const practiceName = patientBill(ctx, invoice.id).practice.name;
  const orderId = await agent.createOrder({
    itemName: serviceLine(row!, practiceName),
    amountCents: action.amountCents,
  });
  ctx.db
    .insert(paypalOrders)
    .values({
      id: orderId,
      invoiceId: invoice.id,
      amountCents: action.amountCents,
      status: 'created',
    })
    .run();
  ctx.db
    .update(assistantActions)
    .set({ status: 'confirmed', paypalOrderId: orderId, confirmedAt })
    .where(eq(assistantActions.id, action.id))
    .run();
  ctx.log.info(
    `Bill helper: ${action.kind} ${action.amountCents}¢ for invoice ${invoice.id} → ${orderId}`,
  );
  return { kind: action.kind, amountCents: action.amountCents, orderId, subscriptionId: null };
}

/** Simple per-bill limit on questions, so a link can't be used to run up model costs. */
export class QuestionLimiter {
  private readonly hits = new Map<number, number[]>();
  constructor(
    private readonly max = 30,
    private readonly windowMs = 60 * 60_000,
  ) {}

  allow(invoiceId: number, now = Date.now()): boolean {
    const recent = (this.hits.get(invoiceId) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) return false;
    recent.push(now);
    this.hits.set(invoiceId, recent);
    return true;
  }
}
