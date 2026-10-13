/**
 * Phase 3 end to end on the full seed, with an in-memory PayPal (FakePayPal mirrors what the
 * sandbox did) and the email outbox:
 *
 *   Send → PayPal invoice (no patient email, PayPal's emails off) + our email
 *   Patient link → verify (last name + DOB, lockout) → bill
 *   Pay with PayPal (order → approve → capture) → dashboard flash, PayPal invoice updated
 *   Pay on PayPal's invoice page → reconciliation poll records it
 *   Webhooks (signature checked, deduplicated) and a 3-month plan (Subscriptions).
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildApp,
  FakePayPal,
  openDatabase,
  PayPalError,
  schema,
  type BalanceRow,
  type DrawerData,
  type EmailPreview,
  type PatientBill,
  type PayResult,
  type SendResult,
} from '@plainbill/api';
import { loadSeed } from '../src/load';
import { SEED_TODAY } from '../src/spec';

const paypal = new FakePayPal();
let base = '';
let db: ReturnType<typeof openDatabase>['db'];
let close: () => void;
let stop: () => Promise<void>;
const published: Array<{ type: string; data: unknown }> = [];

beforeAll(async () => {
  const opened = openDatabase(':memory:');
  db = opened.db;
  close = opened.close;
  await loadSeed(db, { now: '2026-10-10T13:00:00.000Z' });
  const { app, bus } = buildApp({
    db,
    demoToday: SEED_TODAY,
    devRoutes: true,
    paypal: { api: paypal, clientId: 'test-client-id', env: 'sandbox', webhookId: 'WH-TEST' },
    appBaseUrl: 'https://pay.example.test',
  });
  bus.subscribe(({ event }) => published.push(event));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api`;
  stop = () => app.close();
});
afterAll(async () => {
  await stop();
  close();
});

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: T; headers: Headers }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as T, headers: res.headers };
}

const rows = async () => (await call<BalanceRow[]>('GET', '/balances')).json;
const rowOf = async (name: string) => (await rows()).find((r) => r.patientName === name)!;
const tokenOf = (row: BalanceRow) => row.invoice!.payPath!.split('/').pop()!;

async function send(name: string, paymentOption: unknown) {
  const row = await rowOf(name);
  const drawer = (await call<DrawerData>('GET', `/balances/${row.id}/drawer`)).json;
  return call<SendResult>('POST', `/balances/${row.id}/send`, {
    message: drawer.draft.message,
    messageSource: 'template',
    paymentOption,
  });
}

async function verify(token: string, lastName: string, dob: [number, number, number]) {
  const res = await call<PatientBill & { error?: string; attemptsLeft?: number }>(
    'POST',
    `/pay/${token}/verify`,
    { lastName, month: String(dob[0]), day: String(dob[1]), year: String(dob[2]) },
  );
  const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
  return { ...res, cookie };
}

describe('Send invoice → PayPal Invoicing v2 + email', () => {
  let result: SendResult;

  it('creates a PayPal invoice with only the name, visit date and provider, then sends it quietly', async () => {
    const res = await send('Maria Delgado', { type: 'plan', months: 3 });
    expect(res.status).toBe(200);
    result = res.json;
    expect(result.balance.status).toBe('sent');
    expect(result.paypal).toMatchObject({ number: '0001' });

    const invoice = paypal.invoices.get(result.paypal!.invoiceId)!;
    expect(invoice.status).toBe('SENT');
    expect(invoice.body.items).toEqual([
      {
        name: 'Services on Oct 3, 2026 with Dr. Patel',
        quantity: '1',
        unit_amount: { currency_code: 'USD', value: '240.00' },
        unit_of_measure: 'AMOUNT',
      },
    ]);
    // No email address: PayPal keeps the invoice payable and sends nothing itself.
    expect(invoice.body.primary_recipients).toEqual([
      { billing_info: { name: { given_name: 'Maria', surname: 'Delgado' } } },
    ]);
    expect(invoice.body.configuration.partial_payment).toEqual({ allow_partial_payment: false });
    // Minimal PHI: no procedure codes, adjustment codes or member ids anywhere in what PayPal got.
    const sentToPayPal = JSON.stringify(invoice.body);
    for (const leak of ['99214', '80053', '93000', 'CO-45', 'PR-1', 'BCB', '@']) {
      expect(sentToPayPal).not.toContain(leak);
    }
  });

  it('issues a pay link and keeps the email in the outbox when no provider is set', async () => {
    expect(result.payUrl).toMatch(/^https:\/\/pay\.example\.test\/pay\/[A-Za-z0-9_-]{32}$/);
    expect(result.email).toMatchObject({ status: 'outbox', provider: 'outbox', deliveredTo: null });
    const row = await rowOf('Maria Delgado');
    expect(row.invoice).toMatchObject({ sentVia: 'paypal', paypalInvoiceNumber: '0001' });
    expect(row.invoice!.payPath).toBe(new URL(result.payUrl).pathname);
  });

  it('renders the 1d email: amounts, PayPal’s own button to the invoice, the verify link, no codes', async () => {
    const row = await rowOf('Maria Delgado');
    const { json: email } = await call<EmailPreview>('GET', `/balances/${row.id}/email`);
    expect(email).toMatchObject({
      kind: 'sent',
      status: 'outbox',
      subject: 'Your Oct 3 visit — $240.00 due Nov 2',
      to: 'm•••••@example.com',
    });
    expect(email.html).toContain('$240.00');
    expect(email.html).toContain('−$400.00');
    expect(email.html).toContain('−$210.00');
    expect(email.html).toContain('Full bar = $850.00 billed');
    expect(email.html).toContain(`href="${result.paypal!.payerUrl}"`);
    expect(email.html).toContain(
      'paypalobjects.com/webstatic/en_US/i/btn/png/gold-rect-paypal-60px.png',
    );
    expect(email.html).toContain(`href="${result.payUrl}"`);
    expect(email.html).toContain('payment plans available');
    for (const leak of ['99214', '80053', 'CO-45', 'PR-1', 'PR-2', 'metabolic']) {
      expect(email.html).not.toContain(leak);
    }
  });

  it('turns on partial payments with the $20 minimum when staff choose that option', async () => {
    const res = await send('Kevin Lam', { type: 'partial', minimumCents: 2000 });
    expect(res.status).toBe(200);
    const invoice = paypal.invoices.get(res.json.paypal!.invoiceId)!;
    expect(invoice.body.configuration.partial_payment).toEqual({
      allow_partial_payment: true,
      minimum_amount_due: { currency_code: 'USD', value: '20.00' },
    });
    expect(invoice.body.items[0]!.name).toBe('Services on Sep 29, 2026 with Dr. Kim');
  });
});

describe('a PayPal failure during send', () => {
  it('changes nothing, and the retry reuses the PayPal draft instead of making a second one', async () => {
    // Ellen's balance needs to be ready first: mark it ready from review.
    const ellen = await rowOf('Ellen Brooks');
    expect((await call('POST', `/balances/${ellen.id}/review/ready`)).status).toBe(200);

    paypal.failNextSend = new PayPalError(503, 'SERVICE_UNAVAILABLE', 'Try later.', null, 'dbg');
    const creates = paypal.calls.filter((c) => c === 'createInvoice').length;
    const failed = await send('Ellen Brooks', { type: 'full' });
    expect(failed.status).toBe(502);
    expect((await rowOf('Ellen Brooks')).status).toBe('ready');

    const retried = await send('Ellen Brooks', { type: 'full' });
    expect(retried.status).toBe(200);
    expect(paypal.calls.filter((c) => c === 'createInvoice').length).toBe(creates + 1);
    expect((await rowOf('Ellen Brooks')).status).toBe('sent');
  });
});

describe('Patient page: verify', () => {
  it('shows nothing but the practice before verification', async () => {
    const token = tokenOf(await rowOf('Maria Delgado'));
    const info = await call<Record<string, unknown>>('GET', `/pay/${token}`);
    expect(info.json).toEqual({
      practice: {
        name: 'Harborview Family Medicine',
        phone: '(555) 014-2290',
        hours: 'Mon–Fri 8–5',
      },
      verified: false,
    });
    expect(info.headers.get('cache-control')).toBe('no-store');
    expect((await call('GET', `/pay/${token}/bill`)).status).toBe(401);
    expect((await call('GET', '/pay/not-a-real-token-at-all-000000')).status).toBe(404);
  });

  it('locks the link after five wrong tries', async () => {
    const token = tokenOf(await rowOf('Robert Chen'));
    for (let left = 4; left >= 1; left--) {
      const r = await verify(token, 'Chen', [1, 1, 1980]);
      expect(r.status).toBe(401);
      expect(r.json.attemptsLeft).toBe(left);
    }
    expect((await verify(token, 'Chen', [1, 1, 1980])).status).toBe(429);
    // Even the right answer waits out the lock.
    expect((await verify(token, 'Chen', [5, 27, 1981])).status).toBe(429);
  });

  it('accepts the right last name (any case, accents ignored) and DOB, and counts the open', async () => {
    const token = tokenOf(await rowOf('Maria Delgado'));
    const r = await verify(token, '  delgado ', [4, 17, 1984]);
    expect(r.status).toBe(200);
    expect(r.cookie).toMatch(/^pb_pay=/);
    expect(r.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect(r.headers.get('set-cookie')).toMatch(/Path=\/api\/pay/);
    expect((await rowOf('Maria Delgado')).sub).toBe('Opened 1× · not paid');
  });

  it('a session opens only the bill it was issued for', async () => {
    const maria = await verify(tokenOf(await rowOf('Maria Delgado')), 'Delgado', [4, 17, 1984]);
    const kevinToken = tokenOf(await rowOf('Kevin Lam'));
    expect(
      (await call('GET', `/pay/${kevinToken}/bill`, undefined, { cookie: maria.cookie })).status,
    ).toBe(401);
    const forged = maria.cookie.replace(/\.[^.]+$/, '.AAAA');
    expect(
      (
        await call('GET', `/pay/${tokenOf(await rowOf('Maria Delgado'))}/bill`, undefined, {
          cookie: forged,
        })
      ).status,
    ).toBe(401);
  });
});

describe('Patient page: the bill', () => {
  let bill: PatientBill;

  beforeAll(async () => {
    const token = tokenOf(await rowOf('Maria Delgado'));
    const { cookie } = await verify(token, 'Delgado', [4, 17, 1984]);
    bill = (await call<PatientBill>('GET', `/pay/${token}/bill`, undefined, { cookie })).json;
  });

  it('matches artboard 1f, with every amount from the computed balance', () => {
    expect(bill.firstName).toBe('Maria');
    expect(bill.amounts).toMatchObject({
      billedCents: 85000,
      discountCents: 40000,
      allowedCents: 45000,
      insurancePaidCents: 21000,
      remainingCents: 24000,
    });
    expect(bill.dueDate).toBe('2026-11-02');
    expect(bill.waterfall.map((s) => s.title)).toEqual([
      'Billed: $850.00',
      'Insurance discount: −$400.00',
      'Insurance paid: −$210.00',
      'You owe: $240.00',
    ]);
    expect(bill.waterfall.at(-1)!.body).toBe(
      '$200 goes toward your yearly deductible, plus $40 coinsurance — your share of the cost after the deductible.',
    );
    expect(bill.services).toEqual([
      { name: 'Office visit with Dr. Patel', chargeCents: 35000 },
      { name: 'Blood work (metabolic panel)', chargeCents: 18000 },
      { name: 'Heart rhythm test (ECG)', chargeCents: 32000 },
    ]);
    expect(bill.terms.map((t) => t.term)).toEqual(['Allowed amount', 'Deductible', 'Coinsurance']);
  });

  it('offers the plans staff chose, and never shows a code', () => {
    expect(bill.options.plans).toEqual([
      { months: 3, firstCents: 8000, regularCents: 8000, selected: true },
      { months: 6, firstCents: 4000, regularCents: 4000, selected: false },
    ]);
    expect(bill.options.partialMinimumCents).toBeNull();
    const json = JSON.stringify(bill);
    for (const code of ['99214', '80053', '93000', 'CO-', 'PR-']) {
      expect(json).not.toContain(code);
    }
    expect(bill.paypal).toEqual({ enabled: true, clientId: 'test-client-id', env: 'sandbox' });
  });
});

describe('Paying with PayPal (Orders v2)', () => {
  it('Kevin pays part ($50) with the $20 minimum enforced server-side', async () => {
    const token = tokenOf(await rowOf('Kevin Lam'));
    const { cookie } = await verify(token, 'Lam', [2, 11, 1991]);
    const h = { cookie };
    expect((await call('POST', `/pay/${token}/orders`, { amountCents: 1500 }, h)).status).toBe(400);
    expect((await call('POST', `/pay/${token}/orders`, { amountCents: 99999 }, h)).status).toBe(
      400,
    );
    const order = await call<{ orderId: string; amountCents: number }>(
      'POST',
      `/pay/${token}/orders`,
      { amountCents: 5000, fundingSource: 'paypal' },
      h,
    );
    expect(order.json.amountCents).toBe(5000);
    expect(
      paypal.orders.get(order.json.orderId)!.body.payment_source?.paypal.experience_context,
    ).toMatchObject({
      return_url: `https://pay.example.test/pay/${token}?checkout=approved`,
      cancel_url: `https://pay.example.test/pay/${token}?checkout=cancelled`,
    });
    expect(paypal.orders.get(order.json.orderId)!.body.purchase_units[0]!.description).toBe(
      'Harborview Family Medicine · visit on Sep 29, 2026',
    );
    paypal.payerApprovesOrder(order.json.orderId);
    const paid = await call<PayResult>(
      'POST',
      `/pay/${token}/orders/${order.json.orderId}/capture`,
      undefined,
      h,
    );
    expect(paid.status).toBe(200);
    expect(paid.json.bill.status).toBe('partial');
    expect(paid.json.bill.amounts.remainingCents).toBe(22500);
    expect(paid.json.bill.payments.at(-1)).toMatchObject({ amountCents: 5000, via: 'PayPal' });
  });

  it('Maria can only pay in full on a plan bill; capture records once, flashes, and updates the PayPal invoice', async () => {
    const row = await rowOf('Maria Delgado');
    const token = tokenOf(row);
    const { cookie } = await verify(token, 'Delgado', [4, 17, 1984]);
    const h = { cookie };
    expect((await call('POST', `/pay/${token}/orders`, { amountCents: 5000 }, h)).status).toBe(400);
    const { json: order } = await call<{ orderId: string }>('POST', `/pay/${token}/orders`, {}, h);

    // Not approved in PayPal yet: nothing is recorded.
    expect(
      (await call('POST', `/pay/${token}/orders/${order.orderId}/capture`, undefined, h)).status,
    ).toBe(502);
    expect((await rowOf('Maria Delgado')).status).toBe('sent');

    paypal.payerApprovesOrder(order.orderId);
    published.length = 0;
    const paid = await call<PayResult>(
      'POST',
      `/pay/${token}/orders/${order.orderId}/capture`,
      undefined,
      h,
    );
    expect(paid.json).toMatchObject({ pending: false });
    expect(paid.json.bill.status).toBe('paid');
    const receipt = paid.json.bill.payments.find((p) => p.id === paid.json.paymentId)!;
    expect(receipt).toMatchObject({ amountCents: 24000, via: 'PayPal' });
    expect(receipt.confirmation).toMatch(/^HFM-\d{5}$/);

    // The hero moment: one payment event for the dashboard.
    const flashes = published.filter((e) => e.type === 'payment');
    expect(flashes).toHaveLength(1);
    expect((flashes[0]!.data as { balance: BalanceRow }).balance).toMatchObject({
      patientName: 'Maria Delgado',
      status: 'paid',
      paidVia: 'PayPal',
    });

    // The PayPal invoice now shows it paid, so its link can't collect a second time.
    const invoice = await paypal.getInvoice(paypalIdOf(row));
    expect(invoice.status).toBe('MARKED_AS_PAID');

    // Capturing again (double click, retry) changes nothing.
    const again = await call<PayResult>(
      'POST',
      `/pay/${token}/orders/${order.orderId}/capture`,
      undefined,
      h,
    );
    expect(again.json.paymentId).toBe(paid.json.paymentId);
    expect(published.filter((e) => e.type === 'payment')).toHaveLength(1);
    expect((await call('POST', `/pay/${token}/orders`, {}, h)).status).toBe(409);
  });
});

function paypalIdOf(row: BalanceRow): string {
  return db
    .select()
    .from(schema.invoices)
    .all()
    .find((i) => i.balanceId === row.id)!.paypalInvoiceId!;
}

describe('An order approved in PayPal but never captured (the page closed)', () => {
  it('is captured by the reconciliation poll', async () => {
    const robert = await rowOf('Robert Chen');
    const token = tokenOf(robert);
    // Robert's link was locked by the earlier test; wait it out by clearing the locks directly.
    db.update(schema.invoices).set({ verifyLockedUntil: null, verifyFailures: 0 }).run();
    const { cookie } = await verify(token, 'Chen', [5, 27, 1981]);
    const { json: order } = await call<{ orderId: string }>(
      'POST',
      `/pay/${token}/orders`,
      {},
      { cookie },
    );
    paypal.payerApprovesOrder(order.orderId);
    // No capture call from the page: the browser went away.
    published.length = 0;
    const sync = await call<{ recorded: number }>('POST', '/dev/paypal/sync');
    expect(sync.json.recorded).toBe(1);
    expect((await rowOf('Robert Chen')).status).toBe('paid');
    expect(published.filter((e) => e.type === 'payment')).toHaveLength(1);

    // Mobile returns after synchronization already recorded the payment: recover its receipt.
    const recovered = await call<PayResult>(
      'POST',
      `/pay/${token}/orders/${order.orderId}/capture`,
      undefined,
      { cookie },
    );
    expect(recovered.status).toBe(200);
    expect(recovered.json.pending).toBe(false);
    expect(recovered.json.bill.amounts.remainingCents).toBe(0);
    expect(
      recovered.json.bill.payments.find((p) => p.id === recovered.json.paymentId),
    ).toMatchObject({ via: 'PayPal', amountCents: robert.remainingCents });
    expect(published.filter((e) => e.type === 'payment')).toHaveLength(1);

    // An order in the return URL cannot be used with a different verified bill.
    const otherToken = tokenOf(await rowOf('Kevin Lam'));
    const other = await verify(otherToken, 'Lam', [2, 11, 1991]);
    expect(
      (
        await call('POST', `/pay/${otherToken}/orders/${order.orderId}/capture`, undefined, {
          cookie: other.cookie,
        })
      ).status,
    ).toBe(404);
  });
});

describe('Paying on PayPal’s own invoice page', () => {
  it('is picked up by the reconciliation poll, once', async () => {
    const ellen = await rowOf('Ellen Brooks');
    paypal.payerPaysInvoice(paypalIdOf(ellen), ellen.remainingCents);
    published.length = 0;
    const sync = await call<{ recorded: number }>('POST', '/dev/paypal/sync');
    expect(sync.json.recorded).toBe(1);
    expect((await rowOf('Ellen Brooks')).status).toBe('paid');
    expect(published.filter((e) => e.type === 'payment')).toHaveLength(1);
    expect((await call<{ recorded: number }>('POST', '/dev/paypal/sync')).json.recorded).toBe(0);
  });
});

describe('Webhooks', () => {
  const headers = {
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
    'paypal-transmission-id': 'tx-1',
    'paypal-transmission-sig': 'sig',
    'paypal-transmission-time': '2026-10-10T14:00:00Z',
  };

  it('refuses events whose signature PayPal does not confirm', async () => {
    paypal.signatureValid = false;
    const res = await call(
      'POST',
      '/webhooks/paypal',
      '{"id":"WH-BAD","event_type":"INVOICING.INVOICE.PAID"}',
      headers,
    );
    expect(res.status).toBe(400);
    paypal.signatureValid = true;
    expect((await call('POST', '/webhooks/paypal', '{"id":"x"}')).status).toBe(400);
  });

  it('verifies against the raw body byte for byte, handles the event, and ignores redelivery', async () => {
    const kevin = await rowOf('Kevin Lam');
    paypal.payerPaysInvoice(paypalIdOf(kevin), 2500);
    // Odd spacing on purpose: the body must reach PayPal's verifier unchanged.
    const raw = `{"id":"WH-1","event_type":"INVOICING.INVOICE.PAID",  "resource":{"id":"${paypalIdOf(kevin)}"}}`;
    const first = await call<{ status: string }>('POST', '/webhooks/paypal', raw, headers);
    expect(first.json.status).toBe('processed');
    expect(paypal.verified.at(-1)).toMatchObject({ rawBody: raw, webhookId: 'WH-TEST' });
    expect((await rowOf('Kevin Lam')).remainingCents).toBe(20000);
    const again = await call<{ status: string }>('POST', '/webhooks/paypal', raw, headers);
    expect(again.json.status).toBe('duplicate');
    expect((await rowOf('Kevin Lam')).remainingCents).toBe(20000);
  });

  it('a capture webhook for a payment the page already recorded is a no-op', async () => {
    const maria = await rowOf('Maria Delgado');
    const capture = db
      .select()
      .from(schema.paypalOrders)
      .all()
      .find((o) => o.status === 'captured' && o.amountCents === 24000)!;
    const raw = JSON.stringify({
      id: 'WH-2',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: {
        id: capture.captureId,
        amount: { currency_code: 'USD', value: '240.00' },
        supplementary_data: { related_ids: { order_id: capture.id } },
      },
    });
    const res = await call<{ status: string }>('POST', '/webhooks/paypal', raw, headers);
    expect(res.json.status).toBe('processed');
    expect((await rowOf('Maria Delgado')).patientPaidCents).toBe(maria.patientPaidCents);
  });
});

describe('Payment plans (Subscriptions v1)', () => {
  it('starts a 3-month plan; the first $80 lands when the patient approves; the rest via sync and webhook', async () => {
    // Tomás: confirm his flagged EOB field, mark ready, send with the 6-month plan offered.
    const tomas = await rowOf('Tomás Herrera');
    const drawer = (await call<DrawerData>('GET', `/balances/${tomas.id}/drawer`)).json;
    for (const flag of drawer.review?.flags ?? []) {
      const ok = [flag.current, ...flag.alternatives].find((o) => o.reconciles)!;
      await call('POST', `/balances/${tomas.id}/review/resolve`, {
        path: flag.path,
        value: ok.value,
      });
    }
    expect((await call('POST', `/balances/${tomas.id}/review/ready`)).status).toBe(200);
    const sent = await send('Tomás Herrera', { type: 'plan', months: 6 });
    expect(sent.status).toBe(200);

    const token = tokenOf(await rowOf('Tomás Herrera'));
    const { cookie } = await verify(token, 'Herrera', [6, 23, 1972]);
    const h = { cookie };
    const bill = (await call<PatientBill>('GET', `/pay/${token}/bill`, undefined, h)).json;
    // $368 doesn't split into 6 evenly: the first payment carries the extra cents.
    expect(bill.options.plans).toEqual([
      { months: 3, firstCents: 12268, regularCents: 12266, selected: false },
      { months: 6, firstCents: 6135, regularCents: 6133, selected: true },
    ]);

    const start = await call<{ subscriptionId: string }>(
      'POST',
      `/pay/${token}/plan`,
      { months: 6 },
      h,
    );
    expect(start.status).toBe(200);
    const sub = paypal.subscriptions.get(start.json.subscriptionId)!;
    expect(
      paypal.plans
        .get(sub.planId)!
        .billing_cycles.map((c) => [
          c.tenure_type,
          c.total_cycles,
          c.pricing_scheme.fixed_price.value,
        ]),
    ).toEqual([
      ['TRIAL', 1, '61.35'],
      ['REGULAR', 5, '61.33'],
    ]);
    // Starting again before approving reuses the same subscription.
    expect(
      (await call<{ subscriptionId: string }>('POST', `/pay/${token}/plan`, { months: 6 }, h)).json
        .subscriptionId,
    ).toBe(start.json.subscriptionId);

    paypal.payerApprovesSubscription(start.json.subscriptionId);
    const confirmed = await call<PayResult>(
      'POST',
      `/pay/${token}/plan/confirm`,
      { subscriptionId: start.json.subscriptionId },
      h,
    );
    expect(confirmed.json.pending).toBe(false);
    expect(confirmed.json.bill.status).toBe('partial');
    expect(confirmed.json.bill.plan).toMatchObject({ months: 6, paidCount: 1, totalCents: 36800 });
    expect(confirmed.json.bill.plan!.schedule.map((i) => [i.amountCents, i.paid])).toEqual([
      [6135, true],
      [6133, false],
      [6133, false],
      [6133, false],
      [6133, false],
      [6133, false],
    ]);
    expect((await rowOf('Tomás Herrera')).sub).toBe('Plan · 1 of 6 paid');

    // Month 2 arrives through the poll; month 3 through a PAYMENT.SALE.COMPLETED webhook.
    paypal.collectNextCycle(start.json.subscriptionId);
    await call('POST', '/dev/paypal/sync');
    expect((await rowOf('Tomás Herrera')).sub).toBe('Plan · 2 of 6 paid');
    const saleId = paypal.collectNextCycle(start.json.subscriptionId);
    const raw = JSON.stringify({
      id: 'WH-SALE-3',
      event_type: 'PAYMENT.SALE.COMPLETED',
      resource: {
        id: saleId,
        amount: { total: '61.33', currency: 'USD' },
        billing_agreement_id: start.json.subscriptionId,
      },
    });
    await call('POST', '/webhooks/paypal', raw, {
      'paypal-auth-algo': 'a',
      'paypal-cert-url': 'b',
      'paypal-transmission-id': 'c',
      'paypal-transmission-sig': 'd',
      'paypal-transmission-time': 'e',
    });
    const row = await rowOf('Tomás Herrera');
    expect(row.sub).toBe('Plan · 3 of 6 paid');
    expect(row.remainingCents).toBe(36800 - 6135 - 6133 * 2);

    // Each plan payment was also recorded on the PayPal invoice.
    const invoice = await paypal.getInvoice(paypalIdOf(row));
    expect(invoice.payments!.transactions!.filter((t) => t.type === 'EXTERNAL')).toHaveLength(3);
  });
});
