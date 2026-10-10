/**
 * Payments and invoice sends. Every status change goes through @plainbill/core's status
 * machine, so an impossible move (paying a denied claim, re-paying a paid balance) throws
 * InvalidTransitionError instead of corrupting data.
 */
import { and, desc, eq } from 'drizzle-orm';
import { addDays, nextStatus, type BalanceStatus, type IsoDate } from '@plainbill/core';
import type { Db, DbLike } from '../db/client';
import { balances, events, invoices, payments, visits } from '../db/schema';

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
  source: 'seed' | 'simulated' | 'paypal-webhook' | 'manual';
  externalId?: string;
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
}

export function recordPayment(
  db: Db,
  balanceId: number,
  input: RecordPaymentInput,
): RecordPaymentResult {
  return db.transaction((tx) => {
    const balance = loadBalance(tx, balanceId);
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

    return { paymentId, eventId, status, amountCents: amount, remainingCents: remaining - amount };
  });
}

export interface SendInvoiceInput {
  sentOn: IsoDate;
  /** Defaults to 30 days after the visit. */
  dueDate?: IsoDate;
  openCount?: number;
  now: string;
}

/**
 * Record that an invoice went out. Phase 1 only uses this from the seed; the PayPal Invoicing
 * send flow (Phase 2+) will call it after PayPal accepts the invoice.
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
    const invoiceId = tx
      .insert(invoices)
      .values({
        balanceId,
        status: 'sent',
        amountCents: balance.patientResponsibilityCents - balance.patientPaidCents,
        sentOn: input.sentOn,
        dueDate: input.dueDate ?? addDays(visit.serviceDate, 30),
        openCount: input.openCount ?? 0,
      })
      .returning({ id: invoices.id })
      .get().id;
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
