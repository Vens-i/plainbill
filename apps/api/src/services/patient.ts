/**
 * The patient's side: /pay/:token.
 *
 * - Verify with last name + date of birth (5 tries, then a 15-minute lock).
 * - The bill: every amount comes from the computed balance; the explanations are fixed templates
 *   filled with those amounts (no AI on this path).
 * - Pay with PayPal / Pay Later (Orders v2, amount decided here, never by the browser), or start
 *   a 3/6-month plan (Subscriptions v1).
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import {
  buildPaymentPlan,
  formatLongDate,
  formatMoney,
  formatMoneyShort,
  formatMonthDay,
  patientServiceName,
  planOption,
  type PlanMonths,
} from '@plainbill/core';
import type { BalanceRow, PatientBill, PayLinkInfo, WaterfallStep } from '../contract';
import {
  appSettings,
  balances,
  claimLines,
  events,
  invoices,
  patients,
  paymentPlans,
  payments,
  paypalOrders,
  practices,
  visits,
} from '../db/schema';
import { PayPalError, toPayPalMoney } from '../paypal/client';
import type { BillingCycle } from '../paypal/types';
import { getBalanceRows } from '../queries/rows';
import { publishChanged, type RouteContext } from '../routes/context';
import { captureApprovedOrder, reconcilePlan } from './paypal-sync';
import { normalizeLastName, payUrl } from './sessions';

type Ctx = Pick<RouteContext, 'db' | 'bus' | 'today' | 'paypal' | 'queue' | 'log' | 'appBaseUrl'>;

export class PatientError extends Error {
  override name = 'PatientError';
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const MAX_VERIFY_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;

type InvoiceRow = typeof invoices.$inferSelect;

function practice(ctx: Pick<Ctx, 'db'>) {
  return ctx.db.select().from(practices).orderBy(asc(practices.id)).get()!;
}

/** "Harborview Family Medicine" → "HFM". */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 4);
}

export function confirmationNumber(practiceName: string, paymentId: number): string {
  return `${initials(practiceName)}-${24800 + paymentId}`;
}

export function invoiceForToken(ctx: Pick<Ctx, 'db'>, token: string): InvoiceRow {
  const invoice = /^[A-Za-z0-9_-]{20,64}$/.test(token)
    ? ctx.db.select().from(invoices).where(eq(invoices.payToken, token)).get()
    : undefined;
  if (!invoice || (invoice.status !== 'sent' && invoice.status !== 'paid')) {
    throw new PatientError("This link isn't valid anymore.", 404, 'not_found');
  }
  return invoice;
}

export function payLinkInfo(ctx: Ctx, verified: boolean): PayLinkInfo {
  const p = practice(ctx);
  return { practice: { name: p.name, phone: p.phone, hours: p.hours }, verified };
}

export interface VerifyInput {
  lastName: string;
  month: number;
  day: number;
  year: number;
}

function isoDob({ month, day, year }: VerifyInput): string | null {
  if (![month, day, year].every(Number.isInteger)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2100) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Check last name + DOB against the patient on file. Returns nothing on success; throws otherwise. */
export function verifyPatient(ctx: Ctx, invoice: InvoiceRow, input: VerifyInput, now = new Date()) {
  const { db } = ctx;
  if (invoice.verifyLockedUntil && Date.parse(invoice.verifyLockedUntil) > now.getTime()) {
    throw new PatientError(
      `Too many tries. For your security, please wait ${LOCK_MINUTES} minutes or call the office.`,
      429,
      'locked',
      { retryAt: invoice.verifyLockedUntil },
    );
  }
  const person = db
    .select({ lastName: patients.lastName, dob: patients.dob })
    .from(balances)
    .innerJoin(visits, eq(balances.visitId, visits.id))
    .innerJoin(patients, eq(visits.patientId, patients.id))
    .where(eq(balances.id, invoice.balanceId))
    .get();
  const dob = isoDob(input);
  const matches =
    !!person &&
    !!dob &&
    person.dob === dob &&
    normalizeLastName(input.lastName) !== '' &&
    normalizeLastName(input.lastName) === normalizeLastName(person.lastName);

  if (!matches) {
    const failures = invoice.verifyFailures + 1;
    const lock = failures >= MAX_VERIFY_ATTEMPTS;
    db.update(invoices)
      .set({
        verifyFailures: lock ? 0 : failures,
        verifyLockedUntil: lock
          ? new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString()
          : null,
      })
      .where(eq(invoices.id, invoice.id))
      .run();
    if (lock) {
      throw new PatientError(
        `Too many tries. For your security, please wait ${LOCK_MINUTES} minutes or call the office.`,
        429,
        'locked',
      );
    }
    throw new PatientError(
      "We couldn't find a bill with those details. Check the spelling and date of birth.",
      401,
      'not_matched',
      { attemptsLeft: MAX_VERIFY_ATTEMPTS - failures },
    );
  }

  const openedAt = now.toISOString();
  db.update(invoices)
    .set({
      verifyFailures: 0,
      verifyLockedUntil: null,
      openCount: invoice.openCount + 1,
      lastOpenedAt: openedAt,
    })
    .where(eq(invoices.id, invoice.id))
    .run();
  db.insert(events)
    .values({
      type: 'invoice.opened',
      balanceId: invoice.balanceId,
      payload: { invoiceId: invoice.id },
      createdAt: openedAt,
    })
    .run();
  publishChanged(ctx, [invoice.balanceId]);
}

// ── The bill ────────────────────────────────────────────────────────────────

function joinParts(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')}, plus ${parts.at(-1)}`;
}

/** Fixed explanations, filled with computed amounts (artboard 1f's "tap a bar" copy). */
export function waterfall(r: BalanceRow, practiceName: string): WaterfallStep[] {
  const short = practiceName.split(' ')[0]!;
  const visit = formatMonthDay(r.visitDate);
  const payer = r.payerShortName;
  const selfPay = r.payerKind === 'self-pay';
  const steps: WaterfallStep[] = [
    {
      key: 'billed',
      label: 'Billed',
      amountCents: r.billedCents,
      title: `Billed: ${formatMoney(r.billedCents)}`,
      body: `What ${short} charged for your ${visit} visit, before ${selfPay ? 'any discount' : 'insurance'}.`,
    },
  ];
  if (r.contractualCents > 0) {
    steps.push({
      key: 'discount',
      label: selfPay ? 'Self-pay discount' : 'Insurance discount',
      amountCents: -r.contractualCents,
      title: `${selfPay ? 'Self-pay discount' : 'Insurance discount'}: −${formatMoney(r.contractualCents)}`,
      body: selfPay
        ? `${short}'s self-pay rate lowers the price for patients paying without insurance. You never pay this part.`
        : `${payer} has a contract rate with ${short}. This part is written off — you never pay it.`,
    });
  }
  if ((r.insurancePaidCents ?? 0) > 0) {
    steps.push({
      key: 'insurance',
      label: 'Insurance paid',
      amountCents: -r.insurancePaidCents!,
      title: `Insurance paid: −${formatMoney(r.insurancePaidCents!)}`,
      body: `${payer} paid this part directly to ${short}.`,
    });
  }
  if (r.patientPaidCents > 0) {
    steps.push({
      key: 'paid',
      label: 'You paid',
      amountCents: -r.patientPaidCents,
      title: `You've paid: −${formatMoney(r.patientPaidCents)}`,
      body: 'Payments you have already made toward this visit. Thank you!',
    });
  }
  const s = r.patientShare;
  const parts = [
    s.deductibleCents > 0
      ? `${formatMoneyShort(s.deductibleCents)} goes toward your yearly deductible`
      : null,
    s.coinsuranceCents > 0
      ? `${formatMoneyShort(s.coinsuranceCents)} coinsurance — your share of the cost after the deductible`
      : null,
    s.copayCents > 0
      ? `a ${formatMoneyShort(s.copayCents)} copay — the set amount your plan charges for a visit`
      : null,
    s.otherCents > 0 ? `${formatMoneyShort(s.otherCents)} your plan didn't cover` : null,
  ].filter((x): x is string => x !== null);
  let owesBody = selfPay
    ? `The self-pay price for your ${visit} visit.`
    : parts.length
      ? `${joinParts(parts)}.`
      : `Your share of the ${visit} visit.`;
  owesBody = owesBody.charAt(0).toUpperCase() + owesBody.slice(1);
  if (r.patientPaidCents > 0)
    owesBody += ` After your payments, ${formatMoney(r.remainingCents)} is left.`;
  steps.push({
    key: 'owes',
    label: 'You owe',
    amountCents: r.remainingCents,
    title: `You owe: ${formatMoney(r.remainingCents)}`,
    body: owesBody,
  });
  return steps;
}

function terms(r: BalanceRow) {
  const s = r.patientShare;
  const allowed = r.billedCents - r.contractualCents;
  if (r.payerKind === 'self-pay') {
    return [
      {
        term: 'Self-pay rate',
        body: `the lower price for patients paying without insurance. Here, ${formatMoneyShort(allowed)}.`,
      },
    ];
  }
  return [
    {
      term: 'Allowed amount',
      body: `the price your insurance agreed to pay for a service. Here, ${formatMoneyShort(allowed)}.`,
    },
    s.deductibleCents > 0 && {
      term: 'Deductible',
      body: `what you pay each year before insurance starts sharing costs. ${formatMoneyShort(s.deductibleCents)} of this visit counted toward yours.`,
    },
    s.coinsuranceCents > 0 && {
      term: 'Coinsurance',
      body: `after your deductible, the share of the cost you pay. Here, ${formatMoneyShort(s.coinsuranceCents)}.`,
    },
    s.copayCents > 0 && {
      term: 'Copay',
      body: `a set amount you pay for a visit, decided by your plan. Here, ${formatMoneyShort(s.copayCents)}.`,
    },
  ].filter((t): t is { term: string; body: string } => Boolean(t));
}

export function activePlan(ctx: Pick<Ctx, 'db'>, invoiceId: number) {
  return ctx.db
    .select()
    .from(paymentPlans)
    .where(
      and(
        eq(paymentPlans.invoiceId, invoiceId),
        inArray(paymentPlans.status, ['active', 'completed']),
      ),
    )
    .orderBy(desc(paymentPlans.id))
    .get();
}

export function patientBill(ctx: Ctx, invoiceId: number): PatientBill {
  const { db } = ctx;
  const invoice = db.select().from(invoices).where(eq(invoices.id, invoiceId)).get()!;
  const [r] = getBalanceRows(db, ctx.today(), [invoice.balanceId]);
  if (!r) throw new PatientError('Bill not found.', 404, 'not_found');
  const p = practice(ctx);
  const balance = db.select().from(balances).where(eq(balances.id, invoice.balanceId)).get()!;
  const lines = db
    .select()
    .from(claimLines)
    .where(eq(claimLines.visitId, balance.visitId))
    .orderBy(asc(claimLines.lineNumber))
    .all();
  const paymentRows = db
    .select()
    .from(payments)
    .where(eq(payments.balanceId, invoice.balanceId))
    .orderBy(asc(payments.id))
    .all();
  const option = invoice.paymentOption ?? { type: 'full' as const };
  const plan = activePlan(ctx, invoiceId);
  const open = r.remainingCents > 0;

  const planView = plan
    ? (() => {
        const total = plan.firstCents + plan.regularCents * (plan.months - 1);
        const paidCount = paymentRows.filter((x) => x.planId === plan.id).length;
        const schedule = buildPaymentPlan(
          total,
          plan.months as PlanMonths,
          plan.startedOn ?? ctx.today(),
        ).map((i) => ({ ...i, paid: i.number <= paidCount }));
        return {
          id: plan.id,
          months: plan.months as PlanMonths,
          status: plan.status,
          totalCents: total,
          paidCount,
          schedule,
        };
      })()
    : null;

  return {
    practice: {
      name: p.name,
      phone: p.phone,
      hours: p.hours,
      address: [p.addressLine1, p.addressLine2].filter(Boolean).join(', '),
    },
    firstName: r.patientFirstName,
    lastInitial: r.patientName.slice(r.patientFirstName.length).trim().charAt(0).toUpperCase(),
    status: r.status,
    visit: { date: r.visitDate, provider: r.provider },
    dueDate: invoice.dueDate ?? r.visitDate,
    selfPay: r.payerKind === 'self-pay',
    payerShortName: r.payerShortName,
    amounts: {
      billedCents: r.billedCents,
      discountCents: r.contractualCents,
      allowedCents: r.billedCents - r.contractualCents,
      insurancePaidCents: r.insurancePaidCents,
      patientShareCents: r.patientResponsibilityCents,
      paidCents: r.patientPaidCents,
      remainingCents: r.remainingCents,
    },
    patientShare: r.patientShare,
    waterfall: waterfall(r, p.name),
    services: lines.map((l) => ({
      name: patientServiceName(l.procedureCode, r.provider),
      chargeCents: l.chargeCents,
    })),
    terms: terms(r),
    options: {
      partialMinimumCents: open && option.type === 'partial' ? option.minimumCents : null,
      plans:
        open && option.type === 'plan' && !planView
          ? ([3, 6] as const)
              .map((m) => ({ ...planOption(r.remainingCents, m), selected: m === option.months }))
              .filter((o) => o.eligible)
              .map(({ months, firstCents, regularCents, selected }) => ({
                months,
                firstCents,
                regularCents,
                selected,
              }))
          : [],
    },
    payments: paymentRows.map((x) => ({
      id: x.id,
      amountCents: x.amountCents,
      paidAt: x.receivedAt,
      via: x.method === 'paypal' ? 'PayPal' : x.method === 'card' ? 'card' : 'cash',
      confirmation: confirmationNumber(p.name, x.id),
      planId: x.planId,
    })),
    plan: planView,
    paypal: {
      enabled: Boolean(ctx.paypal.api && ctx.paypal.clientId),
      clientId: ctx.paypal.clientId,
      env: ctx.paypal.env,
    },
  };
}

// ── Pay with PayPal (Orders v2) ─────────────────────────────────────────────

export function openBalance(ctx: Ctx, invoice: InvoiceRow) {
  const [r] = getBalanceRows(ctx.db, ctx.today(), [invoice.balanceId]);
  if (!r || invoice.status !== 'sent' || r.remainingCents <= 0) {
    throw new PatientError('This bill is already paid. Thank you!', 409, 'already_paid');
  }
  return r;
}

function requireApi(ctx: Ctx) {
  if (!ctx.paypal.api) {
    throw new PatientError(
      'Online payment is not set up yet. Please call the office.',
      503,
      'no_paypal',
    );
  }
  return ctx.paypal.api;
}

export async function createCheckoutOrder(
  ctx: Ctx,
  invoice: InvoiceRow,
  input: { amountCents?: number; fundingSource?: string },
): Promise<{ orderId: string; amountCents: number }> {
  const api = requireApi(ctx);
  const r = openBalance(ctx, invoice);
  const amount = input.amountCents ?? r.remainingCents;
  const option = invoice.paymentOption ?? { type: 'full' as const };
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > r.remainingCents) {
    throw new PatientError(`Pay up to ${formatMoney(r.remainingCents)}.`, 400, 'bad_amount');
  }
  if (amount !== r.remainingCents) {
    const min = option.type === 'partial' ? option.minimumCents : null;
    if (min === null) {
      throw new PatientError('This bill is paid in full or with a plan.', 400, 'bad_amount');
    }
    if (amount < min) {
      throw new PatientError(`The smallest payment is ${formatMoney(min)}.`, 400, 'bad_amount');
    }
  }
  const p = practice(ctx);
  const wallet = input.fundingSource === 'paypal' || input.fundingSource === 'paylater';
  const order = await api.createOrder(
    {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: `balance-${invoice.balanceId}`,
          custom_id: `pb-inv-${invoice.id}`,
          // Shown to the payer: practice and visit date only.
          description: `${p.name} · visit on ${formatLongDate(r.visitDate)}`.slice(0, 127),
          amount: toPayPalMoney(amount),
        },
      ],
      ...(wallet
        ? {
            payment_source: {
              paypal: {
                experience_context: {
                  brand_name: p.name.slice(0, 127),
                  shipping_preference: 'NO_SHIPPING',
                  user_action: 'PAY_NOW',
                },
              },
            },
          }
        : {}),
    },
    `pb-order-${invoice.id}-${randomUUID()}`,
  );
  ctx.db
    .insert(paypalOrders)
    .values({ id: order.id, invoiceId: invoice.id, amountCents: amount, status: 'created' })
    .run();
  return { orderId: order.id, amountCents: amount };
}

export async function captureCheckoutOrder(
  ctx: Ctx,
  invoice: InvoiceRow,
  orderId: string,
): Promise<{ paymentId: number | null; pending: boolean }> {
  requireApi(ctx);
  const order = ctx.db
    .select()
    .from(paypalOrders)
    .where(and(eq(paypalOrders.id, orderId), eq(paypalOrders.invoiceId, invoice.id)))
    .get();
  if (!order) throw new PatientError('Unknown payment.', 404, 'not_found');

  try {
    return await ctx.queue.run(() => captureApprovedOrder(ctx, order));
  } catch (err) {
    if (err instanceof PayPalError && err.issue === 'INSTRUMENT_DECLINED') {
      throw new PatientError(
        'PayPal declined that payment method. Please try another one.',
        422,
        'declined',
      );
    }
    if (err instanceof PayPalError) throw err;
    throw new PatientError('PayPal did not complete the payment.', 502, 'not_completed');
  }
}

// ── Payment plans (Subscriptions v1) ────────────────────────────────────────

function setting(ctx: Ctx, key: string): string | undefined {
  return ctx.db.select().from(appSettings).where(eq(appSettings.key, key)).get()?.value;
}

function saveSetting(ctx: Ctx, key: string, value: string) {
  ctx.db
    .insert(appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value } })
    .run();
}

/** One catalog product for every plan (cached). */
async function planProduct(ctx: Ctx): Promise<string> {
  const key = `paypal.${ctx.paypal.env}.product`;
  const cached = setting(ctx, key);
  if (cached) return cached;
  const id = await requireApi(ctx).createProduct(
    { name: 'Medical bill payment plan', description: 'Interest-free monthly payments' },
    `pb-product-${ctx.paypal.env}-v1`,
  );
  saveSetting(ctx, key, id);
  return id;
}

/**
 * A PayPal plan for one amount schedule (cached by amounts, reusable across patients). When the
 * balance doesn't split evenly, the first payment is larger; PayPal models that as a one-cycle
 * priced "trial" followed by the regular cycles.
 */
export async function billingPlan(
  ctx: Ctx,
  months: PlanMonths,
  firstCents: number,
  regularCents: number,
) {
  const key = `paypal.${ctx.paypal.env}.plan.${months}.${firstCents}.${regularCents}`;
  const cached = setting(ctx, key);
  if (cached) return cached;
  const monthly = { interval_unit: 'MONTH', interval_count: 1 } as const;
  const cycles: BillingCycle[] =
    firstCents === regularCents
      ? [
          {
            frequency: monthly,
            tenure_type: 'REGULAR',
            sequence: 1,
            total_cycles: months,
            pricing_scheme: { fixed_price: toPayPalMoney(regularCents) },
          },
        ]
      : [
          {
            frequency: monthly,
            tenure_type: 'TRIAL',
            sequence: 1,
            total_cycles: 1,
            pricing_scheme: { fixed_price: toPayPalMoney(firstCents) },
          },
          {
            frequency: monthly,
            tenure_type: 'REGULAR',
            sequence: 2,
            total_cycles: months - 1,
            pricing_scheme: { fixed_price: toPayPalMoney(regularCents) },
          },
        ];
  const total = firstCents + regularCents * (months - 1);
  const id = await requireApi(ctx).createPlan(
    {
      product_id: await planProduct(ctx),
      name: `${months} monthly payments · ${formatMoney(total)}`,
      description: 'No interest or fees',
      billing_cycles: cycles,
      payment_preferences: {
        auto_bill_outstanding: true,
        setup_fee_failure_action: 'CANCEL',
        payment_failure_threshold: 2,
      },
    },
    `pb-plan-${ctx.paypal.env}-${months}-${firstCents}-${regularCents}`,
  );
  saveSetting(ctx, key, id);
  return id;
}

export async function startPlan(
  ctx: Ctx,
  invoice: InvoiceRow,
  months: PlanMonths,
): Promise<{ subscriptionId: string }> {
  const api = requireApi(ctx);
  const r = openBalance(ctx, invoice);
  if (invoice.paymentOption?.type !== 'plan') {
    throw new PatientError('A payment plan was not offered for this bill.', 400, 'no_plan');
  }
  if (activePlan(ctx, invoice.id)) {
    throw new PatientError('A payment plan is already set up for this bill.', 409, 'plan_exists');
  }
  const option = planOption(r.remainingCents, months);
  if (!option.eligible) {
    throw new PatientError(
      `A ${months}-month plan isn't available for this amount.`,
      400,
      'no_plan',
    );
  }
  const now = new Date().toISOString();
  // A plan the patient started but didn't approve can be reused.
  const pending = ctx.db
    .select()
    .from(paymentPlans)
    .where(and(eq(paymentPlans.invoiceId, invoice.id), eq(paymentPlans.status, 'pending')))
    .all();
  const reuse = pending.find(
    (p) =>
      p.months === months &&
      p.firstCents === option.firstCents &&
      p.regularCents === option.regularCents &&
      p.paypalSubscriptionId,
  );
  if (reuse) return { subscriptionId: reuse.paypalSubscriptionId! };
  for (const p of pending) {
    ctx.db
      .update(paymentPlans)
      .set({ status: 'cancelled', updatedAt: now })
      .where(eq(paymentPlans.id, p.id))
      .run();
  }

  const paypalPlanId = await billingPlan(ctx, months, option.firstCents, option.regularCents);
  const planId = ctx.db
    .insert(paymentPlans)
    .values({
      invoiceId: invoice.id,
      balanceId: invoice.balanceId,
      months,
      firstCents: option.firstCents,
      regularCents: option.regularCents,
      paypalPlanId,
      status: 'pending',
      updatedAt: now,
    })
    .returning({ id: paymentPlans.id })
    .get().id;
  const back = payUrl(ctx.appBaseUrl, invoice.payToken!);
  const sub = await api.createSubscription(
    {
      plan_id: paypalPlanId,
      custom_id: `pb-plan-${planId}`,
      application_context: {
        brand_name: practice(ctx).name.slice(0, 127),
        shipping_preference: 'NO_SHIPPING',
        user_action: 'SUBSCRIBE_NOW',
        return_url: back,
        cancel_url: back,
      },
    },
    `pb-sub-${planId}`,
  );
  ctx.db
    .update(paymentPlans)
    .set({ paypalSubscriptionId: sub.id })
    .where(eq(paymentPlans.id, planId))
    .run();
  return { subscriptionId: sub.id };
}

/**
 * After the patient approves in PayPal: activate the plan and record the first installment.
 * PayPal can take a few seconds to collect it; if it hasn't by the deadline, the sync (or the
 * PAYMENT.SALE.COMPLETED webhook) records it later and the dashboard flashes then.
 */
export async function confirmPlan(
  ctx: Ctx,
  invoice: InvoiceRow,
  subscriptionId: string,
  options: { attempts?: number; waitMs?: number } = {},
): Promise<{ paymentId: number | null; pending: boolean }> {
  const plan = ctx.db
    .select()
    .from(paymentPlans)
    .where(
      and(
        eq(paymentPlans.invoiceId, invoice.id),
        eq(paymentPlans.paypalSubscriptionId, subscriptionId),
      ),
    )
    .get();
  if (!plan) throw new PatientError('Unknown payment plan.', 404, 'not_found');
  const attempts = options.attempts ?? 8;
  const waitMs = options.waitMs ?? 1000;
  for (let i = 0; i < attempts; i++) {
    await ctx.queue.run(() => reconcilePlan(ctx, plan.id));
    const first = ctx.db
      .select()
      .from(payments)
      .where(eq(payments.planId, plan.id))
      .orderBy(asc(payments.id))
      .get();
    if (first) return { paymentId: first.id, pending: false };
    if (i < attempts - 1) await new Promise((res) => setTimeout(res, waitMs));
  }
  return { paymentId: null, pending: true };
}
