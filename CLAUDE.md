# Plainbill

Patient billing for small, independent medical practices (1–10 providers). Plainbill takes in
insurance responses (835 remittance files, PDF EOBs) and self-pay visits, works out exactly what
each patient owes, and lets front-desk staff send a clear, visual bill by email with a PayPal
payment link. No phone calls, no paper statements.

Built for the **PayPal AI Hackathon** (Devpost). Deadline: **Nov 12, 2026, 3:00pm EST**.
The submission must include a public repo with an MIT LICENSE file, a working hosted demo or
complete run instructions, and a YouTube demo video under 3 minutes. Judging covers technical
implementation (PayPal + AI), design, impact, innovation, and presentation. We're also targeting
the "Best Use of AG Grid", "Best Use of Agentic Commerce", "Best Use of PayPal + AI" and
"Best Use of Render" prizes.

## The demo loop (everything serves this)

1. Staff uploads an 835 or a PDF EOB → AI parses it → fields it's unsure about are flagged.
2. Staff approves → rows land in the AG Grid dashboard, grouped by status.
3. Staff opens a row → the Review & Send drawer shows an AI-drafted plain-language message
   and payment options → **Send invoice**.
4. Patient gets a short email with a breakdown and a Pay button → verifies with last name + DOB
   → sees the interactive bill → asks the AI helper "why do I owe $240?" → pays or starts a plan.
5. A PayPal webhook fires → the dashboard row flashes green live. **This is the hero moment.**

## Non-negotiable rules

- **Money math is deterministic code, never the LLM.** Every amount the patient sees comes from
  `packages/core`. The LLM only extracts fields (with confidence) and explains numbers it's given.
  Invariant, enforced by tests: `billed − contractualAdjustments − insurancePaid = patientOwes`.
  Store money as integer cents.
- **Minimal PHI crosses to PayPal or email.** Invoices and emails say things like
  "Services on Oct 3 with Dr. Patel". No diagnosis codes, no CPT descriptions, no insurance IDs.
  The full breakdown lives behind the patient verification page.
- **Synthetic data only.** All patients, practices and payers are fictional. Never use real PHI.
  The README states that production use would require a BAA with the AI provider.
- **Official PayPal UI only.** Use the PayPal JS SDK buttons (`@paypal/react-paypal-js`) on web and
  PayPal's official static button image in email. Never restyle or imitate PayPal branding.
  No "Pal" in our own naming.
- **AI uncertainty is surfaced, not hidden.** Extraction returns per-field confidence; anything
  below threshold is flagged for a human in the Intake screen.
- Secrets live in `.env` (gitignored). Commit `.env.example` with every variable documented.

## Stack

TypeScript everywhere, pnpm workspaces.

```
apps/web        Vite + React + TS. AG Grid Enterprise (React), @paypal/react-paypal-js.
                Routes: /dashboard, /intake, /pay/:token (patient, mobile-first), /email-preview/:id
apps/api        Node + Fastify + TS. SQLite via Drizzle ORM. Server-Sent Events for live updates.
packages/core   Pure, framework-free, fully unit-tested (Vitest):
                - 835 (X12 EDI) parser → normalized claims
                - CARC/RARC code dictionary → plain-English labels
                - balance math (integer cents), aging buckets, status machine
                - payment plan schedules
packages/ai     Anthropic SDK wrappers: EOB PDF extraction (structured output + confidence),
                patient message drafting (plain / simpler / Spanish), grounded patient Q&A,
                staff "AI suggests" next action. Model from env ANTHROPIC_MODEL.
seed/           Synthetic 835 files, synthetic EOB PDFs, self-pay CSV, and the seed script.
docs/           design-reference.html (Claude Design export, the visual source of truth).
```

Deploy target: **Render** (web service for the api, static site for web, or one service serving both).

## PayPal integration (sandbox, Merchant app)

- **Invoicing v2**: create a draft invoice per patient balance, then send it with PayPal's own
  email turned off (we send our own email), using `allow_partial_payment` + `minimum_amount_due`
  for the "partial, $20 min" option. Verify the exact send flags in sandbox.
- **Orders v2 + JS SDK buttons**: pay-in-full and Pay Later on the patient page.
- **Subscriptions**: payment plans as a plan with a fixed number of billing cycles (3 or 6),
  no interest or fees.
- **Webhooks**: verify signatures. Handle at least INVOICING.INVOICE.PAID,
  PAYMENT.CAPTURE.COMPLETED, BILLING.SUBSCRIPTION.ACTIVATED, PAYMENT.SALE.COMPLETED.
  On payment: update the balance, push an SSE event, the grid flashes the row.
- **@paypal/agent-toolkit**: the patient-facing AI helper gets PayPal tools so it can actually
  set up a plan or create an order when the patient asks. Always confirm with the patient before
  any payment action. This is our agentic commerce story.

## AI features (packages/ai)

1. **EOB extraction**: PDF in → JSON of claim lines (billed, allowed, paid, CARC codes, patient
   responsibility by type) with a confidence score per field. 835 files are parsed by code,
   not AI.
2. **Patient message**: given the computed balance JSON, write a short, warm, plain-language
   explanation. Variants: default, "make simpler", Spanish. Never invent numbers.
3. **Patient Q&A**: answers grounded only in that patient's balance JSON. Shows its source
   ("Based on BlueCross's statement for your Oct 3 visit"). Offers a human phone number.
4. **AI suggests**: one recommended next action per row (resubmit with auth number, send
   reminder, offer 3-month plan, possible duplicate).

## Design system (from docs/design-reference.html)

Fonts: **Figtree** (UI), **IBM Plex Mono** (codes, IDs, file names). Use tabular numbers.
Deep teal is the only brand color; everything else is warm neutral.

| Token | Value | Use |
|---|---|---|
| `--teal-700` | `#1D5C5C` | primary, links, buttons |
| `--teal-800` | `#134545` | hover, mono accents |
| `--teal-50` | `#F3F8F7` | selected/expanded row |
| `--ink` | `#1C2B2D` | body text |
| `--ink-2` | `#3E4A4B` | secondary text |
| `--ink-3` | `#5C6766` | muted text |
| `--canvas` | `#EAE6DF` | app background |
| `--surface` | `#FFFFFF` | cards |
| `--surface-2` | `#FBFAF8` / `#F7F5F1` | subtle panels |
| `--line` | `#E5E1D9` | borders |
| `--chip` | `#ECEAE5` | code chips |

Status: every status = **icon + label + color**, never color alone (fg / bg / border):

| Status | Icon | fg | bg | border |
|---|---|---|---|---|
| Needs review | ! | `#7A4E00` | `#FAEFD6` | `#EFD9A0` |
| Denied | × | `#9B2C24` | `#FAE5E1` | `#F0C4BD` |
| Ready to invoice | → | `#454B4D` | `#ECEAE5` | `#DAD6CE` |
| Sent | ↗ | `#23518C` | `#E2EBF7` | `#C3D4EC` |
| Partially paid | ◐ | `#24633A` | `#FFFFFF` | `#A9D2B2` |
| Paid | ✓ | `#24633A` | `#E0F0E3` | `#B9DDC0` |

Aging pills: 0–30 `#ECEAE5`/`#454B4D` · 31–60 `#FAEFD6`/`#7A4E00` · 61–90 `#F8E1CC`/`#7D3F12` ·
90+ `#FAE5E1`/`#9B2C24`. Radius 8–12px, 8px spacing grid, soft shadows. Paid-now row flash `#E4F2E6`.

AG Grid: Quartz theme via the Theming API, customized to these tokens. Use row grouping by
status, master/detail (line items + translated adjustment codes), quick filter, aging-pill
cell renderer, an "AI suggests" cell with a one-click action button, `flashCells` on live
payment, and integrated charts / sparklines for aging and denials-by-payer.

## Seed data (fictional; the corrected numbers satisfy the invariant)

Practice: **Harborview Family Medicine**, 220 Harbor St, Suite 4, (555) 014-2290. Providers:
Dr. Anand Patel, Dr. Kim, Dr. Okoye. Front-desk user: Rosa M. "Today" = Oct 10, 2026.

| Patient | Provider | Visit | Payer | Billed | Discount | Ins. paid | Owes | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Maria Delgado (hero) | Patel | 10/3/26 | BCBS | 850 | 400 | 210 | 240 | ready | PR-1 $200 deductible + PR-2 $40 coinsurance. Lines: 99214 $350, 80053 $180, 93000 $320. DOB 04/17/1984 |
| Kevin Lam | Kim | 9/29/26 | Self-pay | 275 | – | – | 275 | ready | self-pay rate applied |
| Priya Raman | Patel | 10/1/26 | Aetna | 520 | 100 | 260 | 160 | review | EOB scan blurry: paid $260 or $280? |
| Tomás Herrera | Kim | 9/12/26 | UHC | 1,480 | 300 | 812 | 368 | review | code read as PR-3, may be PR-2 |
| Ellen Brooks | Patel | 9/30/26 | Self-pay | 310 | – | – | 310 | review | apply self-pay rate |
| Marcus Reid | Okoye | 8/25/26 | Aetna | 900 | 140 | 520 | 240 | review | possible duplicate |
| James Whitfield | – | 9/18/26 | BCBS | 2,400 | – | 0 | – | denied | MRI, CO-197 prior auth missing |
| Denise Okafor | – | 8/14/26 | UHC | 610 | – | 0 | – | denied | CO-16 referral missing |
| Grace Whitaker | – | 8/2/26 | Aetna | 1,040 | 100 | 690 | 250 | sent | opened 2×, not paid |
| Robert Chen | – | 9/5/26 | UHC | 600 | 70 | 380 | 150 | sent | not opened |
| Aisha Bello | – | 6/20/26 | Self-pay | 1,200 | – | – | 600 left | partial | $600 of $1,200 paid |
| Samuel Ortiz | Okoye | 9/22/26 | BCBS | 450 | 70 | 300 | 80 | paid | copay; paid in 18 days |
| Linda Park | Patel | 9/10/26 | Aetna | 560 | 50 | 410 | 100 | paid | paid in 6 days |

KPIs on the dashboard are **computed from data**, not hardcoded. The design's $18,420 figures are
illustrative; if we want realistic totals, generate extra background rows deterministically in
the seed script.

## Working conventions

- Small, reviewable commits with clear messages. Run `pnpm test` and `pnpm typecheck` before each.
- `packages/core` gets unit tests for everything, especially the 835 parser and balance math.
- Prefer boring, well-documented choices. No new dependency without a reason.
- Keep `README.md` current: what it is, architecture diagram, setup, env vars, which AI and
  PayPal APIs are used and how (the submission requires this).
- When a PayPal API behaves differently in sandbox than expected, note it in `docs/paypal-notes.md`.
