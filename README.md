# Plainbill

**Clear, visual patient bills for small, independent medical practices.**

Plainbill takes in insurance responses (835 remittance files, PDF EOBs) and self-pay visits, works
out exactly what each patient owes, and lets front-desk staff send a short, visual bill by email
with a PayPal payment link. No phone calls, no paper statements.

Built for the PayPal AI Hackathon. All patients, claims and amounts in this repo are synthetic.

> **Status: Phase 2 (Intake + AI EOB reading + Review & Send).** Done: the 835 parser, balance
> math, seed data, the AG Grid dashboard with live payment updates, the Intake page (835s, scanned
> EOB PDFs read by Claude with confidence flags, self-pay CSVs), and the Review & Send drawer with
> AI-drafted messages. "Send invoice" records the invoice and marks it Sent; creating the PayPal
> invoice and emailing the patient come in Phase 3, followed by the patient pages.

## Quick start

Requirements: **Node 20.19+** (22 LTS recommended) and **pnpm 10**.

```bash
pnpm install
cp .env.example .env        # fill in what you have; without ANTHROPIC_API_KEY the AI runs offline
pnpm seed                   # load the synthetic Harborview Family Medicine data
pnpm dev                    # API on :3001, dashboard on http://localhost:5173
```

Open <http://localhost:5173/dashboard>.

### Rehearse the live payment

With `pnpm dev` running, in another terminal:

```bash
pnpm simulate:payment "Samuel Ortiz"
```

Samuel's row moves from **Sent** to **Paid**, flashes green, and shows "✓ Paid via PayPal · just
now"; the KPIs and group totals update live. Under the hood this calls the dev-only endpoint
`POST /api/dev/simulate-payment/12`, which records the payment and pushes a Server-Sent Event, the
same path the PayPal webhook will use. Run `pnpm seed` again to reset (safe while the API runs).

### Rehearse Intake → Review & Send

```bash
pnpm seed --scenario=intake-demo    # leaves out the 5 visits in the Intake demo files
```

Open **Intake** and drop `seed/data/bcbs_era_1008.835`, `aetna_eob_raman.pdf`, `uhc_eob_sept.pdf`
and `selfpay_0929.csv` (or click "Use the sample files"). Plainbill finds 5 visits and flags 2
fields: Priya's smudged paid amount (only $260 makes her EOB add up) and Tomás's smudged
patient-share code. Confirm Priya's, then **Approve all 5**. On the dashboard, open Tomás's
"Check copay vs. coinsurance", pick the code, **Mark ready**, and send. Open Maria's
"Review & send" for the design's hero bill.

### Scripts

| Command                              | What it does                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| `pnpm dev`                           | API (Fastify, watch mode) + web (Vite) together                                       |
| `pnpm seed`                          | Reset the database and load the seed data through the real parsers                    |
| `pnpm seed --scenario=intake-demo`   | Same, minus the Intake demo files' visits (upload them live)                          |
| `pnpm seed:generate [--pdfs]`        | Regenerate `seed/data` 835s and CSVs (and the scanned EOB PDFs) from `spec.ts`        |
| `pnpm ai:record`                     | Read the EOB PDFs with Claude, save the recordings, check them against ground truth   |
| `pnpm test`                          | All Vitest suites (core, seed reconciliation, API, web helpers)                       |
| `pnpm typecheck`                     | `tsc --noEmit` in every package                                                       |
| `pnpm lint` / `pnpm format`          | ESLint / Prettier                                                                     |
| `pnpm simulate:payment <name or id>` | Mark a balance paid and broadcast the event                                           |
| `pnpm check:license`                 | Validate `VITE_AG_GRID_LICENSE_KEY` against ag-grid-enterprise (never prints the key) |

## Architecture

```
                 ┌──────────────────────────── apps/web (Vite + React) ───────────────────────────┐
                 │  /dashboard: AG Grid Enterprise (grouping, master/detail, quick filter,        │
                 │  integrated charts, flashCells) + AG Charts · Review & Send drawer             │
                 │  /intake: drop files → AG Grid preview with AI flags → approve                 │
                 └───────────────▲───────────────────────────────▲────────────────────────────────┘
                     GET /api/*  │ JSON                     SSE  │ /api/events (payment, balances.changed)
                 ┌───────────────┴───────────────────────────────┴────────────────────────────────┐
 835 / EOB PDF ▶ │                     apps/api (Fastify + SQLite via Drizzle)                     │
 / CSV upload    │  intake staging ─▶ balances ─▶ invoices ─▶ payments ─▶ events ─▶ SSE            │
                 │  every status change goes through the core status machine                      │
                 └───────────────────────────────▲────────────────────────────────────────────────┘
                                                 │ pure functions, no I/O
                 ┌───────────────────────────────┴────────────────────────────────────────────────┐
                 │ packages/core: 835 parser · CARC/RARC dictionary · balance math (integer cents)│
                 │ aging buckets · status machine · payment plans · self-pay CSV reader           │
                 └────────────────────────────────────────────────────────────────────────────────┘
   packages/ai: Claude reads EOB PDFs (structured output + per-field confidence) and drafts patient
                messages from computed facts; both are checked by code before anyone sees them
   seed/: synthetic 835s, scanned EOB PDFs, CSVs → real parsers / recorded AI reads → same services
```

```
apps/web        Vite + React + TS: /dashboard, /intake (later: /pay/:token, /email-preview/:id)
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
- **Offline / demo mode**: without `ANTHROPIC_API_KEY`, EOBs are read from recordings of Claude's
  output for those exact PDFs (keyed by SHA-256) and messages come from templates. Live requests
  use server-side refusal fallbacks (`fallbacks: "default"`).

### The 835 parser

`parse835` reads delimiters from the ISA segment, validates the envelope (SE segment count,
ST/SE, GS/GE and ISA/IEA control numbers), and normalizes BPR, TRN, DTM, N1 payer/payee, CLP,
NM1 (patient, rendering provider), CAS (claim and line level), SVC, AMT\*B6, MOA/LQ remark codes
and PLB. Errors name the segment position (`segment 23 (SVC): SVC02 is not a valid amount`).

### Seed data

`seed/src/spec.ts` describes the 13 visits from the brief. `pnpm seed:generate` writes six 835
ERAs (one per payer payment) and two self-pay CSVs to `seed/data/`; `--pdfs` also renders the two
scanned EOBs (Priya's and Tomás's), each with one deliberately smudged character. `pnpm seed`
parses everything with the real parsers (EOBs via the recorded Claude reads), stages the Intake
demo files exactly like an upload, and loads them through the API's own services. Tests check
every row against a literal copy of the brief's table and assert the invariant per row.

Samuel Ortiz is seeded as **Sent** rather than Paid so the live payment can be demoed: paying
him on Oct 10 yields the table's "paid in 18 days". "Today" is pinned with `DEMO_TODAY=2026-10-10`
so days-out and aging match the design.

## API

All routes are under `/api`.

| Route                                   | Purpose                                                                                 |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /balances`                         | Grid rows with line items, translated adjustments, aging, plan option                   |
| `GET /balances/:id`                     | One row                                                                                 |
| `GET /kpis`                             | Outstanding, collected this month, average days to pay, review/ready counts             |
| `GET /charts/aging`                     | Open patient balances by 0–30 / 31–60 / 61–90 / 90+ days                                |
| `GET /charts/denials-by-payer`          | Denials in the last 90 days, by payer, plus the most common reason                      |
| `POST /intake/835`                      | Raw 835 body (`text/plain`), `?fileName=`; parses, reconciles, stores; skips duplicates |
| `GET /events`                           | Server-Sent Events: `payment`, `balances.changed`                                       |
| `GET /practice`, `GET /health`          | Shell info, health check                                                                |
| `GET /intake/batch`                     | The open intake batch: files, items, AI flags (with which readings add up)              |
| `POST /intake/files`                    | Multipart upload of 835 / EOB PDF / CSV files into the batch                            |
| `PATCH /intake/items/:id/flags`         | Confirm or change a flagged field `{ path, value }`                                     |
| `POST /intake/batch/approve`, `discard` | Approve (flagged → review, rest → ready) or discard the batch                           |
| `GET /balances/:id/drawer`              | Review & Send data: review flags, draft, plan options, email preview                    |
| `POST /balances/:id/message`            | Draft a message: `variant` default, simpler or spanish, plus `paymentOption`            |
| `PUT /balances/:id/draft`               | Save the draft message and payment option                                               |
| `POST /balances/:id/send`               | Phase 2 stub: record the invoice, mark Sent (PayPal + email in Phase 3)                 |
| `POST /balances/:id/review/resolve`     | Resolve an AI flag on a review row; refused if the claim would stop adding up           |
| `POST /balances/:id/review/ready`       | Review → Ready once nothing is left to confirm                                          |
| `POST /dev/simulate-payment/:balanceId` | **Dev only** (off when `NODE_ENV=production`)                                           |
| `POST /dev/intake-samples`              | **Dev only**: add sample files from `seed/data` to the intake batch                     |

## Environment variables

Copy `.env.example` to `.env` (gitignored). Both the API and Vite read the repo-root file; only
`VITE_*` values reach the browser.

| Variable                                   | Used by           | Phase | Notes                                                 |
| ------------------------------------------ | ----------------- | ----- | ----------------------------------------------------- |
| `ANTHROPIC_API_KEY`                        | api / packages/ai | 2     | EOB extraction, messages; unset = offline mode        |
| `ANTHROPIC_MODEL`                          | api / packages/ai | 2     | `claude-opus-5-5` (or `claude-sonnet-5-5`)            |
| `AI_EOB_MODE`                              | api               | 2     | `auto` (recording if one exists), `live`, `recorded`  |
| `EOB_RECORDINGS_DIR`                       | api               | 2     | Default `seed/data/eob-recordings`                    |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | api               | 3     | Sandbox REST app                                      |
| `PAYPAL_ENV`                               | api               | 3     | `sandbox`                                             |
| `PAYPAL_WEBHOOK_ID`                        | api               | 3     | Webhook signature verification                        |
| `VITE_PAYPAL_CLIENT_ID`                    | web               | 3     | JS SDK buttons                                        |
| `VITE_AG_GRID_LICENSE_KEY`                 | web               | 1     | Without it the grid runs in trial mode                |
| `RESEND_API_KEY`                           | api               | 3     | Patient emails                                        |
| `APP_BASE_URL`                             | api               | 3     | Base for pay links                                    |
| `API_PORT`                                 | api, Vite proxy   | 1     | Default 3001. In production the API listens on `PORT` |
| `DATABASE_PATH`                            | api, seed         | 1     | Default `apps/api/data/plainbill.db`                  |
| `DEMO_TODAY`                               | api               | 1     | Pin "today" (seed assumes `2026-10-10`)               |

## AI and PayPal

- **Anthropic API** (`packages/ai`, done): Messages API with PDF document input and structured
  outputs for EOB extraction; plain text for patient messages (default / simpler / Spanish).
  835 files are parsed by code, not AI. Next: patient Q&A grounded only in that balance and
  model-written "AI suggests" actions (today they are rule-based and seeded).
- **PayPal** (Phase 3): Invoicing v2 (draft + send with PayPal's email off, partial payments with a $20
  minimum), Orders v2 + JS SDK buttons (pay in full, Pay Later), Subscriptions for 3/6-month
  interest-free plans, verified webhooks driving the live dashboard update, and
  `@paypal/agent-toolkit` so the patient's AI helper can set up a plan after confirming.
  Sandbox findings go in [docs/paypal-notes.md](docs/paypal-notes.md).

## Privacy

- **Synthetic data only.** No real patient information is used anywhere in this repo.
- Invoices and emails will carry minimal PHI ("Services on Oct 3 with Dr. Patel"); the full
  breakdown sits behind the patient verification page.
- **Production use would require a Business Associate Agreement (BAA) with the AI provider**
  (and with the email provider), plus the usual HIPAA safeguards.

## License

[MIT](LICENSE)
