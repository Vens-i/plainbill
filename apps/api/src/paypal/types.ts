/**
 * The slices of PayPal's request/response shapes Plainbill uses (Invoicing v2, Orders v2,
 * Subscriptions v1, Webhooks v1). Names match PayPal's OpenAPI specs.
 */

export interface PayPalMoney {
  currency_code: string;
  value: string;
}

export interface PayPalLink {
  href: string;
  rel: string;
  method?: string;
}

// ── Invoicing v2 ────────────────────────────────────────────────────────────

export interface CreateInvoiceBody {
  detail: {
    currency_code: 'USD';
    invoice_date: string;
    payment_term: { due_date: string };
    note?: string;
    /** Private to the merchant. */
    memo?: string;
  };
  invoicer: {
    business_name: string;
    phones?: Array<{ country_code: string; national_number: string; phone_type: 'MOBILE' }>;
  };
  /** Name only: without an email address PayPal keeps the invoice payable and sends nothing. */
  primary_recipients: Array<{ billing_info: { name: { given_name: string; surname: string } } }>;
  items: Array<{
    name: string;
    quantity: '1';
    unit_amount: PayPalMoney;
    unit_of_measure: 'AMOUNT';
  }>;
  configuration: {
    allow_tip: false;
    partial_payment: { allow_partial_payment: boolean; minimum_amount_due?: PayPalMoney };
  };
}

export interface InvoiceTransaction {
  /** "PAYPAL" for payments made through PayPal, "EXTERNAL" for recorded ones. */
  type?: 'PAYPAL' | 'EXTERNAL';
  payment_id?: string;
  payment_date?: string;
  method: string;
  note?: string;
  amount?: PayPalMoney;
}

export interface PayPalInvoice {
  id: string;
  status: string;
  detail?: { invoice_number?: string; metadata?: { recipient_view_url?: string } };
  due_amount?: PayPalMoney;
  amount?: PayPalMoney;
  payments?: { paid_amount?: PayPalMoney; transactions?: InvoiceTransaction[] };
  links?: PayPalLink[];
}

export interface RecordInvoicePaymentBody {
  method: 'PAYPAL';
  payment_date: string;
  amount: PayPalMoney;
  note?: string;
}

// ── Orders v2 ───────────────────────────────────────────────────────────────

export interface CreateOrderBody {
  intent: 'CAPTURE';
  purchase_units: Array<{
    reference_id: string;
    /** Ours, not shown to the payer: "pb-inv-12". */
    custom_id: string;
    /** Shown to the payer. Minimal PHI: practice + visit date only. */
    description: string;
    soft_descriptor?: string;
    amount: PayPalMoney;
  }>;
  payment_source?: {
    paypal: {
      experience_context: {
        brand_name: string;
        shipping_preference: 'NO_SHIPPING';
        user_action: 'PAY_NOW';
      };
    };
  };
}

export interface PayPalCapture {
  id: string;
  status: string;
  amount?: PayPalMoney;
  custom_id?: string;
  invoice_id?: string;
  supplementary_data?: { related_ids?: { order_id?: string } };
}

export interface PayPalOrder {
  id: string;
  status: string;
  purchase_units?: Array<{
    reference_id?: string;
    custom_id?: string;
    amount?: PayPalMoney;
    payments?: { captures?: PayPalCapture[] };
  }>;
  links?: PayPalLink[];
}

// ── Subscriptions v1 ────────────────────────────────────────────────────────

export interface BillingCycle {
  frequency: { interval_unit: 'MONTH'; interval_count: 1 };
  tenure_type: 'TRIAL' | 'REGULAR';
  sequence: number;
  total_cycles: number;
  pricing_scheme: { fixed_price: PayPalMoney };
}

export interface CreatePlanBody {
  product_id: string;
  name: string;
  description: string;
  billing_cycles: BillingCycle[];
  payment_preferences: {
    auto_bill_outstanding: boolean;
    setup_fee_failure_action: 'CANCEL';
    payment_failure_threshold: number;
  };
}

export interface CreateSubscriptionBody {
  plan_id: string;
  custom_id: string;
  application_context: {
    brand_name: string;
    shipping_preference: 'NO_SHIPPING';
    user_action: 'SUBSCRIBE_NOW';
    return_url: string;
    cancel_url: string;
  };
}

export interface PayPalSubscription {
  id: string;
  status: string;
  plan_id?: string;
  custom_id?: string;
  start_time?: string;
  billing_info?: {
    last_payment?: { amount: PayPalMoney; time: string };
    next_billing_time?: string;
  };
  links?: PayPalLink[];
}

export interface SubscriptionTransaction {
  id: string;
  status: string;
  amount_with_breakdown: { gross_amount: PayPalMoney };
  time: string;
}

// ── Webhooks v1 ─────────────────────────────────────────────────────────────

export interface WebhookHeaders {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
}

export interface WebhookEvent {
  id: string;
  event_type: string;
  resource_type?: string;
  resource?: Record<string, unknown>;
  create_time?: string;
}
