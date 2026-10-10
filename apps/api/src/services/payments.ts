/**
 * Payments and invoice sends. Every status change goes through @plainbill/core's status
 * machine, so an impossible move (paying a denied claim, re-paying a paid balance) throws
 * InvalidTransitionError instead of corrupting data.
 */
import { and, desc, eq } from 'drizzle-orm';
import { addDays, nextStatus, type BalanceStatus, type IsoDate } from '@plainbill/core';
import type { Db, DbLike } from '../db/client';
import {
  balances,
  events,
  invoices,
  payments,
  visits,
  type PaymentOptionJson,
  type PaymentSource,
} from '../db/schema';

export class PaymentError extends Error {
  override name = 'PaymentError';
}

function loadBalance(db: DbLike, balanceId: number) {
  const balance = db.select().from(balances).where(eq(balances.id, balanceId)).get();
  if (!balance) throw new PaymentError(`Balance ${balanceId} does not exist.`);
  return balance;
}

export interface RecordPaymentInput {
  /** Defaults to the full remaining balance. */
  amountCents?: number;
  method: 'paypal' | 'card' | 'cash';
  source: PaymentSource;
  /** PayPal's id for the money movement. A second payment with the same id is a no-op. */
  externalId?: string;
  planId?: number;
  /** Calendar date the payment counts toward (demo-aware "today"). */
  postedOn: IsoDate;
  /** Wall-clock arrival time. */
  receivedAt: string;
}

export interface RecordPaymentResult {
  paymentId: number;
  eventId: number;
  status: BalanceStatus;
  amountCents: number;
  remainingCents: number;
  /** True when this externalId was already recorded; nothing changed. */
  duplicate: boolean;
}

export function recordPayment(
  db: Db,
  balanceId: number,
  input: RecordPaymentInput,
): RecordPaymentResult {
  return db.transaction((tx) => {
    const balance = loadBalance(tx, balanceId);
    if (input.externalId) {
      const seen = tx
        .select()
        .from(payments)
        .where(eq(payments.externalId, input.externalId))
        .get();
      if (seen) {
        return {
          paymentId: seen.id,
          eventId: 0,
          status: balance.status,
          amountCents: seen.amountCents,
          remainingCents: balance.patientResponsibilityCents - balance.patientPaidCents,
          duplicate: true,
        };
      }
    }
    // Status first: paying a denied, unreviewed or already-paid balance is a state error, not an
    // amount error.
    nextStatus(balance.status, { type: 'payment', remainingCents: 0 });
    const remaining = balance.patientResponsibilityCents - balance.patientPaidCents;
    const amount = input.amountCents ?? remaining;
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new PaymentError(`Payment amount must be a positive number of cents, got ${amount}.`);
    }
    if (amount > remaining) {
      throw new PaymentError(
        `Payment of ${amount} cents exceeds the remaining balance of ${remaining} cents.`,
      );
    }
    const status = nextStatus(balance.status, {
      type: 'payment',
      remainingCents: remaining - amount,
    });

    const invoice = tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.balanceId, balanceId), eq(invoices.status, 'sent')))
      .orderBy(desc(invoices.id))
      .get();

    const paymentId = tx
      .insert(payments)
      .values({
        balanceId,
        invoiceId: invoice?.id ?? null,
        amountCents: amount,
        method: input.method,
        source: input.source,
        externalId: input.externalId ?? null,
        planId: input.planId ?? null,
        postedOn: input.postedOn,
        receivedAt: input.receivedAt,
      })
      .returning({ id: payments.id })
      .get().id;

    tx.update(balances)
      .set({
        status,
        patientPaidCents: balance.patientPaidCents + amount,
        paidOn: status === 'paid' ? input.postedOn : null,
        updatedAt: input.receivedAt,
      })
      .where(eq(balances.id, balanceId))
      .run();

    if (invoice && status === 'paid') {
      tx.update(invoices).set({ status: 'paid' }).where(eq(invoices.id, invoice.id)).run();
    }

    const eventId = tx
      .insert(events)
      .values({
        type: 'payment',
        balanceId,
        payload: {
          paymentId,
          amountCents: amount,
          method: input.method,
          source: input.source,
          status,
        },
        createdAt: input.receivedAt,
      })
      .returning({ id: events.id })
      .get().id;

    return {
      paymentId,
      eventId,
      status,
      amountCents: amount,
      remainingCents: remaining - amount,
      duplicate: false,
    };
  });
}

export interface SendInvoiceInput {
  sentOn: IsoDate;
  /** Defaults to 30 days after the visit. */
  dueDate?: IsoDate;
  openCount?: number;
  message?: string;
  messageSource?: 'ai' | 'template' | 'edited';
  paymentOption?: PaymentOptionJson;
  /** Token for the patient's /pay/:token link. */
  payToken?: string;
  /** Set when PayPal accepted the invoice; omitted when PayPal isn't configured. */
  paypal?: { invoiceId: string; number: string | null; status: string; payerUrl: string };
  now: string;
}

/**
 * Record that an invoice went out: the seed calls it directly, and the send flow calls it after
 * PayPal has accepted the invoice.
 */
export function markInvoiceSent(
  db: Db,
  balanceId: number,
  input: SendInvoiceInput,
): { invoiceId: number } {
  return db.transaction((tx) => {
    const balance = loadBalance(tx, balanceId);
    const status = nextStatus(balance.status, { type: 'send' });
    const visit = tx.select().from(visits).where(eq(visits.id, balance.visitId)).get()!;
    const values = {
      balanceId,
      status: 'sent' as const,
      amountCents: balance.patientResponsibilityCents - balance.patientPaidCents,
      sentOn: input.sentOn,
      dueDate: input.dueDate ?? addDays(visit.serviceDate, 30),
      openCount: input.openCount ?? 0,
      message: input.message ?? null,
      messageSource: input.messageSource ?? null,
      paymentOption: input.paymentOption ?? null,
      payToken: input.payToken ?? null,
      sentVia: input.paypal ? ('paypal' as const) : ('local' as const),
      ...(input.paypal
        ? {
            paypalInvoiceId: input.paypal.invoiceId,
            paypalInvoiceNumber: input.paypal.number,
            paypalStatus: input.paypal.status,
            paypalPayerUrl: input.paypal.payerUrl,
          }
        : {}),
    };
    // A saved draft becomes the sent invoice; otherwise create one.
    const draft = tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.balanceId, balanceId), eq(invoices.status, 'draft')))
      .get();
    const invoiceId = draft
      ? (tx.update(invoices).set(values).where(eq(invoices.id, draft.id)).run(), draft.id)
      : tx.insert(invoices).values(values).returning({ id: invoices.id }).get().id;
    tx.update(balances)
      .set({ status, updatedAt: input.now })
      .where(eq(balances.id, balanceId))
      .run();
    tx.insert(events)
      .values({ type: 'invoice.sent', balanceId, payload: { invoiceId }, createdAt: input.now })
      .run();
    return { invoiceId };
  });
}
