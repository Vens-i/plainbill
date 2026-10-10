/**
 * PayPal → Plainbill bookkeeping. Money can be reported three ways — the capture response on the
 * patient page, a webhook, or the reconciliation poll — and all three funnel through
 * `applyPayPalPayment`, which records each PayPal transaction id once, flashes the dashboard,
 * and copies checkout/plan payments onto the PayPal invoice so its payer link can't be paid twice.
 *
 * Everything that touches payments runs on `ctx.queue`, one job at a time.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PaymentEvent } from '../contract';
import {
  events,
  invoices,
  paymentPlans,
  payments,
  paypalOrders,
  webhookEvents,
} from '../db/schema';
import { fromPayPalMoney, PayPalError, toPayPalMoney } from '../paypal/client';
import type { PayPalInvoice, WebhookEvent } from '../paypal/types';
import { getBalanceRows } from '../queries/rows';
import type { RouteContext } from '../routes/context';
import { recordPayment, type RecordPaymentResult } from './payments';

type Ctx = Pick<RouteContext, 'db' | 'bus' | 'today' | 'paypal' | 'queue' | 'log'>;

export interface IncomingPayment {
  /** Our invoice the money is for. */
  invoiceId: number;
  /** PayPal's id for the money movement (capture, sale or invoice transaction). */
  externalId: string;
  amountCents: number;
  source: 'paypal-checkout' | 'paypal-invoice' | 'paypal-plan';
  planId?: number;
  receivedAt?: string;
}

export interface AppliedPayment {
  result: RecordPaymentResult | null;
  /** Money PayPal collected beyond what was owed (needs a refund; logged as an event). */
  excessCents: number;
}

/** Record one PayPal payment (idempotent). Call inside `ctx.queue.run`. */
export async function applyPayPalPayment(ctx: Ctx, p: IncomingPayment): Promise<AppliedPayment> {
  const { db } = ctx;
  const invoice = db.select().from(invoices).where(eq(invoices.id, p.invoiceId)).get();
  if (!invoice)
    throw new Error(`PayPal payment ${p.externalId} names unknown invoice ${p.invoiceId}`);
  const seen = db.select().from(payments).where(eq(payments.externalId, p.externalId)).get();
  if (seen) return { result: null, excessCents: 0 };

  const receivedAt = p.receivedAt ?? new Date().toISOString();
  const [before] = getBalanceRows(db, ctx.today(), [invoice.balanceId]);
  const remaining = before?.remainingCents ?? 0;
  const applied = Math.min(p.amountCents, remaining);
  const excess = p.amountCents - applied;
  if (excess > 0) recordExcess(ctx, invoice.balanceId, p, applied, receivedAt);
  if (applied <= 0) return { result: null, excessCents: excess };

  const result = recordPayment(db, invoice.balanceId, {
    amountCents: applied,
    method: 'paypal',
    source: p.source,
    externalId: p.externalId,
    ...(p.planId ? { planId: p.planId } : {}),
    postedOn: ctx.today(),
    receivedAt,
  });
  if (!result.duplicate) {
    const [balance] = getBalanceRows(db, ctx.today(), [invoice.balanceId]);
    const payment: PaymentEvent['payment'] = {
      id: result.paymentId,
      amountCents: result.amountCents,
      method: 'paypal',
      source: p.source,
      receivedAt,
    };
    ctx.bus.publish({ type: 'payment', data: { balance: balance!, payment } }, result.eventId);
    ctx.log.info(
      `PayPal ${p.source} ${p.externalId}: ${result.amountCents}¢ on balance ${invoice.balanceId} → ${result.status}`,
    );
    if (p.source !== 'paypal-invoice') await mirrorToPayPalInvoice(ctx, result.paymentId);
    if (result.status === 'paid') await endPlansFor(ctx, invoice.id, p.planId);
  }
  return { result, excessCents: excess };
}

function recordExcess(
  ctx: Ctx,
  balanceId: number,
  p: IncomingPayment,
  appliedCents: number,
  receivedAt: string,
) {
  const already = ctx.db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.type, 'payment.excess'),
        sql`json_extract(${events.payload}, '$.externalId') = ${p.externalId}`,
      ),
    )
    .get();
  if (already) return;
  ctx.db
    .insert(events)
    .values({
      type: 'payment.excess',
      balanceId,
      payload: { externalId: p.externalId, receivedCents: p.amountCents, appliedCents },
      createdAt: receivedAt,
    })
    .run();
  ctx.log.warn(
    `PayPal ${p.externalId} collected ${p.amountCents}¢ but only ${appliedCents}¢ was owed on balance ${balanceId}; refund the rest.`,
  );
}

/**
 * Copy a checkout or plan payment onto the PayPal invoice as a recorded payment, so the invoice's
 * payer page shows the lower amount due (or paid). Failures are retried by the next sync.
 */
async function mirrorToPayPalInvoice(ctx: Ctx, paymentId: number): Promise<void> {
  const api = ctx.paypal.api;
  if (!api) return;
  const row = ctx.db
    .select({ payment: payments, invoice: invoices })
    .from(payments)
    .innerJoin(invoices, eq(payments.invoiceId, invoices.id))
    .where(eq(payments.id, paymentId))
    .get();
  if (!row?.invoice.paypalInvoiceId || row.payment.paypalInvoiceTxnId) return;
  try {
    const txnId = await api.recordInvoicePayment(row.invoice.paypalInvoiceId, {
      method: 'PAYPAL',
      payment_date: row.payment.postedOn,
      amount: toPayPalMoney(row.payment.amountCents),
      note: `Paid on the Plainbill page (${row.payment.externalId})`,
    });
    ctx.db
      .update(payments)
      .set({ paypalInvoiceTxnId: txnId })
      .where(eq(payments.id, paymentId))
      .run();
  } catch (err) {
    ctx.log.warn(
      `Couldn't record payment ${paymentId} on PayPal invoice ${row.invoice.paypalInvoiceId}: ${(err as Error).message}`,
    );
  }
}

/** Balance settled: stop any plan still billing it. */
async function endPlansFor(ctx: Ctx, invoiceId: number, payingPlanId?: number): Promise<void> {
  const open = ctx.db
    .select()
    .from(paymentPlans)
    .where(
      and(
        eq(paymentPlans.invoiceId, invoiceId),
        inArray(paymentPlans.status, ['pending', 'active']),
      ),
    )
    .all();
  for (const plan of open) {
    // A plan that just made its last payment ends on its own; anything else is cancelled.
    if (plan.paypalSubscriptionId && plan.id !== payingPlanId && ctx.paypal.api) {
      try {
        await ctx.paypal.api.cancelSubscription(plan.paypalSubscriptionId, 'Balance paid in full');
      } catch (err) {
        ctx.log.warn(
          `Couldn't cancel subscription ${plan.paypalSubscriptionId}: ${(err as Error).message}`,
        );
      }
    }
    ctx.db
      .update(paymentPlans)
      .set({
        status: plan.id === payingPlanId ? 'completed' : 'cancelled',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(paymentPlans.id, plan.id))
      .run();
  }
}

// ── Reconciliation (also what webhooks trigger) ─────────────────────────────

/** Pull one PayPal invoice and record any payments made on PayPal's own invoice page. */
export async function reconcileInvoice(ctx: Ctx, invoiceId: number): Promise<number> {
  const api = ctx.paypal.api;
  const invoice = ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId)).get();
  if (!api || !invoice?.paypalInvoiceId) return 0;
  const remote: PayPalInvoice = await api.getInvoice(invoice.paypalInvoiceId);
  if (remote.status !== invoice.paypalStatus) {
    ctx.db
      .update(invoices)
      .set({ paypalStatus: remote.status })
      .where(eq(invoices.id, invoiceId))
      .run();
  }
  let recorded = 0;
  for (const txn of remote.payments?.transactions ?? []) {
    const id = txn.payment_id;
    if (!id || !txn.amount) continue;
    const known = ctx.db
      .select({ id: payments.id })
      .from(payments)
      .where(sql`${payments.externalId} = ${id} OR ${payments.paypalInvoiceTxnId} = ${id}`)
      .get();
    // EXTERNAL entries are payments recorded by hand in PayPal (or our own copies, already known).
    if (known || txn.type === 'EXTERNAL') continue;
    const { result } = await applyPayPalPayment(ctx, {
      invoiceId,
      externalId: id,
      amountCents: fromPayPalMoney(txn.amount),
      source: 'paypal-invoice',
    });
    if (result) recorded++;
  }
  return recorded;
}

/** Pull one subscription: activation, cancellation, and any installments PayPal collected. */
export async function reconcilePlan(ctx: Ctx, planId: number): Promise<number> {
  const api = ctx.paypal.api;
  const plan = ctx.db.select().from(paymentPlans).where(eq(paymentPlans.id, planId)).get();
  if (!api || !plan?.paypalSubscriptionId) return 0;
  const sub = await api.getSubscription(plan.paypalSubscriptionId);
  const now = new Date().toISOString();
  const status =
    sub.status === 'ACTIVE'
      ? 'active'
      : sub.status === 'CANCELLED' || sub.status === 'SUSPENDED'
        ? 'cancelled'
        : sub.status === 'EXPIRED'
          ? 'completed'
          : plan.status;
  if (status !== plan.status) {
    ctx.db
      .update(paymentPlans)
      .set({
        status,
        startedOn: plan.startedOn ?? (status === 'active' ? ctx.today() : null),
        updatedAt: now,
      })
      .where(eq(paymentPlans.id, planId))
      .run();
  }
  if (sub.status === 'APPROVAL_PENDING') return 0;
  const start = new Date(Date.parse(plan.createdAt) - 86_400_000).toISOString();
  const end = new Date(Date.now() + 86_400_000).toISOString();
  const txns = await api.listSubscriptionTransactions(plan.paypalSubscriptionId, start, end);
  let recorded = 0;
  for (const t of txns) {
    if (t.status !== 'COMPLETED') continue;
    const { result } = await applyPayPalPayment(ctx, {
      invoiceId: plan.invoiceId,
      externalId: t.id,
      amountCents: fromPayPalMoney(t.amount_with_breakdown.gross_amount),
      source: 'paypal-plan',
      planId,
    });
    if (result) recorded++;
  }
  return recorded;
}

export type OrderRow = typeof paypalOrders.$inferSelect;

/**
 * Capture an approved order and record the payment (idempotent). Call inside `ctx.queue.run`.
 * PayPal's "already captured" is treated as success; a declined card throws the PayPalError.
 */
export async function captureApprovedOrder(
  ctx: Ctx,
  order: OrderRow,
): Promise<{ paymentId: number | null; pending: boolean }> {
  const api = ctx.paypal.api!;
  const fresh = ctx.db.select().from(paypalOrders).where(eq(paypalOrders.id, order.id)).get();
  if (fresh?.captureId) {
    const paid = ctx.db
      .select()
      .from(payments)
      .where(eq(payments.externalId, fresh.captureId))
      .get();
    return { paymentId: paid?.id ?? null, pending: !paid };
  }
  let result;
  try {
    result = await api.captureOrder(order.id, `pb-capture-${order.id}`);
  } catch (err) {
    if (!isAlreadyDone(err, 'ORDER_ALREADY_CAPTURED')) throw err;
    result = await api.getOrder(order.id);
  }
  const capture = result.purchase_units?.[0]?.payments?.captures?.[0];
  if (!capture) throw new Error(`PayPal order ${order.id} has no capture.`);
  if (capture.status === 'PENDING') return { paymentId: null, pending: true };
  if (capture.status !== 'COMPLETED') {
    throw new Error(`PayPal capture ${capture.id} is ${capture.status}.`);
  }
  await applyPayPalPayment(ctx, {
    invoiceId: order.invoiceId,
    externalId: capture.id,
    amountCents: fromPayPalMoney(capture.amount),
    source: 'paypal-checkout',
  });
  markOrderCaptured(ctx, order.id, capture.id);
  const paid = ctx.db.select().from(payments).where(eq(payments.externalId, capture.id)).get();
  return { paymentId: paid?.id ?? null, pending: false };
}

/** Orders approved in PayPal but never captured (the page closed mid-way): capture them. */
async function captureStrandedOrder(ctx: Ctx, order: OrderRow): Promise<number> {
  const remote = await ctx.paypal.api!.getOrder(order.id);
  if (remote.status !== 'APPROVED') return 0;
  const { paymentId } = await captureApprovedOrder(ctx, order);
  return paymentId ? 1 : 0;
}

/** One reconciliation pass over every open PayPal invoice and plan. */
export async function syncOpenItems(ctx: Ctx): Promise<{ recorded: number; errors: number }> {
  if (!ctx.paypal.api) return { recorded: 0, errors: 0 };
  let recorded = 0;
  let errors = 0;
  const openInvoices = ctx.db
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.status, 'sent'), eq(invoices.sentVia, 'paypal')))
    .all();
  const openPlans = ctx.db
    .select({ id: paymentPlans.id })
    .from(paymentPlans)
    .where(inArray(paymentPlans.status, ['pending', 'active']))
    .all();
  // Copies that didn't reach PayPal last time.
  const unmirrored = ctx.db
    .select({ id: payments.id })
    .from(payments)
    .innerJoin(invoices, eq(payments.invoiceId, invoices.id))
    .where(
      and(
        inArray(payments.source, ['paypal-checkout', 'paypal-plan']),
        isNull(payments.paypalInvoiceTxnId),
        sql`${invoices.paypalInvoiceId} IS NOT NULL`,
      ),
    )
    .all();
  // PayPal keeps an approved order capturable for a few hours.
  const since = new Date(Date.now() - 3 * 3600_000).toISOString();
  const stranded = ctx.db
    .select()
    .from(paypalOrders)
    .where(and(eq(paypalOrders.status, 'created'), sql`${paypalOrders.createdAt} >= ${since}`))
    .all();
  const jobs: Array<() => Promise<number | void>> = [
    ...stranded.map((o) => () => captureStrandedOrder(ctx, o)),
    ...openInvoices.map(
      ({ id }) =>
        () =>
          reconcileInvoice(ctx, id),
    ),
    ...openPlans.map(
      ({ id }) =>
        () =>
          reconcilePlan(ctx, id),
    ),
    ...unmirrored.map(
      ({ id }) =>
        () =>
          mirrorToPayPalInvoice(ctx, id),
    ),
  ];
  for (const job of jobs) {
    try {
      recorded += (await ctx.queue.run(job)) ?? 0;
    } catch (err) {
      errors++;
      ctx.log.warn(`PayPal sync: ${(err as Error).message}`);
    }
  }
  return { recorded, errors };
}

/** Poll PayPal every `seconds` (webhooks can't reach localhost; they can also be missed). */
export function startPayPalSync(ctx: Ctx, seconds: number): () => void {
  if (!ctx.paypal.api || seconds <= 0) return () => {};
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    syncOpenItems(ctx)
      .catch((err: Error) => ctx.log.warn(`PayPal sync failed: ${err.message}`))
      .finally(() => (running = false));
  }, seconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

// ── Webhooks ────────────────────────────────────────────────────────────────

/** Events we act on: invoice and capture payments, plan activation, plan installments and lifecycle. */
export const HANDLED_EVENTS = [
  'INVOICING.INVOICE.PAID',
  'INVOICING.INVOICE.UPDATED',
  'PAYMENT.CAPTURE.COMPLETED',
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.EXPIRED',
  'BILLING.SUBSCRIPTION.SUSPENDED',
  'PAYMENT.SALE.COMPLETED',
] as const;

export type WebhookOutcome = 'processed' | 'ignored' | 'duplicate';

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const obj = (v: unknown) =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;

/** Handle a webhook that has already passed signature verification. */
export async function handleWebhookEvent(ctx: Ctx, event: WebhookEvent): Promise<WebhookOutcome> {
  const { db } = ctx;
  if (db.select().from(webhookEvents).where(eq(webhookEvents.id, event.id)).get()) {
    return 'duplicate';
  }
  const resource = event.resource ?? {};
  const resourceId = str(resource.id) ?? str(obj(resource.invoice)?.id) ?? null;
  const save = (status: 'processed' | 'ignored' | 'failed', detail: string | null) =>
    db
      .insert(webhookEvents)
      .values({
        id: event.id,
        eventType: event.event_type,
        resourceId,
        status,
        detail,
        receivedAt: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();

  try {
    const detail = await ctx.queue.run(() => dispatch(ctx, event.event_type, resource));
    save(detail === null ? 'ignored' : 'processed', detail);
    return detail === null ? 'ignored' : 'processed';
  } catch (err) {
    save('failed', (err as Error).message);
    throw err;
  }
}

/** Returns a short note on what happened, or null when the event isn't ours / not handled. */
async function dispatch(
  ctx: Ctx,
  type: string,
  resource: Record<string, unknown>,
): Promise<string | null> {
  const { db } = ctx;
  switch (type) {
    case 'INVOICING.INVOICE.PAID':
    case 'INVOICING.INVOICE.UPDATED': {
      const paypalId = str(obj(resource.invoice)?.id) ?? str(resource.id);
      const invoice = paypalId
        ? db.select().from(invoices).where(eq(invoices.paypalInvoiceId, paypalId)).get()
        : undefined;
      if (!invoice) return null;
      const n = await reconcileInvoice(ctx, invoice.id);
      return `invoice ${invoice.id}: ${n} new payment(s)`;
    }
    case 'PAYMENT.CAPTURE.COMPLETED': {
      const captureId = str(resource.id);
      const orderId = str(obj(obj(resource.supplementary_data)?.related_ids)?.order_id);
      const order = orderId
        ? db.select().from(paypalOrders).where(eq(paypalOrders.id, orderId)).get()
        : undefined;
      if (order && captureId) {
        const { result } = await applyPayPalPayment(ctx, {
          invoiceId: order.invoiceId,
          externalId: captureId,
          amountCents: fromPayPalMoney(resource.amount as { currency_code: string; value: string }),
          source: 'paypal-checkout',
        });
        markOrderCaptured(ctx, order.id, captureId);
        return `order ${order.id}: ${result ? 'recorded' : 'already recorded'}`;
      }
      // Not a patient-page order: it may be a payment on a PayPal invoice page.
      const openPayPal = db
        .select({ id: invoices.id })
        .from(invoices)
        .where(and(eq(invoices.status, 'sent'), eq(invoices.sentVia, 'paypal')))
        .all();
      let n = 0;
      for (const { id } of openPayPal) n += await reconcileInvoice(ctx, id);
      return n ? `${n} invoice payment(s)` : null;
    }
    case 'BILLING.SUBSCRIPTION.ACTIVATED':
    case 'BILLING.SUBSCRIPTION.CANCELLED':
    case 'BILLING.SUBSCRIPTION.EXPIRED':
    case 'BILLING.SUBSCRIPTION.SUSPENDED': {
      const plan = planForSubscription(ctx, str(resource.id));
      if (!plan) return null;
      const n = await reconcilePlan(ctx, plan.id);
      return `plan ${plan.id}: ${n} new payment(s)`;
    }
    case 'PAYMENT.SALE.COMPLETED': {
      const plan = planForSubscription(ctx, str(resource.billing_agreement_id));
      const saleId = str(resource.id);
      const amount = obj(resource.amount);
      if (!plan || !saleId || !amount) return null;
      const { result } = await applyPayPalPayment(ctx, {
        invoiceId: plan.invoiceId,
        externalId: saleId,
        // v1 sale amounts are { total, currency }.
        amountCents: fromPayPalMoney({
          currency_code: str(amount.currency) ?? 'USD',
          value: str(amount.total) ?? '0',
        }),
        source: 'paypal-plan',
        planId: plan.id,
      });
      return `plan ${plan.id}: ${result ? 'recorded' : 'already recorded'}`;
    }
    default:
      return null;
  }
}

function planForSubscription(ctx: Ctx, subscriptionId: string | undefined) {
  if (!subscriptionId) return undefined;
  return ctx.db
    .select()
    .from(paymentPlans)
    .where(eq(paymentPlans.paypalSubscriptionId, subscriptionId))
    .get();
}

export function markOrderCaptured(ctx: Pick<Ctx, 'db'>, orderId: string, captureId: string) {
  ctx.db
    .update(paypalOrders)
    .set({ status: 'captured', captureId, capturedAt: new Date().toISOString() })
    .where(and(eq(paypalOrders.id, orderId), eq(paypalOrders.status, 'created')))
    .run();
}

/** True for PayPal's "already done" answers, which a retry should treat as success. */
export function isAlreadyDone(err: unknown, issue: string): boolean {
  return err instanceof PayPalError && err.issue === issue;
}
