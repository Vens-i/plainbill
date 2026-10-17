/**
 * In-memory stand-in for PayPal, for tests and offline rehearsals. It mirrors what the sandbox
 * actually did when we tried it (see "How Plainbill uses PayPal" in the README): invoices read UNPAID after send,
 * recorded payments get "EXTR-" ids, capturing twice fails with ORDER_ALREADY_CAPTURED, and a
 * subscription's first installment is collected when the payer approves.
 *
 * The `payer*` helpers play the patient's part (approving in PayPal's window).
 */
import { fromPayPalMoney, PayPalError, toPayPalMoney, type PayPalApi } from './client';
import type {
  CreateInvoiceBody,
  CreateOrderBody,
  CreatePlanBody,
  CreateSubscriptionBody,
  InvoiceTransaction,
  PayPalInvoice,
  PayPalOrder,
  PayPalSubscription,
  RecordInvoicePaymentBody,
  SubscriptionTransaction,
  WebhookHeaders,
} from './types';

interface FakeInvoice {
  id: string;
  number: string;
  status: 'DRAFT' | 'SENT';
  body: CreateInvoiceBody;
  amountCents: number;
  transactions: InvoiceTransaction[];
}

interface FakeOrder {
  id: string;
  body: CreateOrderBody;
  amountCents: number;
  status: 'CREATED' | 'APPROVED' | 'COMPLETED';
  captureId: string | null;
}

interface FakeSubscription {
  id: string;
  planId: string;
  customId: string;
  status: 'APPROVAL_PENDING' | 'ACTIVE' | 'CANCELLED' | 'EXPIRED';
  transactions: SubscriptionTransaction[];
}

export class FakePayPal implements PayPalApi {
  readonly env = 'sandbox' as const;
  readonly calls: string[] = [];
  readonly invoices = new Map<string, FakeInvoice>();
  readonly orders = new Map<string, FakeOrder>();
  readonly plans = new Map<string, CreatePlanBody>();
  readonly subscriptions = new Map<string, FakeSubscription>();
  /** What verifyWebhookSignature answers. */
  signatureValid = true;
  /** Make the next createInvoice fail (e.g. to test that a failed send changes nothing). */
  failNextInvoice: PayPalError | null = null;
  /** Make the next sendInvoice fail after the draft exists (a retry must reuse the draft). */
  failNextSend: PayPalError | null = null;
  declineNextCapture = false;
  private seq = 0;

  private next(prefix: string) {
    this.seq += 1;
    return `${prefix}${String(this.seq).padStart(4, '0')}`;
  }

  // ── Invoicing ──
  async createInvoice(body: CreateInvoiceBody): Promise<PayPalInvoice> {
    this.calls.push('createInvoice');
    if (this.failNextInvoice) {
      const err = this.failNextInvoice;
      this.failNextInvoice = null;
      throw err;
    }
    const id = this.next('INV2-FAKE-');
    const number = String(this.invoices.size + 1).padStart(4, '0');
    const amountCents = body.items.reduce((s, i) => s + fromPayPalMoney(i.unit_amount), 0);
    this.invoices.set(id, { id, number, status: 'DRAFT', body, amountCents, transactions: [] });
    return this.invoiceView(this.invoices.get(id)!);
  }

  async sendInvoice(invoiceId: string) {
    this.calls.push('sendInvoice');
    if (this.failNextSend) {
      const err = this.failNextSend;
      this.failNextSend = null;
      throw err;
    }
    const inv = this.invoice(invoiceId);
    if (inv.status !== 'DRAFT') {
      throw new PayPalError(
        422,
        'UNPROCESSABLE_ENTITY',
        'Invoice already sent.',
        'INVALID_INVOICE_STATUS',
        null,
      );
    }
    inv.status = 'SENT';
    return {
      href: `https://www.sandbox.paypal.com/invoice/p/#${invoiceId}`,
      rel: 'payer-view',
      method: 'GET',
    };
  }

  async getInvoice(invoiceId: string) {
    this.calls.push('getInvoice');
    return this.invoiceView(this.invoice(invoiceId));
  }

  async recordInvoicePayment(invoiceId: string, body: RecordInvoicePaymentBody) {
    this.calls.push('recordInvoicePayment');
    const inv = this.invoice(invoiceId);
    const cents = fromPayPalMoney(body.amount);
    if (cents > this.dueCents(inv)) {
      throw new PayPalError(
        422,
        'UNPROCESSABLE_ENTITY',
        'Amount exceeds due.',
        'AMOUNT_EXCEEDS_DUE',
        null,
      );
    }
    const id = this.next('EXTR-');
    inv.transactions.push({
      type: 'EXTERNAL',
      payment_id: id,
      payment_date: body.payment_date,
      method: body.method,
      amount: body.amount,
      ...(body.note ? { note: body.note } : {}),
    });
    return id;
  }

  /** The patient pays on PayPal's own invoice page. */
  payerPaysInvoice(invoiceId: string, cents: number): string {
    const inv = this.invoice(invoiceId);
    const id = this.next('TXN-');
    inv.transactions.push({
      type: 'PAYPAL',
      payment_id: id,
      payment_date: '2026-10-10',
      method: 'PAYPAL',
      amount: toPayPalMoney(cents),
    });
    return id;
  }

  private invoice(id: string) {
    const inv = this.invoices.get(id);
    if (!inv)
      throw new PayPalError(
        404,
        'RESOURCE_NOT_FOUND',
        'No such invoice.',
        'INVALID_RESOURCE_ID',
        null,
      );
    return inv;
  }

  private dueCents(inv: FakeInvoice) {
    return inv.amountCents - inv.transactions.reduce((s, t) => s + fromPayPalMoney(t.amount), 0);
  }

  private invoiceView(inv: FakeInvoice): PayPalInvoice {
    const due = this.dueCents(inv);
    const paid = inv.amountCents - due;
    const allExternal = inv.transactions.every((t) => t.type === 'EXTERNAL');
    const status =
      inv.status === 'DRAFT'
        ? 'DRAFT'
        : due === 0
          ? allExternal
            ? 'MARKED_AS_PAID'
            : 'PAID'
          : paid > 0
            ? 'PARTIALLY_PAID'
            : 'UNPAID';
    return {
      id: inv.id,
      status,
      detail: {
        invoice_number: inv.number,
        metadata: { recipient_view_url: `https://www.sandbox.paypal.com/invoice/p/#${inv.id}` },
      },
      amount: toPayPalMoney(inv.amountCents),
      due_amount: toPayPalMoney(due),
      payments: { paid_amount: toPayPalMoney(paid), transactions: [...inv.transactions] },
    };
  }

  // ── Orders ──
  async createOrder(body: CreateOrderBody) {
    this.calls.push('createOrder');
    const id = this.next('ORDER-');
    const amountCents = fromPayPalMoney(body.purchase_units[0]!.amount);
    this.orders.set(id, { id, body, amountCents, status: 'CREATED', captureId: null });
    return { id, status: 'CREATED' };
  }

  /** The patient approves the order in PayPal's window. */
  payerApprovesOrder(orderId: string) {
    this.order(orderId).status = 'APPROVED';
  }

  async captureOrder(orderId: string) {
    this.calls.push('captureOrder');
    const order = this.order(orderId);
    if (order.status === 'COMPLETED') {
      throw new PayPalError(
        422,
        'UNPROCESSABLE_ENTITY',
        'Order already captured.',
        'ORDER_ALREADY_CAPTURED',
        null,
      );
    }
    if (order.status !== 'APPROVED') {
      throw new PayPalError(
        422,
        'UNPROCESSABLE_ENTITY',
        'Payer has not approved.',
        'ORDER_NOT_APPROVED',
        null,
      );
    }
    if (this.declineNextCapture) {
      this.declineNextCapture = false;
      throw new PayPalError(
        422,
        'UNPROCESSABLE_ENTITY',
        'Instrument declined.',
        'INSTRUMENT_DECLINED',
        null,
      );
    }
    order.status = 'COMPLETED';
    order.captureId = this.next('CAP-');
    return this.orderView(order);
  }

  async getOrder(orderId: string) {
    this.calls.push('getOrder');
    return this.orderView(this.order(orderId));
  }

  private order(id: string) {
    const order = this.orders.get(id);
    if (!order)
      throw new PayPalError(
        404,
        'RESOURCE_NOT_FOUND',
        'No such order.',
        'INVALID_RESOURCE_ID',
        null,
      );
    return order;
  }

  private orderView(order: FakeOrder): PayPalOrder {
    const unit = order.body.purchase_units[0]!;
    return {
      id: order.id,
      status: order.status,
      purchase_units: [
        {
          reference_id: unit.reference_id,
          custom_id: unit.custom_id,
          amount: unit.amount,
          payments: order.captureId
            ? {
                captures: [
                  {
                    id: order.captureId,
                    status: 'COMPLETED',
                    amount: unit.amount,
                    custom_id: unit.custom_id,
                    supplementary_data: { related_ids: { order_id: order.id } },
                  },
                ],
              }
            : {},
        },
      ],
    };
  }

  // ── Subscriptions ──
  async createProduct() {
    this.calls.push('createProduct');
    return this.next('PROD-');
  }

  async createPlan(body: CreatePlanBody) {
    this.calls.push('createPlan');
    const id = this.next('P-');
    this.plans.set(id, body);
    return id;
  }

  async createSubscription(body: CreateSubscriptionBody) {
    this.calls.push('createSubscription');
    const id = this.next('I-');
    this.subscriptions.set(id, {
      id,
      planId: body.plan_id,
      customId: body.custom_id,
      status: 'APPROVAL_PENDING',
      transactions: [],
    });
    return this.subscriptionView(this.subscriptions.get(id)!);
  }

  /** The patient approves the plan; PayPal collects the first cycle right away. */
  payerApprovesSubscription(subscriptionId: string): string {
    const sub = this.subscription(subscriptionId);
    sub.status = 'ACTIVE';
    return this.collectNextCycle(subscriptionId);
  }

  /** PayPal bills the next cycle (a month later, in real life). Returns the sale id. */
  collectNextCycle(subscriptionId: string): string {
    const sub = this.subscription(subscriptionId);
    const cycles = this.plans.get(sub.planId)!.billing_cycles;
    const prices = cycles.flatMap((c) =>
      Array.from({ length: c.total_cycles }, () => c.pricing_scheme.fixed_price),
    );
    const price = prices[sub.transactions.length];
    if (!price) throw new Error('Plan has no cycles left.');
    const id = this.next('SALE-');
    sub.transactions.push({
      id,
      status: 'COMPLETED',
      amount_with_breakdown: { gross_amount: price },
      time: new Date().toISOString(),
    });
    if (sub.transactions.length === prices.length) sub.status = 'EXPIRED';
    return id;
  }

  async getSubscription(subscriptionId: string) {
    this.calls.push('getSubscription');
    return this.subscriptionView(this.subscription(subscriptionId));
  }

  async cancelSubscription(subscriptionId: string) {
    this.calls.push('cancelSubscription');
    this.subscription(subscriptionId).status = 'CANCELLED';
  }

  async listSubscriptionTransactions(subscriptionId: string) {
    this.calls.push('listSubscriptionTransactions');
    return [...this.subscription(subscriptionId).transactions];
  }

  private subscription(id: string) {
    const sub = this.subscriptions.get(id);
    if (!sub)
      throw new PayPalError(
        404,
        'RESOURCE_NOT_FOUND',
        'No such subscription.',
        'INVALID_RESOURCE_ID',
        null,
      );
    return sub;
  }

  private subscriptionView(sub: FakeSubscription): PayPalSubscription {
    return { id: sub.id, status: sub.status, plan_id: sub.planId, custom_id: sub.customId };
  }

  // ── Webhooks ──
  readonly verified: Array<{ headers: WebhookHeaders; rawBody: string; webhookId: string }> = [];

  async verifyWebhookSignature(headers: WebhookHeaders, rawBody: string, webhookId: string) {
    this.calls.push('verifyWebhookSignature');
    this.verified.push({ headers, rawBody, webhookId });
    return this.signatureValid;
  }
}
