# Demo video (under 3 minutes)

A shot list for the YouTube submission. Times are targets; total ≈ 2:50.

## Before recording

- `pnpm seed --scenario=intake-demo` (or the hosted demo after a fresh deploy, then
  `/intake` → "Use the sample files" is available because `ENABLE_DEV_ROUTES=true`).
- `.env`: PayPal sandbox credentials, `ANTHROPIC_API_KEY`, and for a real inbox shot
  `RESEND_API_KEY` + `EMAIL_TO_OVERRIDE=<your inbox>`.
- Two browser windows side by side: staff dashboard (1440 wide) and the patient page in a phone
  frame (device toolbar, 390 wide).
- A PayPal sandbox **personal** account (developer.paypal.com → Sandbox → Accounts), or use the
  guest card form with PayPal's sandbox test Visa `4012888888881881`, any future expiry, any CVV.

## Shots

| Time      | Screen                   | Action                                                                                                                                 | Say (roughly)                                                                                                                                                      |
| --------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0:00–0:15 | Dashboard                | Hold on the grid, KPIs, charts                                                                                                         | "Small practices still mail confusing paper bills. Plainbill turns insurance paperwork into a clear bill a patient can pay from their phone."                      |
| 0:15–0:45 | Intake                   | Drop the four sample files. Click Priya's amber "$260" flag: "$260 ✓ adds up, $250 ✗ doesn't". Confirm. Approve all 5.                 | "Claude reads the scanned EOB and tells us what it isn't sure about. Code checks every reading against the claim's math, so the human only confirms what matters." |
| 0:45–1:15 | Dashboard → drawer       | Maria's ✦ "Send invoice + 3-month plan". Show the AI message, tap "Spanish", back. Send invoice. Toast: PayPal invoice number.         | "The message is AI-written, but every number comes from code — a guard refuses anything else. Send creates the PayPal invoice and emails Maria."                   |
| 1:15–1:30 | Email (inbox or preview) | Show the email: amount, bar, PayPal button. Tap "See full breakdown".                                                                  | "Minimal health data in the email; the details are behind verification."                                                                                           |
| 1:30–2:05 | Phone: patient page      | Verify (Delgado, 04/17/1984). Tap the waterfall bars. Ask "Why do I owe $240?" then "Can I pay over time?" → plan card → Confirm plan. | "Maria asks the AI helper. It answers only from her bill, shows its source, and offers a plan. When she confirms, the PayPal Agent Toolkit sets it up."            |
| 2:05–2:30 | Phone → PayPal           | Approve in PayPal (Subscribe), or pay in full with the card form. Confirmation screen (1 of 3 paid / paid).                            | "She approves in PayPal's own window — two confirmations, no surprises."                                                                                           |
| 2:30–2:45 | Dashboard (other window) | Maria's row flashes green, moves to Partially paid / Paid; KPIs tick.                                                                  | "The payment lands and the front desk sees it instantly."                                                                                                          |
| 2:45–2:55 | Dashboard                | ✦ Refresh suggestions; hover a reminder.                                                                                               | "AI suggests the next step for every balance — one click to do it."                                                                                                |

## Talking points to keep

- Money math is deterministic code (integer cents, invariant enforced); the model extracts,
  words and chooses — it never computes.
- PayPal: Invoicing v2, Orders v2 + v6 JS SDK (PayPal, Pay Later, card), Subscriptions plans,
  verified webhooks, Agent Toolkit. AG Grid Enterprise for the dashboard. Hosted on Render.
- Synthetic data only; production would need a BAA with the AI and email providers.
