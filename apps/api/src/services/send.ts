/**
 * "Send invoice": PayPal Invoicing v2 + our own email.
 *
 * 1. Create (or reuse) a PayPal draft invoice: the patient's name only, one line "Services on
 *    Oct 3, 2026 with Dr. Patel", no email address (so PayPal sends nothing), partial payments
 *    with a $20 minimum when staff picked that option.
 * 2. Send it with PayPal's emails off; PayPal returns the payer-view link.
 * 3. Mark the balance Sent and issue the patient's /pay/:token link.
 * 4. Email the patient (Resend, or the outbox when no provider is configured).
 *
 * If PayPal refuses, nothing changes and staff see why. If only the email fails, the invoice
 * stays sent and the failure is reported (the email can be viewed and resent).
 */
import { asc, desc, eq } from 'drizzle-orm';
import {
  formatLongDate,
  formatMoneyShort,
  formatMonthDay,
  planOption,
  type IsoDate,
} from '@plainbill/core';
import type { BalanceRow, EmailPreview, ReminderResult, SendResult } from '../contract';
import { balances, emails, events, invoices, patients, practices, visits } from '../db/schema';
import { PayPalError, toPayPalMoney } from '../paypal/client';
import type { CreateInvoiceBody } from '../paypal/types';
import { getBalanceRows } from '../queries/rows';
import type { RouteContext } from '../routes/context';
import {
  balanceRow,
  checkAmounts,
  DrawerError,
  dueDateFor,
  maskEmail,
  saveDraft,
  validateOption,
  type DraftInput,
} from './drawer';
import { renderBillEmail, type BillEmailData, type RenderedEmail } from './email';
import { markInvoiceSent } from './payments';
import { newPayToken, payUrl } from './sessions';

type Ctx = Pick<RouteContext, 'db' | 'today' | 'paypal' | 'email' | 'appBaseUrl' | 'log'>;

function practiceRow(ctx: Ctx) {
  return ctx.db.select().from(practices).orderBy(asc(practices.id)).get()!;
}

function patientFor(ctx: Ctx, balanceId: number) {
  return ctx.db
    .select({ patient: patients })
    .from(balances)
    .innerJoin(visits, eq(balances.visitId, visits.id))
    .innerJoin(patients, eq(visits.patientId, patients.id))
    .where(eq(balances.id, balanceId))
    .get()!.patient;
}

/** "Services on Oct 3, 2026 with Dr. Patel" — all PayPal ever learns about the visit. */
export function serviceLine(r: BalanceRow, practiceName: string): string {
  return `Services on ${formatLongDate(r.visitDate)} ${r.provider ? `with ${r.provider}` : `at ${practiceName}`}`;
}

export function paypalInvoiceBody(
  r: BalanceRow,
  practice: { name: string; phone: string },
  patient: { firstName: string; lastName: string },
  option: DraftInput['paymentOption'],
  today: IsoDate,
  dueDate: IsoDate,
): CreateInvoiceBody {
  return {
    detail: {
      currency_code: 'USD',
      invoice_date: today,
      payment_term: { due_date: dueDate },
      note: `Questions about this bill? Call ${practice.name} at ${practice.phone}.`,
      memo: `Plainbill balance ${r.id}`,
    },
    invoicer: { business_name: practice.name },
    primary_recipients: [
      { billing_info: { name: { given_name: patient.firstName, surname: patient.lastName } } },
    ],
    items: [
      {
        name: serviceLine(r, practice.name),
        quantity: '1',
        unit_amount: toPayPalMoney(r.remainingCents),
        unit_of_measure: 'AMOUNT',
      },
    ],
    configuration: {
      allow_tip: false,
      partial_payment:
        option.type === 'partial'
          ? {
              allow_partial_payment: true,
              minimum_amount_due: toPayPalMoney(option.minimumCents),
            }
          : { allow_partial_payment: false },
    },
  };
}

/** Create-or-reuse the PayPal draft, then send it. Returns what markInvoiceSent stores. */
async function issuePayPalInvoice(
  ctx: Ctx,
  draftId: number,
  body: CreateInvoiceBody,
): Promise<{ invoiceId: string; number: string | null; status: string; payerUrl: string }> {
  const api = ctx.paypal.api!;
  const draft = ctx.db.select().from(invoices).where(eq(invoices.id, draftId)).get()!;
  let paypalId = draft.paypalInvoiceId;
  let number = draft.paypalInvoiceNumber;
  if (!paypalId) {
    const created = await api.createInvoice(body);
    paypalId = created.id;
    number = created.detail?.invoice_number ?? null;
    // Saved right away: Invoicing has no idempotency key, so a retry must reuse this draft.
    ctx.db
      .update(invoices)
      .set({ paypalInvoiceId: paypalId, paypalInvoiceNumber: number, paypalStatus: created.status })
      .where(eq(invoices.id, draftId))
      .run();
  }
  const current = await api.getInvoice(paypalId);
  if (current.status === 'DRAFT') {
    const link = await api.sendInvoice(paypalId);
    const after = await api.getInvoice(paypalId);
    return { invoiceId: paypalId, number, status: after.status, payerUrl: link.href };
  }
  // Sent on an earlier attempt that failed afterwards.
  const viewUrl = current.detail?.metadata?.recipient_view_url;
  if (!viewUrl) throw new DrawerError(`PayPal invoice ${paypalId} is ${current.status}.`, 409);
  return { invoiceId: paypalId, number, status: current.status, payerUrl: viewUrl };
}

export function billEmailData(
  ctx: Ctx,
  r: BalanceRow,
  invoice: {
    message: string | null;
    dueDate: string | null;
    payToken: string | null;
    paypalPayerUrl: string | null;
    paymentOption: DraftInput['paymentOption'] | null;
  },
): BillEmailData {
  const practice = practiceRow(ctx);
  const breakdownUrl = invoice.payToken ? payUrl(ctx.appBaseUrl, invoice.payToken) : '#';
  const option = invoice.paymentOption ?? { type: 'full' };
  return {
    practice: {
      name: practice.name,
      phone: practice.phone,
      hours: practice.hours,
      address: [practice.addressLine1, practice.addressLine2].filter(Boolean).join(', '),
    },
    patientFirstName: r.patientFirstName,
    message: invoice.message ?? `Hi ${r.patientFirstName},`,
    visitDate: r.visitDate,
    dueDate: invoice.dueDate ?? dueDateFor(r, ctx.today()),
    billedCents: r.billedCents,
    discountCents: r.contractualCents,
    insurancePaidCents: r.insurancePaidCents,
    alreadyPaidCents: r.patientPaidCents,
    amountDueCents: r.remainingCents,
    selfPay: r.payerKind === 'self-pay',
    paypalUrl: invoice.paypalPayerUrl ?? breakdownUrl,
    breakdownUrl,
    plansAvailable: option.type === 'plan',
    partialMinimumCents: option.type === 'partial' ? option.minimumCents : null,
  };
}

export async function deliverEmail(
  ctx: Ctx,
  invoiceId: number,
  rendered: RenderedEmail,
  intendedTo: string | null,
): Promise<SendResult['email']> {
  const { mailer, toOverride } = ctx.email;
  const base = {
    invoiceId,
    intendedTo,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    provider: mailer.provider,
  };
  const save = (
    status: 'sent' | 'outbox' | 'failed',
    deliveredTo: string | null,
    extra: { providerMessageId?: string | null; error?: string } = {},
  ) => {
    const id = ctx.db
      .insert(emails)
      .values({ ...base, status, deliveredTo, ...extra })
      .returning({ id: emails.id })
      .get().id;
    return { id, status, deliveredTo, provider: mailer.provider, error: extra.error ?? null };
  };

  if (mailer.provider === 'outbox') return save('outbox', null);
  const to = toOverride ?? intendedTo;
  if (!to) return save('failed', null, { error: 'No email address on file for this patient.' });
  try {
    const providerMessageId = await mailer.send({ to, ...rendered });
    return save('sent', to, { providerMessageId });
  } catch (err) {
    ctx.log.warn(`Email for invoice ${invoiceId} failed: ${(err as Error).message}`);
    return save('failed', to, { error: (err as Error).message });
  }
}

export async function sendBalanceInvoice(
  ctx: Ctx,
  balanceId: number,
  input: DraftInput,
  now = new Date().toISOString(),
): Promise<SendResult> {
  const { db } = ctx;
  const today = ctx.today();
  const r = balanceRow(db, balanceId, today);
  if (r.status !== 'ready') {
    throw new DrawerError(
      `Only balances that are ready to invoice can be sent (this one is ${r.status}).`,
      409,
    );
  }
  validateOption(r, input.paymentOption);
  checkAmounts(db, r, input.message);
  if (r.remainingCents <= 0) throw new DrawerError('Nothing is owed on this balance.', 409);

  const message = input.message.trim();
  const draftId = saveDraft(db, balanceId, today, { ...input, message });
  const dueDate = dueDateFor(r, today);
  const practice = practiceRow(ctx);
  const patient = patientFor(ctx, balanceId);

  let paypal: Awaited<ReturnType<typeof issuePayPalInvoice>> | null = null;
  if (ctx.paypal.api) {
    try {
      paypal = await issuePayPalInvoice(
        ctx,
        draftId,
        paypalInvoiceBody(r, practice, patient, input.paymentOption, today, dueDate),
      );
    } catch (err) {
      if (err instanceof DrawerError) throw err;
      const detail =
        err instanceof PayPalError ? `${err.message} (${err.code})` : (err as Error).message;
      ctx.log.error(`PayPal invoice for balance ${balanceId} failed: ${detail}`);
      throw new DrawerError(`PayPal didn't accept the invoice: ${detail}`, 502);
    }
  }

  const payToken = newPayToken();
  const { invoiceId } = markInvoiceSent(db, balanceId, {
    sentOn: today,
    dueDate,
    message,
    messageSource: input.messageSource,
    paymentOption: input.paymentOption,
    payToken,
    ...(paypal ? { paypal } : {}),
    now,
  });
  // The suggestion ("Send invoice") is done; reminders get suggested later.
  db.update(balances)
    .set({ aiSuggestion: null, aiAction: null, aiSuggestionBy: null, updatedAt: now })
    .where(eq(balances.id, balanceId))
    .run();

  const rendered = renderBillEmail(
    billEmailData(ctx, r, {
      message,
      dueDate,
      payToken,
      paypalPayerUrl: paypal?.payerUrl ?? null,
      paymentOption: input.paymentOption,
    }),
  );
  const email = await deliverEmail(ctx, invoiceId, rendered, patient.email);

  const [balance] = getBalanceRows(db, today, [balanceId]);
  return {
    balance: balance!,
    invoiceId,
    payUrl: payUrl(ctx.appBaseUrl, payToken),
    paypal: paypal
      ? { invoiceId: paypal.invoiceId, number: paypal.number, payerUrl: paypal.payerUrl }
      : null,
    email,
  };
}

/**
 * What the patient got (or will get): the logged email once sent; before that (and for seeded
 * invoices that never went through Send) a live render from the current draft.
 */
export function emailPreview(
  ctx: Ctx,
  balanceId: number,
  draft: { message: string; paymentOption: DraftInput['paymentOption'] },
): EmailPreview {
  const { db } = ctx;
  const r = balanceRow(db, balanceId, ctx.today());
  const invoice = db
    .select()
    .from(invoices)
    .where(eq(invoices.balanceId, balanceId))
    .orderBy(desc(invoices.id))
    .get();
  const patient = patientFor(ctx, balanceId);
  const payPath = invoice?.payToken ? `/pay/${invoice.payToken}` : null;
  const logged = invoice
    ? db
        .select()
        .from(emails)
        .where(eq(emails.invoiceId, invoice.id))
        .orderBy(desc(emails.id))
        .get()
    : undefined;
  if (logged) {
    return {
      kind: 'sent',
      subject: logged.subject,
      html: logged.html,
      to: maskEmail(logged.intendedTo),
      status: logged.status,
      provider: logged.provider,
      error: logged.error,
      createdAt: logged.createdAt,
      patientName: r.patientName,
      payPath,
      paypalPayerUrl: invoice?.paypalPayerUrl ?? null,
    };
  }
  const sent = invoice && invoice.status !== 'draft';
  const rendered = renderBillEmail(
    billEmailData(ctx, r, {
      message: sent ? invoice.message : draft.message,
      dueDate: sent ? invoice.dueDate : dueDateFor(r, ctx.today()),
      payToken: sent ? invoice.payToken : null,
      paypalPayerUrl: sent ? invoice.paypalPayerUrl : null,
      paymentOption: sent ? invoice.paymentOption : draft.paymentOption,
    }),
  );
  return {
    kind: 'draft',
    subject: rendered.subject,
    html: rendered.html,
    to: maskEmail(patient.email),
    status: 'draft',
    provider: null,
    error: null,
    createdAt: null,
    patientName: r.patientName,
    payPath,
    paypalPayerUrl: invoice?.paypalPayerUrl ?? null,
  };
}

/**
 * The one-click "Send friendly reminder" / "Offer 3-month plan" from AI suggests: re-send the
 * bill email with a short reminder (fixed wording, computed amounts). Offering a plan also turns
 * plans on for the patient's page.
 */
export async function sendReminder(
  ctx: Ctx,
  balanceId: number,
  input: { offerPlanMonths?: 3 | 6 },
): Promise<ReminderResult> {
  const { db } = ctx;
  const r = balanceRow(db, balanceId, ctx.today());
  if (r.status !== 'sent' && r.status !== 'partial') {
    throw new DrawerError('Reminders are for bills that were sent and are still open.', 409);
  }
  const invoice = db
    .select()
    .from(invoices)
    .where(eq(invoices.balanceId, balanceId))
    .orderBy(desc(invoices.id))
    .get();
  if (!invoice?.payToken)
    throw new DrawerError('This bill has no patient link to remind about.', 409);

  let option = invoice.paymentOption ?? { type: 'full' as const };
  let plan: { months: 3 | 6; firstCents: number; regularCents: number } | null = null;
  if (input.offerPlanMonths) {
    const p = planOption(r.remainingCents, input.offerPlanMonths);
    if (!p.eligible) throw new DrawerError('This balance is too small for that plan.', 422);
    plan = { months: p.months, firstCents: p.firstCents, regularCents: p.regularCents };
    option = { type: 'plan', months: p.months };
    db.update(invoices).set({ paymentOption: option }).where(eq(invoices.id, invoice.id)).run();
  }

  const practice = practiceRow(ctx);
  const $ = formatMoneyShort;
  const visit = `${formatMonthDay(r.visitDate)} visit${r.provider ? ` with ${r.provider}` : ''}`;
  const message = [
    `Hi ${r.patientFirstName}, this is a friendly reminder from ${practice.name} about your ${visit}.`,
    `Your balance is ${$(r.remainingCents)}.`,
    plan
      ? plan.firstCents === plan.regularCents
        ? `If it helps, you can split it into ${plan.months} payments of ${$(plan.regularCents)}, with no interest or fees.`
        : `If it helps, you can split it into ${plan.months} monthly payments (${$(plan.firstCents)} first, then ${$(plan.regularCents)}), with no interest or fees.`
      : 'You can pay online in a minute.',
    'Thank you!',
  ].join(' ');

  const rendered = renderBillEmail({
    ...billEmailData(ctx, r, {
      message,
      dueDate: invoice.dueDate,
      payToken: invoice.payToken,
      paypalPayerUrl: invoice.paypalPayerUrl,
      paymentOption: option,
    }),
    reminder: true,
  });
  const email = await deliverEmail(ctx, invoice.id, rendered, patientFor(ctx, balanceId).email);
  const now = new Date().toISOString();
  db.insert(events)
    .values({
      type: 'invoice.reminded',
      balanceId,
      payload: { invoiceId: invoice.id, emailId: email.id, planMonths: plan?.months ?? null },
      createdAt: now,
    })
    .run();
  db.update(balances)
    .set({ aiSuggestion: 'Reminder sent today', aiAction: 'none', updatedAt: now })
    .where(eq(balances.id, balanceId))
    .run();
  return {
    email,
    payUrl: payUrl(ctx.appBaseUrl, invoice.payToken),
    planMonths: plan?.months ?? null,
  };
}
