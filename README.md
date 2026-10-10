# Plainbill

**Clear, visual patient bills for small, independent medical practices.**

Plainbill takes in insurance responses (835 remittance files, PDF EOBs) and self-pay visits, works
out exactly what each patient owes, and lets front-desk staff send a short, visual bill by email
with a PayPal payment link. No phone calls, no paper statements.

Built for the PayPal AI Hackathon. All patients, claims and amounts in this repo are synthetic.

> **Status: Phase 1 (foundation + staff dashboard).** The 835 parser, balance math, seed data,
> API and the AG Grid dashboard with live payment updates are done. EOB extraction, the Review &
> Send drawer, PayPal, email and the patient pages come in later phases.

## Quick start

Requirements: **Node 20.19+** (22 LTS recommended) and **pnpm 10**.

```bash
pnpm install
cp .env.example .env        # then fill in what you have; nothing is required for Phase 1
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

### Scripts

| Command                              | What it does                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| `pnpm dev`                           | API (Fastify, watch mode) + web (Vite) together                                       |
| `pnpm seed`                          | Reset the database and load the seed data through the real parsers                    |
| `pnpm seed:generate`                 | Regenerate `seed/data/*.835` and the self-pay CSV from `seed/src/spec.ts`             |
| `pnpm test`                          | All Vitest suites (core, seed reconciliation, API, web helpers)                       |
| `pnpm typecheck`                     | `tsc --noEmit` in every package                                                       |
| `pnpm lint` / `pnpm format`          | ESLint / Prettier                                                                     |
| `pnpm simulate:payment <name or id>` | Mark a balance paid and broadcast the event                                           |
| `pnpm check:license`                 | Validate `VITE_AG_GRID_LICENSE_KEY` against ag-grid-enterprise (never prints the key) |

## Architecture

```
                 ┌──────────────────────────── apps/web (Vite + React) ───────────────────────────┐
                 │  /dashboard: AG Grid Enterprise (grouping, master/detail, quick filter,        │
                 │  integrated charts, flashCells) + AG Charts side panel                          │
                 └───────────────▲───────────────────────────────▲────────────────────────────────┘
                     GET /api/*  │ JSON                     SSE  │ /api/events (payment, balances.changed)
                 ┌───────────────┴───────────────────────────────┴────────────────────────────────┐
  835 / CSV ───▶ │                     apps/api (Fastify + SQLite via Drizzle)                     │
 POST /api/      │  ingest ─▶ balances ─▶ invoices ─▶ payments ─▶ events ─▶ EventBus ─▶ SSE        │
  intake/835     │  every status change goes through the core status machine                      │
                 └───────────────────────────────▲────────────────────────────────────────────────┘
                                                 │ pure functions, no I/O
                 ┌───────────────────────────────┴────────────────────────────────────────────────┐
                 │ packages/core: 835 parser · CARC/RARC dictionary · balance math (integer cents)│
                 │ aging buckets · status machine · payment plans · self-pay CSV reader           │
                 └────────────────────────────────────────────────────────────────────────────────┘
   packages/ai (Phase 2): EOB extraction with per-field confidence, patient messages, Q&A, suggestions
   seed/: synthetic 835s + CSV → real parsers → same services the API uses
```

```
apps/web        Vite + React + TS dashboard (later: /intake, /pay/:token, /email-preview/:id)
apps/api        Fastify + TS, SQLite (better-sqlite3) via Drizzle ORM, Server-Sent Events
packages/core   Framework-free domain logic, fully unit-tested
packages/ai     Anthropic SDK wrappers (contracts only in Phase 1)
seed/           Synthetic 835 files, self-pay CSV, generator and seed script
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

### The 835 parser

`parse835` reads delimiters from the ISA segment, validates the envelope (SE segment count,
ST/SE, GS/GE and ISA/IEA control numbers), and normalizes BPR, TRN, DTM, N1 payer/payee, CLP,
NM1 (patient, rendering provider), CAS (claim and line level), SVC, AMT\*B6, MOA/LQ remark codes
and PLB. Errors name the segment position (`segment 23 (SVC): SVC02 is not a valid amount`).

### Seed data

`seed/src/spec.ts` describes the 13 visits from the brief. `pnpm seed:generate` writes seven 835
ERAs (one per payer payment) and a self-pay CSV to `seed/data/`. `pnpm seed` then parses those
files with the real parsers and loads them through the API's own ingest, invoice and payment
services. A test checks every row against a literal copy of the brief's table and asserts the
invariant per row.

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
| `POST /dev/simulate-payment/:balanceId` | **Dev only** (off when `NODE_ENV=production`)                                           |

## Environment variables

Copy `.env.example` to `.env` (gitignored). Both the API and Vite read the repo-root file; only
`VITE_*` values reach the browser.

| Variable                                   | Used by           | Phase | Notes                                                 |
| ------------------------------------------ | ----------------- | ----- | ----------------------------------------------------- |
| `ANTHROPIC_API_KEY`                        | api / packages/ai | 2     | EOB extraction, messages, Q&A                         |
| `ANTHROPIC_MODEL`                          | api / packages/ai | 2     | e.g. `claude-sonnet-5-5`                              |
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

## AI and PayPal (planned, per the brief)

- **Anthropic API** (`packages/ai`): PDF EOB → structured claim lines with per-field confidence
  (anything under 0.85 is flagged in Intake); plain-language patient message (default / simpler /
  Spanish) written from the computed balance; patient Q&A grounded only in that balance; one
  "AI suggests" action per row. 835 files are parsed by code, not AI.
- **PayPal**: Invoicing v2 (draft + send with PayPal's email off, partial payments with a $20
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
