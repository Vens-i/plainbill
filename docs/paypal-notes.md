# PayPal sandbox notes

Record here anything a PayPal API does in sandbox that differs from what the docs (or CLAUDE.md)
led us to expect: request flags, webhook payload shapes, timing, error codes.

_No PayPal integration yet. It starts after Phase 2._

## To verify when integrating

- Invoicing v2 send with PayPal's own email disabled (`send_to_recipient: false`?) while still
  getting a payable link.
- `allow_partial_payment` + `minimum_amount_due` behavior for the "$20 minimum" option.
- Which webhook fires first for an invoice paid by card vs. PayPal balance
  (`INVOICING.INVOICE.PAID` vs. `PAYMENT.CAPTURE.COMPLETED`), and whether both arrive.
- Subscriptions with a fixed number of billing cycles (3 / 6) and a first payment today.
