# Plan: "Your statement, explained"

Implementation plan for Claude Code. Read `CLAUDE.md` first; every rule there still applies.

## The idea in one paragraph

When staff press **Send invoice**, Plainbill also produces the practice's formal **patient
statement** as a PDF: an itemized paper-style bill with charges, insurance payment, write-off,
patient responsibility, aging, and a mail-in coupon. That's the document a clinic has always
sent. The email links to it. On the patient page, Maria sees **that same statement** with yellow
highlighter marks on the lines that matter and hand-drawn arrows leading to short notes in the
margins ("A discount, not a bill: $400 comes off because Dr. Patel is in your network"). The notes
can be in her language. Claude writes the notes; code decides where they go and what every number is.

Visual reference (from the design canvas):

- `docs/design/statement-explained/desktop.png`: three columns (notes | statement | notes) with arrows
- `docs/design/statement-explained/phone-en.png`: thumbnail with numbered pins, zoom strip, one note at a time
- `docs/design/statement-explained/phone-es.png`: same paper, notes in Spanish
- `docs/design/statement-explained/how-it-works.png`: the pipeline
- `seed/samples/outbound_harborview_statement_delgado.pdf` (and `seed/samples/generator/statements.py`):
  the statement layout to port. Note titles in the screenshots fell back to a serif font; the real
  design uses **Caveat 700** for them.

## Why it's simple

Plainbill draws the statement itself, so **it already knows the exact box of every line**. That
means no text recognition, no AI-guessed coordinates, and no PDF parsing. One pure layout function
produces drawing operations plus named **anchors**. Three things consume them:

```
                   ┌──────────────► pdf-lib  → statement.pdf  (download / print)
balance ─► model ─► layout (ops + anchors)
                   └──────────────► React SVG → on-screen statement + highlights + arrows
                                        ▲
             anchors + facts ─► Claude ─┘ notes (guarded; template fallback)
```

The on-screen statement is an SVG drawn from the **same ops** as the PDF (`viewBox="0 0 612 792"`,
units are PDF points). Highlights line up by construction because they use the anchor rects in the
same coordinate space.

## Guardrails (from CLAUDE.md, applied here)

- **Money:** every amount on the statement and in every note comes from `packages/core`. The model
  never writes a number we didn't compute. The guard rejects any note containing an amount outside
  that anchor's allowed set, or a 5-digit code.
- **Minimal PHI in email:** **do not attach the PDF to the email.** The email gets a "View your
  statement" button that goes to the pay page. The PDF and the annotated view are only served after
  last name + DOB verification. The statement shows procedure codes (a real itemized statement does).
  That's fine behind verification and never goes to email or PayPal. Update the header comment in
  `packages/core/src/procedures.ts` ("Patients never see codes") to say codes appear only on the
  verified statement.
- **Descriptions:** use our own wording (`describeProcedure(code).label`, upper-cased) on the
  statement, never official CPT descriptors.
- **No paper card collection:** the coupon keeps "Make checks payable to" but **drops the
  credit-card number / signature fields** from the sample. Replace them with a "Pay online" box
  (pay URL + statement ID).
- **Uncertainty is surfaced:** if a note fails the guard twice, fall back to the deterministic
  template for that note. If a language has no template and the model fails, show English notes
  with a one-line banner ("We couldn't translate this right now. Call (555) 014-2290 for help in
  your language.").
- Synthetic data only. Small commits; `pnpm test && pnpm typecheck` before each.

---

## Phase 1: `packages/core/src/statement/` (pure, fully tested)

New folder, exported from `packages/core/src/index.ts`.

### 1a. `model.ts`: `buildStatementModel(input): StatementModel`

Input (plain data the API already has):

```ts
interface StatementInput {
  practice: { name; addressLine1; addressLine2; city; state; zip; phone; hours; payUrlHost };
  patient: { firstName; lastName; addressLines: string[] };   // add address to seed patients if missing
  accountNumber: string;      // e.g. patient id zero-padded to 6
  statementId: string;        // e.g. `S${invoiceId.toString().padStart(7, '0')}`
  statementDate: IsoDate;     // invoice sentOn (or today for a preview)
  dueDate: IsoDate;
  payUrl: string;
  visit: { date; providerName | null; payerName; payerShortName; selfPay: boolean;
           paymentDate | null; traceNumber | null };
  lines: Array<{ code: string; description: string; chargeCents: number }>;
  contractualCents: number;              // CO total (or self-pay discount)
  insurancePaidCents: number | null;
  patientShare: PatientShare;            // deductible / coinsurance / copay / other
  payments: Array<{ date: IsoDate; amountCents: number }>;
  remainingCents: number;
  aging: Record<'current'|'31-60'|'61-90'|'91-120'|'120+', number>;  // reuse aging.ts
  planOffer: { months: 3|6; firstCents; regularCents } | null;
}
```

Output: an ordered list of **activity rows**, each `{ id, date, code, description, chargeCents?,
creditCents?, balanceCents? , anchor?: AnchorKind }` with a running balance, plus the totals and
the message text. Rows, in order:

1. One per service line (`anchor: 'charges'`, grouped).
2. `CLAIM FILED TO <PAYER>` (insurance only; no amounts).
3. `INS PMT <PAYER SHORT> EFT <trace>` (credit, `anchor: 'insurance_payment'`).
4. `CONTRACTUAL ADJ - <PAYER SHORT>` (code `CO45`, credit, `anchor: 'discount'`). For self-pay:
   `SELF-PAY RATE` (`anchor: 'discount'`) only if a discount exists.
5. `PT RESP: DED x COINS y COPAY z` (codes `PR1 PR2 PR3` as present, no amount column,
   `anchor: 'patient_responsibility'`).
6. One per patient payment, `PATIENT PAYMENT - THANK YOU` (credit, `anchor: 'patient_payment'`).

**Invariants (tests):** the final running balance equals `remainingCents`; `billed − contractual −
insurancePaid − patientPaid = remaining`; every credit row's amount equals a field in the input;
there's no `insurance_payment` row when `insurancePaidCents` is null or 0. Test with Maria
($850 → $240), Samuel (copay), Aisha (self-pay, two payments, $600 left), and Kevin (self-pay, no
discount).

### 1b. `layout.ts`: `layoutStatement(model): StatementLayout`

```ts
type Op =
  | { t: 'text'; x; y; s: string; font: 'sans'|'sans-bold'|'mono'|'mono-bold'; size; align?: 'left'|'right'|'center'; color? }
  | { t: 'rect'; x; y; w; h; fill?; stroke?; lineWidth? }
  | { t: 'line'; x1; y1; x2; y2; lineWidth?; dash?: [number, number] };

type AnchorKind = 'amount_due' | 'charges' | 'insurance_payment' | 'discount'
                | 'patient_responsibility' | 'patient_payment' | 'messages';

interface Anchor {
  id: string;                 // 'amount_due', 'charges', 'payment-2', …
  kind: AnchorKind;
  rect: { x; y; w; h };       // PDF points, TOP-LEFT origin (y grows down)
  style: 'highlight' | 'loop';// single row/value → highlighter; multi-row block → hand-drawn loop
  side: 'left' | 'right';     // which margin its note goes in
  attach: 'left' | 'right' | 'bottom';   // where the arrow lands on the rect
  quote: string;              // printed text for the "On your bill:" chip, e.g. "CO45 −400.00"
  amountsCents: number[];     // the figures a note about this anchor may mention
}

interface StatementLayout { width: 612; height: 792; ops: Op[]; anchors: Anchor[] }
```

- Port the geometry from `seed/samples/generator/statements.py` (letter size, top-left
  coordinates, Helvetica/Courier sizes). Coordinates are top-left based. The PDF renderer flips y.
- Rows render in Courier 7.2 pt, 11 pt apart; headers in Helvetica Bold. Keep 2–3 empty rows
  after the activity, then the aging boxes and the MESSAGES box. That's the realistic look.
- **Only WinAnsi characters** (pdf-lib standard fonts can't encode `▲`, `✓` or emoji). Use `-` or
  `–`, not `−`, in the PDF, but use `−` in note chips on screen.
- Side assignment (matches the design): amount_due → right (attach bottom), charges → left (loop),
  insurance_payment → right, discount → left, patient_responsibility → right, patient_payment →
  right, messages → left (loop).
- `amountsCents` per anchor: amount_due = [remaining]; charges = [billed, …line charges];
  insurance_payment = [insurancePaid]; discount = [contractual, billed]; patient_responsibility =
  [ded, coins, copay, other, patientShareTotal, remaining]; patient_payment = [that payment,
  remaining]; messages = [remaining, plan first/regular amounts].

Tests: anchors exist for every non-zero amount; every rect lies inside the page and inside the
activity table; no two `highlight` rects overlap; `layoutStatement` is deterministic (snapshot the
anchors, not the ops).

### 1c. `notes-template.ts`: `templateStatementNotes(model, layout, lang: 'en'|'es')`

Deterministic notes per anchor, in the order 1…n (amount_due, charges, insurance_payment,
discount, patient_responsibility, patient_payment…, messages). Same style as `waterfall()` in
`apps/api/src/services/patient.ts`: a title of ≤ 5 words, a body of ≤ 35 words, amounts via
`formatMoneyShort`. Use the copy from the design as the English reference:

| kind | title | body (Maria) |
|---|---|---|
| amount_due | This is what you owe | **$240.00**, and that's the whole amount. The bigger numbers further down are the full price before insurance. |
| charges | What you had done | Your Oct 3 visit with Dr. Patel: a check-up, blood work, and a heart test (EKG). Full price before insurance: **$850**. |
| insurance_payment | Your insurance paid $210 | Tidewater sent the clinic **$210** on Oct 8. Nothing for you to do on this line. |
| discount | A discount, not a bill | **$400** comes off because Dr. Patel is in your insurance network. You never pay this part. |
| patient_responsibility | Why there's still $240 | **$200** goes toward your yearly deductible, the amount you pay before insurance pays more. **$40** is your share of the heart test. |
| messages | You have options | Pay it all now, or split it into **3 payments of $80** with no fees. Questions? Call (555) 014-2290. |

Service names in the charges note come from the `patient` wording in `procedures.ts`. Don't
claim "20%" unless a coinsurance rate is actually stored (it isn't today), so leave the percentage
out. Spanish templates use the same structure. Tests cover both languages and check every amount
against `anchor.amountsCents` with the same `findAmounts` logic as the guard.

---

## Phase 2: API (`apps/api`)

### 2a. `services/statement.ts`

- `statementInput(ctx, invoiceId)` gathers everything for `StatementInput` from `getBalanceRows`,
  `claimLines`, `visits.paymentDate` / `traceNumber`, `payments`, `invoices` and `practices`.
  Patients need a mailing address. Add nullable `address_line1`, `address_line2`, `city`, `state`
  and `zip` to `patients` (Drizzle migration) and fill them in the seed spec (fictional addresses,
  e.g. Maria: 418 Seacliff Ave Apt 2B, Harborview CA 94000).
- `statementFor(ctx, invoiceId) → { layout, model }`. It's cheap, so recompute on each request; no
  caching needed.

### 2b. `services/statement-pdf.ts`

- `renderStatementPdf(layout): Promise<Uint8Array>` using **pdf-lib**. It's already in the
  workspace via `seed/`; add it to `apps/api` dependencies, which is not a new dependency for the
  repo. It walks the ops, maps `sans`→Helvetica, `mono`→Courier, flips y (`792 − y`), and handles
  right/center alignment with `font.widthOfTextAtSize`. Set the title/creator metadata and a fixed
  creation date (the statement date) so output is deterministic.
- Test: render Maria's statement, extract the text with pdf-lib or a tiny text check, and assert
  that `$240.00`, `CO45` and `-400.00` are present.

### 2c. Routes

Patient routes go in `routes/patient.ts` behind `verifiedInvoice`. They inherit `cache-control:
no-store`.

| Route | Returns |
|---|---|
| `GET /api/pay/:token/statement` | `PatientStatement { layout: StatementLayout; statementId; pdfPath }` |
| `GET /api/pay/:token/statement.pdf` | `application/pdf`, `Content-Disposition: inline; filename="Harborview-statement-S0000012.pdf"` |
| `GET /api/pay/:token/statement/notes?lang=es` | `StatementNotes` (Phase 3) |

Staff route: `GET /api/balances/:id/statement.pdf` (preview from the drawer, works before send
with today's date and a placeholder statement ID).

Add `PatientStatement`, `StatementNotes`, `StatementNote` and the re-exported `StatementLayout` /
`Anchor` types to `contract.ts`.

### 2d. Email and send

- `services/email.ts` → `renderBillEmail`: add a secondary link **"View your itemized statement"**
  → the pay URL with `#statement`. No attachment, no codes in the email. The existing breakdown bar
  stays.
- `services/send.ts` → after `markInvoiceSent`, kick off note generation for `en` and `es`
  **without awaiting it** (fire-and-forget through `ctx.queue` or a plain promise with logged
  errors). That way the patient page has AI notes ready, and send latency doesn't change.

---

## Phase 3: AI notes (`packages/ai/src/annotate/`)

Mirror `message/drafter.ts` + `message/guard.ts`.

- `facts.ts`: `AnnotateFacts = MessageFacts` (reuse) plus `anchors: Array<{ id, kind, quote,
  amountsCents }>` plus `language: { code: 'en'|'es'|'ht'|'zh'|'vi'|…, name: 'Haitian Creole' }`.
- `annotator.ts`: `ClaudeStatementAnnotator.annotate(facts) → { notes, source, model, notes[] }`.
  - Use the same client/model config (`ANTHROPIC_MODEL`), the same `beta.messages.create` call
    shape as the drafter, and `effort: 'low'`.
  - Use **structured output** with a zod schema: `{ notes: [{ anchorId, title, body }] }`. Each
    anchor id appears exactly once.
  - System prompt essentials: a kind front-desk voice; reading level grade 5–6; title ≤ 5 words,
    body ≤ 35 words; use only figures from that anchor's list, written like `$240` or `$240.00`;
    never compute; no codes, diagnoses or insurance IDs in the text (the chip shows the printed
    line separately); write in `{language.name}`; keep the provider's name exactly as given; if
    unsure what a line means, say "Call the office to check this line" rather than guessing.
- `guard.ts`: `checkNote(note, anchor, facts)` returns issues for: an unknown anchor id, a missing
  anchor, an amount not in `anchor.amountsCents ∪ {remaining}`, a 5-digit code, an empty
  title/body, or a length overflow. One retry with the issues spelled out (like the drafter). Then,
  **per note**, fall back to the template (en/es). For other languages, fall back to the English
  template and set `fallback: true`.
- `TemplateStatementAnnotator` is used when there's no API key. Wire both in `packages/ai/src/index.ts`
  the same way the drafter is wired.
- Tests (`packages/ai/test/annotate.test.ts`) use a fake client: an invented amount → rejected →
  template; a missing anchor → template for that anchor; Spanish passes the guard; a refusal →
  template.

API side: a `statement_notes` table (`invoice_id`, `lang`, `notes` json, `source`
`'ai'|'template'|'mixed'`, `model`, `created_at`, unique `(invoice_id, lang)`).
`GET …/statement/notes?lang=` returns the cached row, or generates, stores and returns it. Allowed
langs: `en, es, ht, zh, vi, ko, ru, tl, fr, pt` (validate; default `en`). Rate-limit generation per
invoice the same way `QuestionLimiter` does. Regenerate notes when the balance changes (e.g. after a
payment): store a `balance_hash` (remaining + paid cents) on the row and treat a mismatch as a cache
miss.

```ts
interface StatementNote { anchorId: string; n: number; title: string; body: string; quote: string }
interface StatementNotes { lang: string; notes: StatementNote[]; source: 'ai'|'template'|'mixed'; fallback: boolean }
```

`n` (1…k) and `quote` come from code, not the model.

---

## Phase 4: Patient page (`apps/web/src/pages/pay/`)

### 4a. New files

- `statement/StatementSvg.tsx`: renders `layout.ops` into `<svg viewBox="0 0 612 792">`. Use
  `font-family: Helvetica, Arial, 'Liberation Sans', sans-serif` and `Courier, 'Courier New',
  monospace`, with `text-anchor` for alignment and white page plus soft shadow. Give it
  `role="img"` and an `aria-label` ("Your itemized statement from Harborview Family Medicine,
  amount due $240.00"). The notes list is the accessible content.
- `statement/Highlights.tsx`: draws one element per anchor inside the same SVG (it shares the
  viewBox):
  - `highlight`: a rect, fill `rgba(245,197,66,0.45)`, `mix-blend-mode: multiply`, slightly uneven
    radius, rotated ±0.3°, seeded by anchor id.
  - `loop`: a hand-drawn closed path around the rect (a superellipse with ±3% radius jitter and an
    overshoot past the start point). Stroke `#1D5C5C`, width 2.25 (in screen px; use
    `vector-effect: non-scaling-stroke`).
- `statement/Arrows.tsx`: an absolutely positioned overlay `<svg aria-hidden>` covering the whole
  section. It measures the note cards and anchor rects (`getBoundingClientRect`, re-run on
  `ResizeObserver` and font load). Each arrow is a cubic curve from the card's inner edge to the
  anchor's `attach` point, with control points ~40% of the horizontal gap in and ±6 px seeded
  jitter. The arrowhead is an open V, 13 px long at ±28°. Stroke `#1D5C5C`, 2.25 px, round caps.
- `statement/NoteCard.tsx`: cream card `#FFFDF8`, 1 px `#E5E1D9` border, radius 12, soft shadow,
  rotated ±0.4–0.7° alternating. The teal number badge is 26 px. The title is in **Caveat 700**,
  28 px, `#134545`. The body is Figtree 15/22. The chip "On your bill: CO45 −400.00" is in IBM Plex
  Mono 11.5 px on `#ECEAE5`.
- `statement/StatementExplained.tsx`: data loading (`payApi.statement`, `payApi.statementNotes`),
  language state, the "Highlights on/off" toggle (`aria-pressed`), a "Download PDF" link to
  `statement.pdf`, and the layout switch below.
- `statement/LanguagePicker.tsx`: segmented buttons (English, Español, Kreyòl, 中文, More ▾).
  Persist the choice in `localStorage` (wrapped in try/catch). Changing it fetches notes, shows
  skeleton cards, and keeps the statement in place.
- Add **Caveat 700** to the existing Google Fonts link in `apps/web/index.html`.

### 4b. Desktop layout (≥ 1100 px)

CSS grid `minmax(260px,340px) minmax(520px,712px) minmax(260px,340px)`, 56 px gaps. The statement
is in the middle at its column width; scale = `columnWidth / 612`.

Note placement per column: the desired top = `anchor.centerY * scale − cardHeight/2`. Sort by
desired top, then push down to keep a 24 px gap. If the last card overflows the section bottom, do
a reverse pass pushing up. Cards are absolutely positioned in their column; measure heights first
(render invisible, measure, then place, all in one `useLayoutEffect`).

### 4c. Phone layout (< 1100 px)

Matches `phone-en.png`:

- The statement is shown full width (cropped to y 100–590 pt) with **numbered pins** beside each
  anchor (18 px; the active one is 24 px with an amber ring) and the highlighter only on the active
  anchor.
- A **zoom strip** (64 px tall, 2 px teal border) shows the active anchor's rows at 1.6×. This is
  the same `StatementSvg` with a cropped `viewBox` around the anchor. A short hand-drawn arrow runs
  from the active highlight to the strip.
- One `NoteCard` at a time with **Previous / “4 of 6” / Next** buttons (44 px). Tapping a pin
  jumps to that note. Swipe left/right on the card does the same.
- A sticky "Pay $240 or pay over time" button scrolls to `#pay`.

### 4d. Motion (the demo moment)

On first view, the highlights sweep in left to right (`scaleX` 0→1, 250 ms each), then each arrow
draws itself (`stroke-dashoffset`, 350 ms, 150 ms stagger, in note order), and each card fades up
as its arrow lands. Clicking a card pulses its highlight and the reverse also works. Disable all of
this under `prefers-reduced-motion`.

### 4e. Page chrome and hero (desktop `desktop.png`, phone `phone-en.png`)

- **Top bar** (`PayPage.tsx`, after verification): a 36 px teal rounded-square monogram (the
  practice's first initial), the practice name (Figtree 600 16 px), and a sub-line "Secure bill for
  Maria D. · verified" (first name + last initial; 13 px `#5C6766`). On the right is the "Notes in"
  label and the `LanguagePicker`. On phone the bar is the monogram + name + a **globe pill button**
  showing the current language. It opens a bottom sheet listing every language (radio buttons,
  44 px rows).
- **Hero:** "Hi Maria — you owe" (20 px `#3E4A4B`), the amount (60 px / 700, tabular), and a sub-line
  that depends on state:
  - insurance: "Visit Oct 3 with Dr. Patel · insurance has already paid its part"
  - self-pay: "Visit Jun 20 with Dr. Kim · self-pay rate"
  - partial: "… · you've paid $600 so far"
  - plan: "… · payment plan: 1 of 3 paid"
  - paid: "This bill is paid. Thank you!"
- **Hero buttons** (desktop, right-aligned, 48 px tall):
  - **Ask about this bill** (sparkle icon, outline) scrolls to `AskAboutBill` and focuses its input.
  - **Pay over time** (teal outline) scrolls to `PayOptions` with the 3-month plan pre-selected. Hide
    it when no plan is offered or one is active.
  - **Pay $240** (filled teal) scrolls to `#pay`.

  On phone these collapse into the sticky bottom button ("Pay $240 or pay over time", or "Pay $240"
  when no plan is offered), and "Ask about this bill" becomes a link under the note card. Hide all
  pay buttons when the bill is paid.
- **Statement caption row** (above the statement, statement-column width): "The bill you got in the
  mail, explained" (16 px 600) on the left. On the right are the **Highlights on/off** pill (amber
  swatch + label, `aria-pressed`; off hides the highlights, loops and arrows but keeps the cards) and
  a **Download original** link (the PDF).
- **Footnote** under the statement, centered 13 px: "Notes written by AI from this statement. Every
  amount is checked against the clinic's records before you see it." Use "Notes written from this
  statement…" when `source === 'template'`. Add a small **"How this works"** link that opens a
  dialog with the five steps from `how-it-works.png` in plain words.
- **Footer** (already exists): "Prefer a person? Call (555) 014-2290, Mon–Fri 8–5. · practice ·
  address".

### 4f. Note body formatting

Notes are plain text from the server. The client formats them safely, with no HTML from the model:

- every `$…` amount → `<b>`
- the practice phone number → `<a href="tel:…">`
- nothing else.

Titles are plain text.

### 4g. Page language (chrome strings, not just notes)

The Spanish phone board localizes the page itself ("Hola Maria — usted debe", "‹ Anterior",
"5 de 6", "Siguiente ›", "Pagar $240 o en cuotas"). Add a tiny string table,
`apps/web/src/pages/pay/i18n.ts`, with `t(key, vars)` for the strings in `BillStep`, the hero, the
statement section, the pager, the sticky button, the caption row, the footnote and the footer.
Write **en** and **es** by hand; add **ht** if time allows. Other languages translate the notes
only, and the chrome stays English. Set `<html lang>` to the chosen language. Pass `lang` to the
`AskAboutBill` request so the helper answers in it (the assistant already takes free text; add one
line to its system prompt: "Answer in {language}"). PayPal's own buttons stay as PayPal renders
them.

### 4h. States the statement section must handle

| State | Statement | Notes |
|---|---|---|
| Insurance, open (Maria) | full activity | amount_due, charges, insurance_payment, discount, patient_responsibility, messages |
| Copay only (Samuel) | PR3 row | the patient_responsibility note explains the copay |
| Self-pay with discount | SELF-PAY RATE row | the discount note says "self-pay rate", with no insurance note |
| Self-pay, no discount (Kevin) | charges only | no discount note |
| Partial (Aisha) | payment rows, aging in 91–120 | one patient_payment note ("You paid $300 on Jul 15. Thank you"); the messages note offers a plan |
| Plan active | unchanged statement | the messages note becomes "You're on a 3-month plan: 1 of 3 paid. Next $80 on Nov 9" |
| Paid | final balance $0.00 | the amount_due note becomes "You're all paid up"; hide pay buttons |
| Loading | gray page skeleton (612:792 ratio) + 3 card skeletons | — |
| Statement request fails | hide the section and show the waterfall only (no error on screen; log it) | — |
| Notes request fails | show highlights with numbered pins only, plus "Explanations aren't available right now" | — |

### 4i. Accessibility

- The notes render as an `<ol>` in note order. On desktop it's split visually into two columns, but
  the DOM order is 1…n.
- Each highlight has a focusable twin: a visually hidden `<button>` per anchor ("Note 4: A discount,
  not a bill") that focuses and pulses its card. Phone pins are real `<button>`s with the same
  labels. The pager buttons are ≥ 44 px.
- Arrows, loops and highlights are `aria-hidden`. The zoom strip has `role="img"` with an
  `aria-label` built from `anchor.quote`.
- Contrast: the note body is `#1C2B2D` on `#FFFDF8`, and the chip text is `#3E4A4B` on `#ECEAE5`
  (both pass AA).

### 4j. Integration into `BillStep.tsx`

The new order is:

1. hero
2. **`<StatementExplained id="statement">`** (new)
3. the existing waterfall card, retitled "The short version"
4. `AskAboutBill`
5. `PayOptions`
6. payments
7. footer

Remove the "What you were seen for" card (note 2 covers it). The terms card starts collapsed. Add
`payApi.statement(token)` and `payApi.statementNotes(token, lang)` to `lib/api.ts`.

---

## Phase 5: Staff side (small)

- In the Review & Send drawer, add a **"Preview statement (PDF)"** link next to the email preview
  (`/api/balances/:id/statement.pdf`).
- `EmailPreview.tsx` already renders the email HTML, so the new "View your itemized statement"
  link appears automatically.
- Log `statement.viewed` and `statement.language` events (in the existing `events` table, from the
  notes route). Show "Viewed statement · Español" in the grid's detail panel timeline, so staff
  know which language Maria reads.

## Phase 6: Seed, docs, demo

- Seed: patient addresses (above). Nothing else; statements are computed on demand.
- `README.md`: add "Itemized statement + AI explanations" to the AI features section, with one
  architecture line (layout → PDF + SVG; Claude writes notes, code places them and checks the
  numbers), the new routes, and a "How the highlights work" subsection carrying the five steps
  and three guardrails from `how-it-works.png` (also embed that image).
- `docs/paypal-notes.md`: no change.

## Design coverage (every element in the mockups → where it's built)

| Design element | Task |
|---|---|
| Top bar: monogram, practice name, "Secure bill for Maria D. · verified" | 4e |
| "Notes in" + English / Español / Kreyòl / 中文 / More ▾ | 4a `LanguagePicker`, 4g |
| Phone globe pill + language sheet | 4e |
| Hero greeting, amount, state-aware sub-line | 4e |
| Ask about this bill / Pay over time / Pay $240 buttons | 4e |
| "The bill you got in the mail, explained" caption | 4e |
| Highlights on/off toggle | 4a, 4e |
| Download original | 2c, 4e |
| The statement itself (coupon, account box, activity table, aging, messages) | 1b, 4a `StatementSvg`, 2b PDF |
| Yellow highlighter on single rows/values | 1b `style: 'highlight'`, 4a `Highlights` |
| Hand-drawn loops around multi-row blocks | 1b `style: 'loop'`, 4a `Highlights` |
| Hand-drawn arrows with open V heads | 4a `Arrows` |
| Numbered note cards, Caveat titles, slight rotation | 4a `NoteCard` |
| Bold amounts and tap-to-call phone in note bodies | 4f |
| "On your bill: CO45 −400.00" chip | 1b `quote`, 4a `NoteCard` |
| Notes placed beside their lines, three per side, no overlaps | 1b `side`, 4b |
| Footnote "Notes written by AI…" + How this works | 4e |
| Prefer a person? footer | 4e (exists) |
| Phone: thumbnail with numbered pins | 4c |
| Phone: active highlight + arrow to zoom strip | 4c |
| Phone: zoom strip at 1.6× | 4c |
| Phone: one note at a time, Previous / 4 of 6 / Next, swipe | 4c |
| Phone: sticky Pay button | 4c, 4e |
| Spanish board: Spanish chrome + Spanish notes, English paper | 3, 4g |
| Highlights sweep + arrows drawing in order | 4d |
| How it works (5 steps + 3 guardrails) | README (Phase 6) + the "How this works" dialog (4e) |

One deliberate change from the mockup: the coupon's credit-card fields become a "Pay online" box
(see Guardrails).

## Acceptance checklist

- [ ] Maria's statement PDF matches `seed/samples/outbound_harborview_statement_delgado.pdf`
      except that the card fields are replaced by the Pay online box. Its final balance is $240.00.
- [ ] Desktop: six notes, three per side, and every arrow lands on its highlight at 1280, 1440 and
      1920 px wide.
- [ ] Phone (390 px): pins, zoom strip, and a stepper through 6 notes.
- [ ] Español: the statement doesn't change; the notes **and the page text** (hero, pager, sticky
      button) are in Spanish; amounts are identical.
- [ ] Every row of the "Design coverage" table is visibly implemented.
- [ ] All states in 4h render correctly with the seed patients (Maria, Samuel, Kevin, Aisha, Linda).
- [ ] Keyboard only: Tab reaches every note via the hidden anchor buttons; the phone pins and pager
      work with Enter/Space.
- [ ] Highlights off hides the highlights, loops and arrows; under reduced motion nothing animates.
- [ ] Kill the API key: the template notes appear, with no error shown to the patient.
- [ ] A guard test proves an invented amount never reaches the patient.
- [ ] Aisha (self-pay, partial): the patient_payment anchors show, there's no insurance anchor, and
      $600 is left.
- [ ] The email has no attachment and no codes; the PDF returns 401 without the session cookie.
- [ ] `pnpm test` and `pnpm typecheck` pass.

## Out of scope (later)

- A patient uploading a photo of a bill from another provider. That would need OCR and AI-located
  anchors, which this design deliberately avoids.
- Multi-page statements (one visit fits on one page; assert it in `layoutStatement`).

## Suggested commit sequence

1. `core: statement model + tests`
2. `core: statement layout with anchors + tests`
3. `core: template notes (en, es) + tests`
4. `api: patient addresses migration + seed`
5. `api: statement service, PDF renderer, routes`
6. `ai: statement annotator + guard + tests`
7. `api: statement_notes cache + notes route; generate on send`
8. `web: StatementSvg + highlights (static)`
9. `web: desktop notes + arrows`
10. `web: phone stepper + zoom strip`
11. `web: top bar, hero buttons, caption row, footnote + How this works dialog`
12. `web: language picker, i18n strings (en/es), helper answers in the chosen language`
13. `web: states (partial, plan, paid, self-pay, loading, errors) + accessibility`
14. `web: motion; BillStep integration`
15. `email + drawer links + viewed/language events; README`
