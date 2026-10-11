# Plainbill

**Clear, visual patient bills for small, independent medical practices.**

Plainbill takes in insurance responses (835 remittance files, PDF EOBs) and self-pay visits, works
out exactly what each patient owes, and lets front-desk staff send a short, visual bill by email
with a PayPal payment link. No phone calls, no paper statements.

All patients, claims and amounts in this repo are synthetic.

## How it works

1. **Intake.** Drop an 835 remittance, a scanned PDF EOB or a self-pay CSV. Code parses the 835s
   and CSVs; Claude reads the EOB and says which fields it isn't sure of. Each uncertain reading
   is checked against the claim's math: a smudged "2?0.00" comes back as "$260 ✓ adds up,
   $250 ✗ doesn't".
2. **Dashboard** (AG Grid Enterprise): balances grouped by status, plain-English adjustment codes,
   aging, a **Breakdown** sparkline per row (discount / insurance paid / patient paid / still owed),
   **Chart this** (a live integrated chart of the rows on screen, by the current grouping), and an
   **AI suggests** column whose ✦ button does the next step in one click.
3. **Review & Send.** Claude drafts a warm, plain-language message (also simpler, or Spanish)
   from the computed numbers; a guard refuses any figure the code didn't compute. **Send invoice**
   creates a PayPal invoice (name, visit date, provider and amount only) and emails the patient
   our visual breakdown with PayPal's button.
4. **The patient** verifies with last name + date of birth, taps through a waterfall of how the
   bill was worked out, and can **ask the AI helper** ("why do I owe $240?", "can I pay over
   time?"). The helper answers only from this bill and can set up a payment or a plan through
   the **PayPal Agent Toolkit**, after the patient confirms. Or they pay with PayPal, Pay Later
   or a card, or start a 3/6-month interest-free PayPal plan.
5. **The payment lands** (capture, verified webhook, or the reconciliation poll) and the
   dashboard row **flashes green live**.

## Design principles

- **Money is code, never the model.** Integer cents end to end; every claim must satisfy
  `billed − contractual − insurancePaid = patientOwes` or it is refused. The model extracts,
  words and chooses; code computes every amount anyone sees, and checks every model output.
- **AI uncertainty is surfaced.** Low-confidence EOB fields become flags with the readings that
  do and don't reconcile; nothing uncertain reaches a patient without a human.
- **Agentic, with consent.** The patient helper proposes; a card shows code-computed amounts;
  the patient confirms; PayPal's own window takes the approval. Two confirmations, no surprises.
- **Minimal PHI** to PayPal and email; the details sit behind verification.
- **Robust payments.** One payment per PayPal id however it arrives; payments are mirrored onto
  the PayPal invoice so its link can't collect twice; an approved order whose page died is
  captured by the poll.

## Quick start

Requirements: **Node 20.19+** (22 LTS recommended) and **pnpm 10**.

```bash
pnpm install
cp .env.example .env        # fill in what you have; without ANTHROPIC_API_KEY the AI runs offline
pnpm seed                   # load the synthetic Harborview Family Medicine data
pnpm dev                    # API on :3001, dashboard on http://localhost:5173
```

Open <http://localhost:5173/dashboard>.

### Try it with the sample data

The seed is a fictional practice, Harborview Family Medicine, with 13 visits in every state
(review, denied, ready, sent, partially paid, paid). "Today" is pinned to 2026-10-10
(`DEMO_TODAY`) so aging and due dates line up with the data.

- **Send a bill:** with sandbox `PAYPAL_CLIENT_ID`/`PAYPAL_CLIENT_SECRET` set, open Maria Delgado's
  **Send invoice + 3-month plan** and click **Send invoice**. The email preview (**Email ↗** in
  the row's detail panel) links to her patient page.
- **Be the patient:** verify as `Delgado`, date of birth `04 / 17 / 1984`. Tap the bars, ask the
  helper "Why do I owe $240?", then pay with a PayPal sandbox buyer account or PayPal's sandbox
  test card (`4012888888881881`, any future expiry, any CVV), or start a plan.
- **Intake:** `pnpm seed --scenario=intake-demo` leaves out five visits; on **Intake**, click
  "Use the sample files" (or drop `bcbs_era_1008.835`, `aetna_eob_raman.pdf`, `uhc_eob_sept.pdf`
  and `selfpay_0929.csv` from `seed/data`) to see two AI-flagged fields.
- **A payment without PayPal:** `pnpm simulate:payment "Samuel Ortiz"` marks a sent bill paid
  and the dashboard row flashes green. `pnpm seed` resets everything.
- **AI suggests:** **✦ Refresh suggestions** above the grid; the ✦ button on a sent row emails a
  reminder or a plan offer.

Without `ANTHROPIC_API_KEY`, the AI parts run offline: recorded EOB reads, template messages and
a rule-based bill helper.

### Scripts

| Command                              | What it does                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| `pnpm dev`                           | API (Fastify, watch mode) + web (Vite) together                                       |
| `pnpm start`                         | Production: seed if the database is empty, then the API serving the built web app     |
| `pnpm paypal:webhook <https url>`    | Register the PayPal webhook for a deployed URL; prints `PAYPAL_WEBHOOK_ID`            |
| `pnpm seed`                          | Reset the database and load the seed data through the real parsers                    |
| `pnpm seed --scenario=intake-demo`   | Same, minus the five visits in the Intake sample files (upload them yourself)         |
| `pnpm seed:generate [--pdfs]`        | Regenerate `seed/data` 835s and CSVs (and the scanned EOB PDFs) from `spec.ts`        |
| `pnpm ai:record`                     | Read the EOB PDFs with Claude, save the recordings, check them against ground truth   |
| `pnpm test`                          | All Vitest suites (core, seed reconciliation, API, web helpers)                       |
| `pnpm typecheck`                     | `tsc --noEmit` in every package                                                       |
| `pnpm lint` / `pnpm format`          | ESLint / Prettier                                                                     |
| `pnpm simulate:payment <name or id>` | Mark a balance paid and broadcast the event                                           |
| `pnpm check:license`                 | Validate `VITE_AG_GRID_LICENSE_KEY` against ag-grid-enterprise (never prints the key) |

With `pnpm dev` running, `curl -X POST localhost:3001/api/dev/paypal/sync` runs one PayPal
reconciliation pass immediately.

## Architecture

```
                 ┌──────────────────────────── apps/web (Vite + React) ───────────────────────────┐
                 │  /dashboard: AG Grid Enterprise (grouping, master/detail, quick filter,        │
                 │  sparklines, integrated charts, flashCells) + AG Charts · Review & Send drawer │
                 │  /intake: drop files → AG Grid preview with AI flags → approve                 │
                 │  /pay/:token (patient, mobile): verify → bill → PayPal v6 SDK buttons / plans  │
                 │  /email-preview/:id: the bill email as sent                                    │
                 └───────────────▲───────────────────────────────▲────────────────────────────────┘
                     GET /api/*  │ JSON                     SSE  │ /api/events (payment, balances.changed)
                 ┌───────────────┴───────────────────────────────┴────────────────────────────────┐
 835 / EOB PDF ▶ │                     apps/api (Fastify + SQLite via Drizzle)                     │
 / CSV upload    │  intake staging ─▶ balances ─▶ invoices ─▶ payments ─▶ events ─▶ SSE            │
                 │  every status change goes through the core status machine                      │
                 │  send ─▶ PayPal Invoicing v2 + email (Resend / outbox)                         │
                 │  PayPal capture · webhook (verified) · reconciliation poll ─▶ one payment each │
                 └───────────────▲─────────────────────────────────────────────────▲──────────────┘
                                 │ pure functions, no I/O         REST + webhooks  │
                                 │                                 ┌───────────────┴──────────────┐
                                 │                                 │ PayPal: Invoicing v2,        │
                                 │                                 │ Orders v2, Subscriptions v1  │
                                 │                                 └──────────────────────────────┘
                 ┌───────────────┴────────────────────────────────────────────────────────────────┐
                 │ packages/core: 835 parser · CARC/RARC dictionary · balance math (integer cents)│
                 │ aging buckets · status machine · payment plans · self-pay CSV reader           │
                 └────────────────────────────────────────────────────────────────────────────────┘
   packages/ai: Claude reads EOB PDFs (structured output + per-field confidence) and drafts patient
                messages from computed facts; both are checked by code before anyone sees them
   seed/: synthetic 835s, scanned EOB PDFs, CSVs → real parsers / recorded AI reads → same services
```

```
apps/web        Vite + React + TS: /dashboard, /intake, /email-preview/:id, /pay/:token (patient)
apps/api        Fastify + TS, SQLite (better-sqlite3) via Drizzle ORM, Server-Sent Events
packages/core   Framework-free domain logic, fully unit-tested
packages/ai     Anthropic SDK: EOB extraction, message drafting, guards, templates
seed/           Synthetic 835s, scanned EOB PDFs, self-pay CSVs, recorded AI reads, seed script
docs/           design-reference.html (visual source of truth), paypal-notes.md
```

### Money is code, never the model

- Amounts are **integer cents** end to end; decimal text is parsed straight to cents.
- `computePatientBalance` enforces `billed − contractual − insurancePaid = patientOwes` on every
  claim (plus X12 line and claim balancing and CLP05), and throws a `ReconciliationError` with
  the figures if source data doesn't add up. `POST /api/intake/835` is all-or-nothing on that.
- "Contractual" means every adjustment the patient is not responsible for (CAS groups CO, OA, PI,
  CR). For a denial that is the whole write-off, so a denied claim reconciles to $0 owed.
- The grid's adjustment labels are recomputed from the stored claim through `@plainbill/core`, so
  the UI cannot show money the core didn't produce.

### AI is checked, not trusted

- **EOB extraction** (`ClaudeEobExtractor`): the PDF goes to Claude with a structured-output
  schema. The model transcribes values as printed and lists every field it is less than 95% sure
  of, with a note and alternative readings. It never calculates.
- **Flags with answers** (`eobToClaims`): every value is parsed into cents and reconciled by
  `@plainbill/core`. Fields below 0.85 confidence become flags, and each alternative reading is
  re-reconciled: Priya's blurred "2?0.00" comes back as "$260 ✓ adds up, $250 ✗ doesn't".
  Approving with an open flag lands the visit in **Needs review** with that question.
- **Patient messages** (`ClaudeMessageDrafter`): Claude sees only first name, provider, visit date
  and the computed amounts — no services, codes or insurance IDs. A guard rejects any dollar
  figure the core didn't compute (or anything that looks like a medical code); one retry, then a
  deterministic template. "Send" refuses an edited message with an unknown figure.
- **Offline mode**: without `ANTHROPIC_API_KEY`, EOBs are read from recordings of Claude's
  output for those exact PDFs (keyed by SHA-256) and messages come from templates. Live requests
  use server-side refusal fallbacks (`fallbacks: "default"`).

### PayPal, end to end

- **Send** (`services/send.ts`): a PayPal Invoicing v2 draft with the patient's name and one line,
  "Services on Oct 3, 2026 with Dr. Patel", and **no email address**, so PayPal keeps it payable
  and sends nothing; then `send` with `send_to_recipient: false`. The payer-view link goes behind
  the PayPal button in our email. The "Partial, $20 min" option sets
  `configuration.partial_payment`. If PayPal refuses, the balance stays Ready; the PayPal draft id
  is saved immediately so a retry never creates a second invoice.
- **Patient page** (`services/patient.ts`): the link's token shows nothing but the practice name.
  Last name + date of birth (5 tries, then a 15-minute lock) issues a 30-minute, HMAC-signed,
  HttpOnly cookie for that one bill. The bill's explanations are fixed templates filled with
  computed amounts. Orders v2: the server decides the amount (full, or a partial of at least $20
  only when staff allowed it), creates the order, and captures it on approval.
- **Plans** (Subscriptions v1): one cached catalog product; one plan per amount schedule. When a
  balance doesn't split evenly, the first payment carries the extra cents (a one-cycle priced
  trial, then regular cycles): $368 over 6 months is $61.35, then 5 × $61.33.
- **One payment per PayPal id** (`services/paypal-sync.ts`): the capture response, a webhook and
  the reconciliation poll all report money; each PayPal transaction id is recorded once (unique
  `external_id`), pushes one SSE `payment` event (the grid flash), and checkout/plan payments are
  copied onto the PayPal invoice as recorded payments so its link can't collect twice. Paying
  off a balance cancels any plan still running. Overpayments are logged for a refund.
- **Webhooks** (`POST /api/webhooks/paypal`): verified with PayPal's verify-webhook-signature API
  using the raw body byte for byte; deduplicated by event id; refused without `PAYPAL_WEBHOOK_ID`.
- **Official PayPal UI only**: `@paypal/react-paypal-js` (v6 SDK web components) on the patient
  page and PayPal's hosted button image in email, never restyled.
- Tests run against `FakePayPal`, which mirrors what the sandbox did (see
  [docs/paypal-notes.md](docs/paypal-notes.md)).

### The patient's bill helper (agentic commerce)

- `ClaudeBillAssistant` (`packages/ai`) answers from `BillFacts` only: this bill as computed by
  `@plainbill/core` (amounts, patient-share breakdown, plain service names, plan options). Every
  answer shows its source ("Based on BlueCross's statement for your Oct 3 visit").
- Tools: `propose_pay_in_full`, `propose_payment_plan`, `propose_partial_payment` (only those the
  staff offered) and `offer_phone_call`. A tool call creates a **card** with code-computed amounts
  and dates (`services/assistant.ts`); the model never sets an amount.
- **Confirm** runs the stored action through **`@paypal/agent-toolkit`** with only `create_order`
  and `create_subscription` enabled and code-built input. PayPal's own button then takes the
  patient's approval, and the normal capture / plan routes record the payment.
- Answers are checked like messages (only the bill's figures, no codes); one retry, then a
  deterministic answer. Questions are rate-limited per bill.

### AI suggests

- `ClaudeSuggester` sends each open row's situation (status, days, amounts, review or denial
  reason, opens; no names) and gets one action from a fixed list plus a short label (structured
  output). `checkSuggestion` rejects actions that don't fit the status, long labels and figures
  that aren't the row's; those rows get `ruleSuggestion` instead.
- The ✦ button runs the action: the Review & Send drawer, a friendly reminder email, or a
  reminder offering a plan (which also turns plans on for the patient page). Resubmitting denied
  claims to payers isn't built; those buttons say so.

### The 835 parser

`parse835` reads delimiters from the ISA segment, validates the envelope (SE segment count,
ST/SE, GS/GE and ISA/IEA control numbers), and normalizes BPR, TRN, DTM, N1 payer/payee, CLP,
NM1 (patient, rendering provider), CAS (claim and line level), SVC, AMT\*B6, MOA/LQ remark codes
and PLB. Errors name the segment position (`segment 23 (SVC): SVC02 is not a valid amount`).

### Seed data

`seed/src/spec.ts` describes the 13 fictional visits. `pnpm seed:generate` writes six 835
ERAs (one per payer payment) and two self-pay CSVs to `seed/data/`; `--pdfs` also renders the two
scanned EOBs (Priya's and Tomás's), each with one deliberately smudged character. `pnpm seed`
parses everything with the real parsers (EOBs via the recorded Claude reads), stages the Intake
sample files exactly like an upload, and loads them through the API's own services. Tests check
every row against a literal copy of the expected table (`seed/src/expected.ts`) and assert the
invariant per row.

Samuel Ortiz is seeded as **Sent**, so there is always a bill to pay: paying him on Oct 10 makes
him "paid in 18 days". "Today" is pinned with `DEMO_TODAY=2026-10-10` so days-out and aging match
the data.

## API

All routes are under `/api`.

| Route                                            | Purpose                                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `GET /balances`                                  | Grid rows with line items, translated adjustments, aging, plan option                   |
| `GET /balances/:id`                              | One row                                                                                 |
| `GET /kpis`                                      | Outstanding, collected this month, average days to pay, review/ready counts             |
| `GET /charts/aging`                              | Open patient balances by 0–30 / 31–60 / 61–90 / 90+ days                                |
| `GET /charts/denials-by-payer`                   | Denials in the last 90 days, by payer, plus the most common reason                      |
| `POST /intake/835`                               | Raw 835 body (`text/plain`), `?fileName=`; parses, reconciles, stores; skips duplicates |
| `GET /events`                                    | Server-Sent Events: `payment`, `balances.changed`                                       |
| `GET /practice`, `GET /health`                   | Shell info, health check                                                                |
| `GET /intake/batch`                              | The open intake batch: files, items, AI flags (with which readings add up)              |
| `POST /intake/files`                             | Multipart upload of 835 / EOB PDF / CSV files into the batch                            |
| `PATCH /intake/items/:id/flags`                  | Confirm or change a flagged field `{ path, value }`                                     |
| `POST /intake/batch/approve`, `discard`          | Approve (flagged → review, rest → ready) or discard the batch                           |
| `GET /balances/:id/drawer`                       | Review & Send data: review flags, draft, plan options, email preview                    |
| `POST /balances/:id/message`                     | Draft a message: `variant` default, simpler or spanish, plus `paymentOption`            |
| `PUT /balances/:id/draft`                        | Save the draft message and payment option                                               |
| `POST /balances/:id/send`                        | Create + send the PayPal invoice, issue the pay link, email the patient                 |
| `GET /balances/:id/email`                        | The bill email as sent (or a render of the current draft)                               |
| `POST /balances/:id/review/resolve`              | Resolve an AI flag on a review row; refused if the claim would stop adding up           |
| `POST /balances/:id/review/ready`                | Review → Ready once nothing is left to confirm                                          |
| `GET /pay/:token`                                | Patient link: practice name only, plus whether this browser is verified                 |
| `POST /pay/:token/verify`                        | `{ lastName, month, day, year }` → session cookie + the bill                            |
| `GET /pay/:token/bill`                           | The bill (session required)                                                             |
| `POST /pay/:token/orders`                        | Create a PayPal order `{ amountCents?, fundingSource }` (amount checked server-side)    |
| `POST /pay/:token/orders/:id/capture`            | Capture after approval; records the payment once                                        |
| `POST /pay/:token/plan`, `/plan/confirm`         | Start a 3/6-month PayPal subscription; confirm after approval (records payment 1)       |
| `POST /webhooks/paypal`                          | PayPal webhooks (signature-verified, deduplicated)                                      |
| `POST /pay/:token/assistant`                     | Ask the bill helper `{ message, history }` → answer, source, cards                      |
| `POST /pay/:token/assistant/actions/:id/confirm` | Run a confirmed card via the PayPal Agent Toolkit → order or subscription id            |
| `POST /suggestions/refresh`                      | Rewrite AI suggests for every open row (Claude, checked; or rules)                      |
| `POST /balances/:id/remind`                      | Email a reminder `{ offerPlanMonths? }`                                                 |
| `POST /dev/simulate-payment/:balanceId`          | **Dev only** (off when `NODE_ENV=production`)                                           |
| `POST /dev/paypal/sync`                          | **Dev only**: one reconciliation pass over open PayPal invoices and plans               |
| `POST /dev/intake-samples`                       | **Dev only**: add sample files from `seed/data` to the intake batch                     |

## Environment variables

Copy `.env.example` to `.env` (gitignored). Both the API and Vite read the repo-root file; only
`VITE_*` values reach the browser.

| Variable                                   | Used by           | Notes                                                 |
| ------------------------------------------ | ----------------- | ----------------------------------------------------- |
| `ANTHROPIC_API_KEY`                        | api / packages/ai | EOB extraction, messages; unset = offline mode        |
| `ANTHROPIC_MODEL`                          | api / packages/ai | `claude-opus-5-5` (or `claude-sonnet-5-5`)            |
| `AI_EOB_MODE`                              | api               | `auto` (recording if one exists), `live`, `recorded`  |
| `EOB_RECORDINGS_DIR`                       | api               | Default `seed/data/eob-recordings`                    |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | api               | Sandbox REST app                                      |
| `PAYPAL_ENV`                               | api               | `sandbox`                                             |
| `PAYPAL_WEBHOOK_ID`                        | api               | Webhook signature check; webhooks refused when unset  |
| `PAYPAL_SYNC_SECONDS`                      | api               | Reconciliation poll interval (default 20, 0 = off)    |
| `VITE_PAYPAL_CLIENT_ID`                    | web               | Optional: the API hands the page `PAYPAL_CLIENT_ID`   |
| `VITE_AG_GRID_LICENSE_KEY`                 | web               | Without it the grid runs in trial mode                |
| `RESEND_API_KEY`                           | api               | Patient emails; unset = outbox + preview page         |
| `EMAIL_FROM`                               | api               | Sender (default `onboarding@resend.dev`)              |
| `EMAIL_TO_OVERRIDE`                        | api               | Send every patient email here instead (testing)       |
| `APP_BASE_URL`                             | api               | Base for pay links; https makes cookies `Secure`      |
| `SESSION_SECRET`                           | api               | Signs patient sessions (random per process if unset)  |
| `SERVE_WEB`                                | api               | Serve `apps/web/dist` from the API (default: in prod) |
| `API_PORT`                                 | api, Vite proxy   | Default 3001. In production the API listens on `PORT` |
| `DATABASE_PATH`                            | api, seed         | Default `apps/api/data/plainbill.db`                  |
| `DEMO_TODAY`                               | api               | Pin "today" (seed assumes `2026-10-10`)               |

## AI and PayPal

- **Anthropic API** (`packages/ai`): Messages API with PDF document input and structured
  outputs for EOB extraction; plain text for patient messages (default / simpler / Spanish).
  835 files are parsed by code, not AI. Also: the patient's bill helper (tool use, grounded in
  one bill) and "AI suggests" (structured output), both checked by code.
- **PayPal**: Invoicing v2 (draft + send with PayPal's emails off, partial payments with a $20
  minimum), Orders v2 with the v6 JS SDK buttons (PayPal, Pay Later, guest card), Subscriptions v1
  for 3/6-month interest-free plans, and verified webhooks plus a reconciliation poll driving the
  live dashboard update. Sandbox findings are in [docs/paypal-notes.md](docs/paypal-notes.md).
- **PayPal Agent Toolkit** (`@paypal/agent-toolkit`, Bedrock-style adapter driven from Claude's
  tool calls): `create_order` and `create_subscription` for the patient helper's confirmed actions.
- **Email**: Resend's REST API, or an outbox viewable at `/email-preview/:balanceId` when no key
  is set.

## Deploy (Render)

`render.yaml` is a Blueprint for one free web service: it builds the web app, and `pnpm start`
seeds the sample data when the database is empty and runs the API, which also serves the web app
(one origin, so the patient session cookie works). SQLite is on the instance disk, so a fresh or
re-woken instance starts from the sample data.

1. In Render: **New → Blueprint** → pick the repo. Fill in the
   secrets it asks for (`ANTHROPIC_API_KEY`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`,
   `VITE_AG_GRID_LICENSE_KEY`; optionally `RESEND_API_KEY` + `EMAIL_TO_OVERRIDE`).
2. After the first deploy: `pnpm paypal:webhook https://<service>.onrender.com` (locally, with the
   sandbox credentials in `.env`) and set the printed `PAYPAL_WEBHOOK_ID` in Render.
3. Optional: rehearse with `NODE_ENV=production pnpm start` locally after `pnpm --filter
@plainbill/web build`.

## Privacy

- **Synthetic data only.** No real patient information is used anywhere in this repo.
- PayPal gets the patient's name, the visit date, the provider and the amount ("Services on
  Oct 3, 2026 with Dr. Patel"), never the email address, services, codes or insurance IDs.
  Emails carry the amounts and the staff-approved message (checked for codes); the services
  list sits behind the verification page, which locks after 5 wrong tries.
- Staff pages have no login yet (a single front-desk user); don't deploy with real data.
- **Production use would require a Business Associate Agreement (BAA) with the AI provider**
  (and with the email provider), plus the usual HIPAA safeguards.

## License

[MIT](LICENSE)
