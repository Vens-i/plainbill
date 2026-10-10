# PayPal sandbox notes

What PayPal's APIs actually did in the sandbox, where it differed from the docs or from what we
expected. Plainbill's code (and the in-memory `FakePayPal` used by the tests) follows these
observations. Field names are from PayPal's OpenAPI specs
([paypal/paypal-rest-api-specifications](https://github.com/paypal/paypal-rest-api-specifications)).

## Invoicing v2 (tried 2026-10-10)

- **No recipient email → no PayPal email, still payable.** The spec says that if
  `billing_info.email_address` is omitted "the invoice is payable and a notification email is
  not sent." Confirmed: we send only `primary_recipients[0].billing_info.name`, and the patient's
  email address never reaches PayPal.
- **Send flags.** `POST /v2/invoicing/invoices/{id}/send` with
  `{ "send_to_invoicer": false, "send_to_recipient": false }` returns `200` with a single link
  `{ "rel": "payer-view", "href": "https://www.sandbox.paypal.com/invoice/p/#INV2-…" }`. That's
  the link behind the PayPal button in our email.
- **Status after send is `UNPAID`, not `SENT`.** The status enum has both; an invoice sent with
  no recipient reads `UNPAID`. The invoice's `detail.metadata.recipient_view_url` holds the same
  payer link (in a slightly different form), which we use when a send is retried after
  PayPal already accepted it.
- **`subject` and `note` in the send body are ignored** (the spec says so: "User-provided values
  for this field will not be honored"). We don't send them.
- **Invoice numbers auto-increment** (`0001`, `0002`, …) when `detail.invoice_number` is omitted,
  so reseeding the local database never collides with numbers already used in the sandbox.
- **Partial payments.** `configuration.partial_payment = { allow_partial_payment: true,
minimum_amount_due: { currency_code: "USD", value: "20.00" } }` is accepted and echoed back
  (not available to merchants in India, Brazil or Israel).
- **Recorded payments.** `POST …/payments` with `{ method: "PAYPAL", payment_date, amount }`
  returns `{ payment_id: "EXTR-…" }`; the transaction appears with `type: "EXTERNAL"` and the
  invoice moves to `PARTIALLY_PAID`. We record checkout and plan payments this way so the
  invoice's payer page can't collect money that was already paid on our page.
- **A partially paid invoice can't be cancelled**: `422` with issue
  `CANNOT_CANCEL_PAID_INVOICE`.
- **No idempotency header** on invoice create/send (Orders and Subscriptions accept
  `PayPal-Request-Id`; Invoicing doesn't list it). We store the PayPal invoice id on our draft
  row right after creating it, and a retried send reuses it.

## Orders v2

- Creating an order with `payment_source.paypal.experience_context` returns status
  `PAYER_ACTION_REQUIRED` with a `payer-action` link (instead of `CREATED`). The JS SDK
  buttons handle either.
- Capturing twice: `422` with issue `ORDER_ALREADY_CAPTURED`. We then read the order and use its
  existing capture, so a double click or retry never records two payments.

## Subscriptions v1

- A plan can mix a **priced** `TRIAL` cycle with `REGULAR` cycles. We use that when a balance
  doesn't divide evenly: $368 over 6 months is a one-cycle trial at $61.35 followed by five
  regular cycles at $61.33. Even splits use a single `REGULAR` cycle.
- A new subscription is `APPROVAL_PENDING` with an `approve` link until the payer approves in
  PayPal's window.

## Webhooks

- Verification uses `POST /v1/notifications/verify-webhook-signature`, sending the event
  **exactly as received** (spliced into the request body, never re-serialized).
- Webhooks need a public HTTPS URL, so they can't reach `localhost`. Locally, the
  reconciliation poll (`PAYPAL_SYNC_SECONDS`) and the capture response cover the same events.

## Still to verify

- With a live webhook URL (after deploying): which events arrive for a payment on the invoice's
  payer page (`INVOICING.INVOICE.PAID` and/or `PAYMENT.CAPTURE.COMPLETED`), whether a capture's
  id matches the invoice transaction's `payment_id`, and the exact `resource` shape for
  `INVOICING.*` events (we accept `resource.id` and `resource.invoice.id`).
- How long the first installment of a subscription takes to appear in
  `GET /v1/billing/subscriptions/{id}/transactions` after approval (the patient page waits up to
  ~8 seconds, then the poll or the `PAYMENT.SALE.COMPLETED` webhook records it).
- Pay Later eligibility for sandbox buyers (amount range, buyer country).

## Found while testing live (Phase 4)

- **A bodiless POST needs `Content-Type: application/json`.** `POST /v2/checkout/orders/{id}/capture`
  with no body and no content type answers `415 UNSUPPORTED_MEDIA_TYPE`. The client now sends the
  JSON content type on every non-GET request. (The fake didn't model headers; a unit test pins it.)
- **An approved order stays capturable after the page fails.** When that capture failed, the
  payer had already approved; the reconciliation poll now looks for orders that are `APPROVED`
  but not captured (created in the last 3 hours) and captures them, so a closed tab or a server
  error can't strand a payment. Verified with the sandbox guest card form and PayPal's published
  test Visa: capture `COMPLETED`, recorded on the PayPal invoice, invoice `MARKED_AS_PAID`.
- **Agent Toolkit results are JSON strings inside text blocks** (sometimes double-encoded), and
  fields outside its schema (`custom_id`) are dropped. Plainbill tracks toolkit-created orders
  and subscriptions by PayPal's id instead.
