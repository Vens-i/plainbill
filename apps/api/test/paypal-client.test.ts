import { describe, expect, it } from 'vitest';
import { fromPayPalMoney, PayPalClient, PayPalError, toPayPalMoney } from '../src/paypal/client';
import { barWidths, renderBillEmail, type BillEmailData } from '../src/services/email';
import { normalizeLastName, PatientSessions, readCookie } from '../src/services/sessions';

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function fakeFetch(respond: (req: Seen) => { status?: number; body: unknown }) {
  const seen: Seen[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const req: Seen = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body: init?.body as string | undefined,
    };
    seen.push(req);
    const { status = 200, body } = req.url.endsWith('/v1/oauth2/token')
      ? { body: { access_token: 'tok-1', expires_in: 3600 } }
      : respond(req);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'paypal-debug-id': 'dbg-1' },
    });
  }) as typeof fetch;
  return { impl, seen };
}

const client = (impl: typeof fetch) =>
  new PayPalClient({ clientId: 'id', clientSecret: 'secret', env: 'sandbox', fetch: impl });

describe('PayPalClient', () => {
  it('fetches one token, reuses it, and sends idempotency keys where PayPal supports them', async () => {
    const { impl, seen } = fakeFetch(() => ({ body: { id: 'ORDER-1', status: 'CREATED' } }));
    const pp = client(impl);
    await pp.createOrder(
      {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: 'r',
            custom_id: 'c',
            description: 'd',
            amount: { currency_code: 'USD', value: '1.00' },
          },
        ],
      },
      'req-1',
    );
    await pp.getOrder('ORDER-1');
    const tokens = seen.filter((s) => s.url.endsWith('/v1/oauth2/token'));
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from('id:secret').toString('base64')}`,
    );
    const create = seen.find((s) => s.url.endsWith('/v2/checkout/orders'))!;
    expect(create.url).toMatch(/^https:\/\/api-m\.sandbox\.paypal\.com/);
    expect(create.headers.authorization).toBe('Bearer tok-1');
    expect(create.headers['paypal-request-id']).toBe('req-1');
  });

  it('sends invoices with PayPal’s own emails turned off', async () => {
    const { impl, seen } = fakeFetch(() => ({
      body: { href: 'https://www.sandbox.paypal.com/invoice/p/#INV2-1', rel: 'payer-view' },
    }));
    const link = await client(impl).sendInvoice('INV2-1');
    expect(link.rel).toBe('payer-view');
    const send = seen.find((s) => s.url.endsWith('/send'))!;
    expect(JSON.parse(send.body!)).toEqual({ send_to_invoicer: false, send_to_recipient: false });
  });

  it('turns PayPal errors into PayPalError with the issue and debug id', async () => {
    const { impl } = fakeFetch(() => ({
      status: 422,
      body: {
        name: 'UNPROCESSABLE_ENTITY',
        message: 'The requested action could not be performed.',
        details: [{ issue: 'ORDER_ALREADY_CAPTURED', description: 'Order already captured.' }],
      },
    }));
    const err = await client(impl)
      .captureOrder('ORDER-1', 'cap-1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect(err).toMatchObject({
      status: 422,
      code: 'UNPROCESSABLE_ENTITY',
      issue: 'ORDER_ALREADY_CAPTURED',
      debugId: 'dbg-1',
      message: 'Order already captured.',
    });
  });

  it('verifies webhooks with the event body exactly as received', async () => {
    const { impl, seen } = fakeFetch(() => ({ body: { verification_status: 'SUCCESS' } }));
    // Odd spacing and a "$&" that String.replace would otherwise expand.
    const raw = '{"id":"WH-1",  "event_type":"X","resource":{"note":"$& and $1"}}';
    const ok = await client(impl).verifyWebhookSignature(
      {
        authAlgo: 'SHA256withRSA',
        certUrl: 'https://api.paypal.com/cert',
        transmissionId: 't-1',
        transmissionSig: 'sig',
        transmissionTime: '2026-10-10T00:00:00Z',
      },
      raw,
      'WH-ID',
    );
    expect(ok).toBe(true);
    const body = seen.find((s) => s.url.endsWith('/verify-webhook-signature'))!.body!;
    expect(body).toContain(`"webhook_event":${raw}`);
    expect(JSON.parse(body)).toMatchObject({ webhook_id: 'WH-ID', transmission_id: 't-1' });
  });

  it('reports FAILURE as not genuine', async () => {
    const { impl } = fakeFetch(() => ({ body: { verification_status: 'FAILURE' } }));
    const ok = await client(impl).verifyWebhookSignature(
      {
        authAlgo: 'a',
        certUrl: 'b',
        transmissionId: 'c',
        transmissionSig: 'd',
        transmissionTime: 'e',
      },
      '{}',
      'WH',
    );
    expect(ok).toBe(false);
  });
});

describe('PayPal money', () => {
  it('converts cents to and from decimal strings without floating point', () => {
    expect(toPayPalMoney(24000)).toEqual({ currency_code: 'USD', value: '240.00' });
    expect(toPayPalMoney(6135)).toEqual({ currency_code: 'USD', value: '61.35' });
    expect(fromPayPalMoney({ currency_code: 'USD', value: '61.35' })).toBe(6135);
    expect(fromPayPalMoney({ currency_code: 'USD', value: '80' })).toBe(8000);
    expect(fromPayPalMoney({ currency_code: 'USD', value: '0.5' })).toBe(50);
    expect(() => fromPayPalMoney({ currency_code: 'EUR', value: '1.00' })).toThrow(/currency/);
    expect(() => toPayPalMoney(-1)).toThrow();
  });
});

describe('patient sessions', () => {
  it('accepts its own cookie and rejects forged, expired or foreign ones', () => {
    const sessions = new PatientSessions('secret-a', false);
    const now = Date.parse('2026-10-10T12:00:00Z');
    const { value } = sessions.issue(7, now);
    expect(sessions.read(value, now + 60_000)).toBe(7);
    expect(sessions.read(value, now + 31 * 60_000)).toBeNull();
    expect(sessions.read(value.replace(/^7\./, '8.'), now)).toBeNull();
    expect(new PatientSessions('secret-b', false).read(value, now)).toBeNull();
    expect(sessions.read(undefined)).toBeNull();
    expect(sessions.read('garbage')).toBeNull();
  });

  it('builds an HttpOnly cookie scoped to the pay API, Secure over https', () => {
    expect(new PatientSessions('s', true).cookieHeader('v', 60)).toBe(
      'pb_pay=v; Path=/api/pay; Max-Age=60; HttpOnly; SameSite=Lax; Secure',
    );
    expect(readCookie('a=1; pb_pay=x.y.z; b=2', 'pb_pay')).toBe('x.y.z');
  });

  it('matches last names regardless of case, accents, spaces and punctuation', () => {
    expect(normalizeLastName(' Herrera ')).toBe(normalizeLastName('herrera'));
    expect(normalizeLastName('Núñez')).toBe('nunez');
    expect(normalizeLastName("O'Neil-Reyes")).toBe('oneilreyes');
  });
});

describe('bill email', () => {
  it('bar widths are whole percents that add up to 100, with small parts still visible', () => {
    expect(barWidths([40000, 21000, 24000])).toEqual([47, 25, 28]);
    const tiny = barWidths([100000, 100, 500]);
    expect(tiny.reduce((a, b) => a + b, 0)).toBe(100);
    expect(Math.min(...tiny)).toBeGreaterThanOrEqual(3);
    expect(barWidths([0, 0, 27500])).toEqual([0, 0, 100]);
  });

  const data: BillEmailData = {
    practice: {
      name: 'Harborview Family Medicine',
      phone: '(555) 014-2290',
      hours: 'Mon–Fri 8–5',
      address: '220 Harbor St, Suite 4',
    },
    patientFirstName: 'Kevin',
    message: 'Hi Kevin, <thanks> for visiting.\n\nSecond paragraph.',
    visitDate: '2026-09-29',
    dueDate: '2026-10-29',
    billedCents: 27500,
    discountCents: 0,
    insurancePaidCents: null,
    alreadyPaidCents: 0,
    amountDueCents: 27500,
    selfPay: true,
    paypalUrl: 'https://www.sandbox.paypal.com/invoice/p/#INV2-1',
    breakdownUrl: 'https://pay.example.test/pay/abc',
    plansAvailable: false,
    partialMinimumCents: 2000,
  };

  it('escapes the message, keeps paragraphs, and skips insurance rows for self-pay', () => {
    const { subject, html, text } = renderBillEmail(data);
    expect(subject).toBe('Your Sep 29 visit — $275.00 due Oct 29');
    expect(html).toContain('Hi Kevin, &lt;thanks&gt; for visiting.');
    expect(html).toContain('Second paragraph.');
    expect(html).not.toContain('Paid by your insurance');
    expect(html).toContain('pay part now ($20.00 minimum)');
    expect(html).toContain('Questions? Call Harborview at (555) 014-2290, Mon–Fri 8–5.');
    expect(text).toContain('Pay with PayPal: https://www.sandbox.paypal.com/invoice/p/#INV2-1');
    expect(text).toContain('https://pay.example.test/pay/abc');
  });
});
