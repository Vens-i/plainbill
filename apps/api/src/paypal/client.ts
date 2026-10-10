/**
 * Thin PayPal REST client (fetch, no SDK): OAuth client-credentials with a cached token, and only
 * the calls Plainbill makes — Invoicing v2, Orders v2, Subscriptions v1 and webhook signature
 * verification. Field names follow PayPal's published OpenAPI specs.
 *
 * Services depend on the `PayPalApi` interface so tests can swap in an in-memory fake.
 */
import type {
  CreateInvoiceBody,
  CreateOrderBody,
  CreatePlanBody,
  CreateSubscriptionBody,
  PayPalInvoice,
  PayPalLink,
  PayPalOrder,
  PayPalSubscription,
  RecordInvoicePaymentBody,
  SubscriptionTransaction,
  WebhookHeaders,
} from './types';

export interface PayPalApi {
  readonly env: 'sandbox' | 'live';
  createInvoice(body: CreateInvoiceBody): Promise<PayPalInvoice>;
  /** Sends without PayPal's own emails and returns the payer-view link. */
  sendInvoice(invoiceId: string): Promise<PayPalLink>;
  getInvoice(invoiceId: string): Promise<PayPalInvoice>;
  recordInvoicePayment(invoiceId: string, body: RecordInvoicePaymentBody): Promise<string>;
  createOrder(body: CreateOrderBody, requestId: string): Promise<PayPalOrder>;
  captureOrder(orderId: string, requestId: string): Promise<PayPalOrder>;
  getOrder(orderId: string): Promise<PayPalOrder>;
  createProduct(body: { name: string; description: string }, requestId: string): Promise<string>;
  createPlan(body: CreatePlanBody, requestId: string): Promise<string>;
  createSubscription(body: CreateSubscriptionBody, requestId: string): Promise<PayPalSubscription>;
  getSubscription(subscriptionId: string): Promise<PayPalSubscription>;
  cancelSubscription(subscriptionId: string, reason: string): Promise<void>;
  listSubscriptionTransactions(
    subscriptionId: string,
    startTime: string,
    endTime: string,
  ): Promise<SubscriptionTransaction[]>;
  verifyWebhookSignature(
    headers: WebhookHeaders,
    rawBody: string,
    webhookId: string,
  ): Promise<boolean>;
}

export class PayPalError extends Error {
  override name = 'PayPalError';
  constructor(
    readonly status: number,
    /** PayPal's error name ("UNPROCESSABLE_ENTITY", "RESOURCE_NOT_FOUND"…). */
    readonly code: string,
    message: string,
    /** First `details[].issue`, e.g. "CANNOT_CANCEL_PAID_INVOICE". */
    readonly issue: string | null,
    readonly debugId: string | null,
  ) {
    super(message);
  }
}

export interface PayPalClientOptions {
  clientId: string;
  clientSecret: string;
  env: 'sandbox' | 'live';
  fetch?: typeof fetch;
  /** Request timeout, ms. */
  timeoutMs?: number;
}

const BASE_URL = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
} as const;

interface RequestOptions {
  body?: unknown;
  /** Raw JSON string body (webhook verification splices the event in verbatim). */
  rawBody?: string;
  requestId?: string;
  query?: Record<string, string>;
}

export class PayPalClient implements PayPalApi {
  readonly env: 'sandbox' | 'live';
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private token: { value: string; expiresAt: number } | null = null;
  private tokenRequest: Promise<string> | null = null;

  constructor(private readonly options: PayPalClientOptions) {
    this.env = options.env;
    this.base = BASE_URL[options.env];
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  private async accessToken(): Promise<string> {
    // Refresh a minute early; share one in-flight request between concurrent callers.
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    this.tokenRequest ??= (async () => {
      try {
        const basic = Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString(
          'base64',
        );
        const res = await this.fetchImpl(`${this.base}/v1/oauth2/token`, {
          method: 'POST',
          headers: {
            authorization: `Basic ${basic}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: 'grant_type=client_credentials',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const body = (await res.json().catch(() => ({}))) as {
          access_token?: string;
          expires_in?: number;
          error?: string;
          error_description?: string;
        };
        if (!res.ok || !body.access_token) {
          throw new PayPalError(
            res.status,
            body.error ?? 'AUTHENTICATION_FAILURE',
            `PayPal rejected the app credentials: ${body.error_description ?? res.statusText}`,
            null,
            res.headers.get('paypal-debug-id'),
          );
        }
        this.token = {
          value: body.access_token,
          expiresAt: Date.now() + (body.expires_in ?? 300) * 1000,
        };
        return body.access_token;
      } finally {
        this.tokenRequest = null;
      }
    })();
    return this.tokenRequest;
  }

  private async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.accessToken()}`,
      accept: 'application/json',
      prefer: 'return=representation',
    };
    const body = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
    // PayPal answers 415 to a POST without a JSON content type, even with no body (capture).
    if (body !== undefined || method !== 'GET') headers['content-type'] = 'application/json';
    if (opts.requestId) headers['paypal-request-id'] = opts.requestId;

    const res = await this.fetchImpl(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : {};
    if (!res.ok) {
      const err = json as {
        name?: string;
        message?: string;
        details?: Array<{ issue?: string; description?: string }>;
      };
      const detail = err.details?.[0];
      throw new PayPalError(
        res.status,
        err.name ?? 'ERROR',
        detail?.description ?? err.message ?? `PayPal request failed (${res.status})`,
        detail?.issue ?? null,
        res.headers.get('paypal-debug-id'),
      );
    }
    return json as T;
  }

  createInvoice(body: CreateInvoiceBody) {
    return this.request<PayPalInvoice>('POST', '/v2/invoicing/invoices', { body });
  }

  sendInvoice(invoiceId: string) {
    return this.request<PayPalLink>('POST', `/v2/invoicing/invoices/${enc(invoiceId)}/send`, {
      // We email the patient ourselves (with the breakdown link), so PayPal sends nothing.
      body: { send_to_invoicer: false, send_to_recipient: false },
    });
  }

  getInvoice(invoiceId: string) {
    return this.request<PayPalInvoice>('GET', `/v2/invoicing/invoices/${enc(invoiceId)}`);
  }

  async recordInvoicePayment(invoiceId: string, body: RecordInvoicePaymentBody) {
    const res = await this.request<{ payment_id: string }>(
      'POST',
      `/v2/invoicing/invoices/${enc(invoiceId)}/payments`,
      { body },
    );
    return res.payment_id;
  }

  createOrder(body: CreateOrderBody, requestId: string) {
    return this.request<PayPalOrder>('POST', '/v2/checkout/orders', { body, requestId });
  }

  captureOrder(orderId: string, requestId: string) {
    return this.request<PayPalOrder>('POST', `/v2/checkout/orders/${enc(orderId)}/capture`, {
      requestId,
    });
  }

  getOrder(orderId: string) {
    return this.request<PayPalOrder>('GET', `/v2/checkout/orders/${enc(orderId)}`);
  }

  async createProduct(body: { name: string; description: string }, requestId: string) {
    const res = await this.request<{ id: string }>('POST', '/v1/catalogs/products', {
      body: { ...body, type: 'SERVICE', category: 'MEDICAL_SERVICES' },
      requestId,
    });
    return res.id;
  }

  async createPlan(body: CreatePlanBody, requestId: string) {
    const res = await this.request<{ id: string }>('POST', '/v1/billing/plans', {
      body,
      requestId,
    });
    return res.id;
  }

  createSubscription(body: CreateSubscriptionBody, requestId: string) {
    return this.request<PayPalSubscription>('POST', '/v1/billing/subscriptions', {
      body,
      requestId,
    });
  }

  getSubscription(subscriptionId: string) {
    return this.request<PayPalSubscription>(
      'GET',
      `/v1/billing/subscriptions/${enc(subscriptionId)}`,
    );
  }

  async cancelSubscription(subscriptionId: string, reason: string) {
    await this.request('POST', `/v1/billing/subscriptions/${enc(subscriptionId)}/cancel`, {
      body: { reason },
    });
  }

  async listSubscriptionTransactions(subscriptionId: string, startTime: string, endTime: string) {
    const res = await this.request<{ transactions?: SubscriptionTransaction[] }>(
      'GET',
      `/v1/billing/subscriptions/${enc(subscriptionId)}/transactions`,
      { query: { start_time: startTime, end_time: endTime } },
    );
    return res.transactions ?? [];
  }

  /**
   * Ask PayPal whether a webhook delivery is genuine. The event goes back byte-for-byte as it
   * arrived: re-serializing parsed JSON can change it and fail verification.
   */
  async verifyWebhookSignature(headers: WebhookHeaders, rawBody: string, webhookId: string) {
    const envelope = JSON.stringify({
      auth_algo: headers.authAlgo,
      cert_url: headers.certUrl,
      transmission_id: headers.transmissionId,
      transmission_sig: headers.transmissionSig,
      transmission_time: headers.transmissionTime,
      webhook_id: webhookId,
      webhook_event: '__EVENT__',
    });
    const res = await this.request<{ verification_status?: string }>(
      'POST',
      '/v1/notifications/verify-webhook-signature',
      // A replacer function, so "$&"-style sequences in the body are not treated as patterns.
      { rawBody: envelope.replace('"__EVENT__"', () => rawBody) },
    );
    return res.verification_status === 'SUCCESS';
  }
}

const enc = encodeURIComponent;

/** Cents ↔ PayPal's decimal-string money (USD only). */
export function toPayPalMoney(cents: number) {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError(`bad cents: ${cents}`);
  return { currency_code: 'USD' as const, value: (cents / 100).toFixed(2) };
}

export function fromPayPalMoney(money: { currency_code: string; value: string } | undefined) {
  if (!money) return 0;
  if (money.currency_code !== 'USD')
    throw new RangeError(`unexpected currency ${money.currency_code}`);
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(money.value.trim());
  if (!match) throw new RangeError(`bad PayPal amount "${money.value}"`);
  return Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
}
