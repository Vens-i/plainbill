/**
 * The statement page, as drawing operations plus named anchors. One pure function, three
 * consumers: the PDF renderer (pdf-lib), the on-screen SVG, and the notes, whose highlights and
 * arrows land on the anchors' rects by construction.
 *
 * Geometry is ported from the sample generator (seed/samples/generator/statements.py): US
 * letter, PDF points, TOP-LEFT origin (y grows down). A text op's y is its baseline. Only
 * WinAnsi text is emitted, so the PDF's standard fonts can draw every character.
 */
import { STATEMENT_AGING } from '../aging';
import { formatMoney, type Cents } from '../money';
import { textWidth, winAnsi, type StatementFont } from './metrics';
import {
  isPastDue,
  statementAmount,
  statementDate,
  type ActivityRow,
  type AnchorKind,
  type StatementModel,
} from './model';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Op =
  | {
      t: 'text';
      x: number;
      /** Baseline. */
      y: number;
      s: string;
      font: StatementFont;
      size: number;
      align?: 'left' | 'right' | 'center';
      color?: string;
    }
  | {
      t: 'rect';
      x: number;
      y: number;
      w: number;
      h: number;
      fill?: string;
      stroke?: string;
      lineWidth?: number;
    }
  | {
      t: 'line';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      lineWidth?: number;
      dash?: [number, number];
      color?: string;
    }
  /** A small filled shape (the ▲ marks by the tear line, which WinAnsi can't encode as text). */
  | { t: 'poly'; points: Array<[number, number]>; fill: string };

export interface Anchor {
  /** "amount_due", "charges", "payment-2", … */
  id: string;
  kind: AnchorKind;
  /** PDF points, top-left origin. */
  rect: Rect;
  /** A single row or value gets a highlighter mark; a block of rows gets a hand-drawn loop. */
  style: 'highlight' | 'loop';
  /** Which margin its note goes in on desktop. */
  side: 'left' | 'right';
  /** Where the arrow lands on the rect. */
  attach: 'left' | 'right' | 'bottom';
  /** The printed text for the "On your bill:" chip (with a true minus, for the screen). */
  quote: string;
  /** The figures a note about this anchor may mention. */
  amountsCents: Cents[];
}

export interface StatementLayout {
  width: 612;
  height: 792;
  ops: Op[];
  anchors: Anchor[];
  /** The activity table's box. */
  table: Rect;
}

export const PAGE_WIDTH = 612;
export const PAGE_HEIGHT = 792;
const L = 30;
const R = PAGE_WIDTH - 30;
const INK = '#1b1d1f';
const LIGHT = '#e9eaeb';
const WHITE = '#ffffff';
const FOOTER_GRAY = '#8a8f93';
const ROW_PITCH = 11;
/** Lowest baseline the content may reach (the synthetic-data footer sits below it). */
const CONTENT_BOTTOM = 760;

/** "−400.00": on-screen chips use a true minus sign. */
const minus = (cents: Cents) => `−${statementAmount(cents)}`;

/** "220 Harbor St" + "Suite 4" → "220 HARBOR ST STE 4". */
function street(p: StatementModel['input']['practice']): string {
  const line2 = p.addressLine2 ? ` ${p.addressLine2.replace(/^suite\b/i, 'STE')}` : '';
  return `${p.addressLine1}${line2}`.toUpperCase();
}

/** Mod-10 check digit for the coupon's scan line. */
function checkDigit(digits: string): number {
  let sum = 0;
  for (const d of digits.replace(/\D/g, '')) sum += Number(d);
  return sum % 10;
}

/** Split text into lines no wider than `width` (word wrap; long words break by character). */
export function wrapText(text: string, font: StatementFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const trial = line ? `${line} ${word}` : word;
    if (textWidth(trial, font, size) <= width) {
      line = trial;
      continue;
    }
    if (line) lines.push(line);
    line = '';
    let rest = word;
    while (textWidth(rest, font, size) > width) {
      let n = rest.length;
      while (n > 1 && textWidth(rest.slice(0, n), font, size) > width) n--;
      lines.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines;
}

export function layoutStatement(model: StatementModel): StatementLayout {
  const { input, totals } = model;
  const p = input.practice;
  const ops: Op[] = [];
  const anchors: Anchor[] = [];

  const text = (
    x: number,
    y: number,
    s: string,
    font: StatementFont,
    size: number,
    extra: { align?: 'left' | 'right' | 'center'; color?: string } = {},
  ) => {
    if (s) ops.push({ t: 'text', x, y, s: winAnsi(s), font, size, ...extra });
  };
  const box = (
    x: number,
    y: number,
    w: number,
    h: number,
    o: { fill?: string; lineWidth?: number } = {},
  ) =>
    ops.push({
      t: 'rect',
      x,
      y,
      w,
      h,
      stroke: INK,
      lineWidth: o.lineWidth ?? 0.6,
      ...(o.fill ? { fill: o.fill } : {}),
    });
  const rule = (x1: number, x2: number, y: number, lineWidth: number, dash?: [number, number]) =>
    ops.push({ t: 'line', x1, y1: y, x2, y2: y, lineWidth, color: INK, ...(dash ? { dash } : {}) });

  const name = p.name.toUpperCase();
  const cityLine = `${p.city} ${p.state} ${p.zip}`.toUpperCase();
  const amountDue = formatMoney(totals.remainingCents);

  // ── Remittance coupon (top third) ─────────────────────────────────────────
  text(L, 34, name, 'sans-bold', 8.5);
  text(L, 44, street(p), 'sans', 7.5);
  text(L, 53, cityLine, 'sans', 7.5);
  text(L, 66, 'ADDRESS SERVICE REQUESTED', 'sans-bold', 6.2);

  // "Pay online" box, where the sample had credit-card fields: we never collect card numbers
  // on paper.
  const cx = 318;
  const cy = 26;
  const inner = R - cx - 12;
  box(cx, cy, R - cx, 88);
  text(cx + 6, cy + 10, 'PAY ONLINE: FAST, SECURE, NO STAMP NEEDED', 'sans-bold', 6.3);
  text(
    cx + 6,
    cy + 21,
    'OPEN THIS LINK ON YOUR PHONE OR COMPUTER (IT IS ALSO IN YOUR EMAIL):',
    'sans',
    5.8,
  );
  const urlLines = wrapText(input.payUrl, 'mono', 6.6, inner).slice(0, 2);
  urlLines.forEach((s, i) => text(cx + 6, cy + 32 + i * 9, s, 'mono', 6.6));
  const after = cy + 32 + urlLines.length * 9 + 5;
  text(
    cx + 6,
    after,
    "YOU'LL CONFIRM YOUR LAST NAME AND DATE OF BIRTH, THEN PAY WITH",
    'sans',
    5.8,
  );
  text(
    cx + 6,
    after + 8,
    'PAYPAL, PAY LATER OR A CARD. WE NEVER TAKE CARD NUMBERS ON PAPER.',
    'sans',
    5.8,
  );
  text(
    cx + 6,
    cy + 81,
    `STATEMENT ID ${input.statementId}  ·  ACCOUNT # ${input.accountNumber}`,
    'sans-bold',
    5.8,
  );

  // Amount box
  const ay = 122;
  const hx = [318, 392, 474, R];
  const heads = ['STATEMENT DATE', 'PAY THIS AMOUNT', 'ACCT. #'];
  const vals = [statementDate(input.statementDate, true), amountDue, input.accountNumber];
  for (let i = 0; i < 3; i++) {
    const x = hx[i]!;
    const w = hx[i + 1]! - x;
    box(x, ay, w, 12, { fill: LIGHT });
    box(x, ay + 12, w, 18);
    text(x + w / 2, ay + 9, heads[i]!, 'sans-bold', 5.8, { align: 'center' });
    text(x + w / 2, ay + 25, vals[i]!, i === 1 ? 'sans-bold' : 'sans', i === 1 ? 9 : 8, {
      align: 'center',
    });
  }
  box(318, ay + 30, 156, 12, { fill: LIGHT });
  text(396, ay + 39, 'SHOW AMOUNT PAID HERE', 'sans-bold', 5.8, { align: 'center' });
  box(474, ay + 30, R - 474, 12);
  text(480, ay + 39, '$', 'sans', 7);
  anchors.push({
    id: 'amount_due',
    kind: 'amount_due',
    rect: { x: hx[1]!, y: ay, w: hx[2]! - hx[1]!, h: 30 },
    style: 'highlight',
    side: 'right',
    attach: 'bottom',
    quote: `PAY THIS AMOUNT ${amountDue}`,
    amountsCents: [totals.remainingCents],
  });

  // Window address: a postal barcode (drawn as bars), then the patient's name and address.
  const wy = 128;
  let bx = L + 18;
  const digits = `${input.accountNumber}${input.statementId}`.replace(/\D/g, '').padEnd(12, '0');
  for (const [i, ch] of [...digits].entries()) {
    const bars = ((Number(ch) * 7 + i * 3) % 4) + 1;
    for (let b = 0; b < bars; b++) {
      ops.push({ t: 'rect', x: bx, y: wy - 3.2, w: 2.6, h: 2.6, fill: INK });
      bx += 3.6;
    }
    bx += 3.6;
  }
  [`${input.patient.firstName} ${input.patient.lastName}`, ...input.patient.addressLines].forEach(
    (s, i) => text(L + 18, wy + 12 + i * 10, s.toUpperCase(), 'sans', 8.5),
  );

  text(318, 186, 'MAKE CHECKS PAYABLE TO / REMIT TO:', 'sans-bold', 6);
  [name, street(p), cityLine].forEach((s, i) => text(330, 198 + i * 10, s, 'sans', 8.5));
  const scan = `${input.accountNumber}  ${input.statementId}  ${String(totals.remainingCents).padStart(9, '0')}`;
  text(318, 240, `${scan}  ${checkDigit(scan)}`, 'mono', 8);

  // Tear line
  const py = 262;
  rule(L - 10, R + 10, py, 0.7, [3, 2]);
  const detach = 'PLEASE DETACH AND RETURN TOP PORTION WITH YOUR PAYMENT';
  text(PAGE_WIDTH / 2, py + 9, detach, 'sans', 6.2, { align: 'center' });
  const half = textWidth(detach, 'sans', 6.2) / 2 + 9;
  for (const mid of [PAGE_WIDTH / 2 - half, PAGE_WIDTH / 2 + half]) {
    ops.push({
      t: 'poly',
      points: [
        [mid - 2.8, py + 9],
        [mid + 2.8, py + 9],
        [mid, py + 4.4],
      ],
      fill: INK,
    });
  }

  // ── Statement body ────────────────────────────────────────────────────────
  let y = py + 28;
  text(L, y, name, 'sans-bold', 11);
  text(R, y, 'PATIENT STATEMENT', 'sans-bold', 11, { align: 'right' });
  y += 10;
  text(L, y, `${street(p)} · ${cityLine} · ${p.phone}`, 'sans', 7);
  y += 10;
  const ix = [L, 150, 290, 450, R];
  const ih = ['ACCOUNT #', 'STATEMENT DATE', 'PATIENT NAME', 'PAGE'];
  const iv = [
    input.accountNumber,
    statementDate(input.statementDate, true),
    `${input.patient.firstName} ${input.patient.lastName}`.toUpperCase(),
    '1 OF 1',
  ];
  for (let i = 0; i < 4; i++) {
    const x = ix[i]!;
    const w = ix[i + 1]! - x;
    box(x, y, w, 11, { fill: LIGHT });
    box(x, y + 11, w, 15);
    text(x + w / 2, y + 8, ih[i]!, 'sans-bold', 5.8, { align: 'center' });
    text(x + w / 2, y + 22, iv[i]!, 'sans', 7.8, { align: 'center' });
  }
  y += 36;

  // Activity table
  const cols = {
    date: L + 4,
    patient: L + 50,
    code: L + 128,
    description: L + 170,
    charges: L + 418,
    credits: L + 478,
    balance: R - 4,
  };
  const tableTop = y;
  box(L, y, R - L, 12, { fill: LIGHT });
  const heads6 = [
    ['DATE', cols.date, 'left'],
    ['PATIENT', cols.patient, 'left'],
    ['CODE', cols.code, 'left'],
    ['DESCRIPTION', cols.description, 'left'],
    ['CHARGES', cols.charges, 'right'],
    ['CREDITS', cols.credits, 'right'],
    ['BALANCE', cols.balance, 'right'],
  ] as const;
  for (const [label, x, align] of heads6) text(x, y + 9, label, 'sans-bold', 6.2, { align });
  y += 22;

  const rowY = new Map<string, number>();
  for (const r of model.rows) {
    rowY.set(r.id, y);
    text(cols.date, y, statementDate(r.date), 'mono', 7.2);
    text(cols.patient, y, r.patient, 'mono', 7.2);
    text(cols.code, y, r.code, 'mono', 7.2);
    text(cols.description, y, r.description, 'mono', 7.2);
    if (r.chargeCents !== null)
      text(cols.charges, y, statementAmount(r.chargeCents), 'mono', 7.2, { align: 'right' });
    if (r.creditCents !== null)
      text(cols.credits, y, statementAmount(-r.creditCents), 'mono', 7.2, { align: 'right' });
    if (r.balanceCents !== null)
      text(cols.balance, y, statementAmount(r.balanceCents), 'mono', 7.2, { align: 'right' });
    y += ROW_PITCH;
  }
  y += 30;
  const table: Rect = { x: L, y: tableTop, w: R - L, h: y - tableTop - 8 };
  box(table.x, table.y, table.w, table.h);

  // Row anchors: a highlighter stroke from the CODE column to the balance, or a loop around the
  // charge lines.
  const rowRect = (r: ActivityRow): Rect => ({
    x: cols.code - 3,
    y: rowY.get(r.id)! - 7.6,
    w: R - 1 - (cols.code - 3),
    h: 10,
  });
  const charges = model.rows.filter((r) => r.anchor === 'charges');
  if (charges.length) {
    const top = rowY.get(charges[0]!.id)! - 8.5;
    const bottom = rowY.get(charges.at(-1)!.id)! + 3;
    anchors.push({
      id: 'charges',
      kind: 'charges',
      rect: { x: L + 2, y: top, w: R - L - 4, h: bottom - top },
      style: 'loop',
      side: 'left',
      attach: 'left',
      quote: charges.map((r) => r.code).join(' · '),
      amountsCents: [totals.billedCents, ...charges.map((r) => r.chargeCents!)],
    });
  }
  // The split visit: a highlight on the problem-visit line, inside the charges loop.
  const sv = model.splitVisit;
  if (sv) {
    const r = model.rows.find((x) => x.id === sv.problemRowId)!;
    const share = sv.problemShare;
    anchors.push({
      id: 'split_visit',
      kind: 'split_visit',
      rect: rowRect(r),
      style: 'highlight',
      side: 'right',
      attach: 'right',
      quote: `${r.code} ${statementAmount(r.chargeCents!)}`,
      amountsCents: [
        sv.problemChargeCents,
        share.totalCents,
        share.deductibleCents,
        share.coinsuranceCents,
        share.copayCents,
        share.otherCents,
      ].filter((c) => c > 0),
    });
  }
  const s = input.patientShare;
  for (const r of model.rows) {
    const rect = rowRect(r);
    if (r.anchor === 'insurance_payment') {
      anchors.push({
        id: 'insurance_payment',
        kind: 'insurance_payment',
        rect,
        style: 'highlight',
        side: 'right',
        attach: 'right',
        quote: `${r.code} ${minus(r.creditCents!)}`,
        amountsCents: [totals.insurancePaidCents],
      });
    } else if (r.anchor === 'discount') {
      anchors.push({
        id: 'discount',
        kind: 'discount',
        rect,
        style: 'highlight',
        side: 'left',
        attach: 'left',
        quote: `${r.code === 'SELF' ? r.description : r.code} ${minus(r.creditCents!)}`,
        amountsCents: [totals.contractualCents, totals.billedCents],
      });
    } else if (r.anchor === 'patient_responsibility') {
      anchors.push({
        id: 'patient_responsibility',
        kind: 'patient_responsibility',
        rect,
        style: 'highlight',
        side: 'right',
        attach: 'right',
        quote: `${r.code} · ${r.description.replace(/^PT RESP: /, '')}`,
        amountsCents: [
          s.deductibleCents,
          s.coinsuranceCents,
          s.copayCents,
          s.otherCents,
          totals.patientShareCents,
          totals.remainingCents,
        ].filter((c) => c > 0),
      });
    } else if (r.anchor === 'patient_payment') {
      anchors.push({
        id: r.id,
        kind: 'patient_payment',
        rect,
        style: 'highlight',
        side: 'right',
        attach: 'right',
        quote: `${r.code} ${minus(r.creditCents!)}`,
        amountsCents: [r.creditCents!, totals.remainingCents],
      });
    }
  }

  // Aging boxes
  const aw = (R - L) / 6;
  STATEMENT_AGING.forEach((bucket, i) => {
    const x = L + i * aw;
    box(x, y, aw, 11, { fill: LIGHT });
    box(x, y + 11, aw, 16);
    text(x + aw / 2, y + 8, bucket.label, 'sans-bold', 5.8, { align: 'center' });
    text(x + aw / 2, y + 23, statementAmount(input.aging[bucket.key]), 'mono', 7.5, {
      align: 'center',
    });
  });
  {
    const x = L + 5 * aw;
    box(x, y, aw, 11, { fill: INK });
    box(x, y + 11, aw, 16, { lineWidth: 1.4 });
    text(x + aw / 2, y + 8, 'AMOUNT DUE', 'sans-bold', 5.8, { align: 'center', color: WHITE });
    text(x + aw / 2, y + 23, amountDue, 'sans-bold', 8.5, { align: 'center' });
  }
  y += 40;

  // Messages
  box(L, y, R - L, 54);
  text(L + 6, y + 10, 'MESSAGES', 'sans-bold', 6.2);
  const messageLines = wrapText(model.message, 'mono', 7, R - L - 12);
  if (messageLines.length > 4) throw new RangeError('The MESSAGES text does not fit its box.');
  messageLines.forEach((line, i) => text(L + 6, y + 21 + i * 9, line, 'mono', 7));
  const active = input.planActive;
  const offer = input.planOffer;
  anchors.push({
    id: 'messages',
    kind: 'messages',
    rect: { x: L, y, w: R - L, h: 54 },
    style: 'loop',
    side: 'left',
    attach: 'left',
    quote:
      totals.remainingCents === 0
        ? 'PAID IN FULL'
        : active && active.paidCount < active.months
          ? `PAYMENT PLAN: ${active.paidCount} OF ${active.months} PAID`
          : offer
            ? `${offer.months} MONTHLY PAYMENTS`
            : isPastDue(input)
              ? 'PAST DUE'
              : `DUE BY ${statementDate(input.dueDate, true)}`,
    amountsCents: [
      totals.remainingCents,
      ...(offer ? [offer.firstCents, offer.regularCents] : []),
      ...(active?.nextCents ? [active.nextCents] : []),
    ],
  });
  y += 64;

  text(
    L,
    y,
    `BILLING QUESTIONS? CALL ${p.phone}${p.hours ? ` · ${p.hours.toUpperCase()}` : ''} · PLEASE HAVE YOUR ACCOUNT # READY.`,
    'sans-bold',
    6.6,
  );
  y += 9;
  text(
    L,
    y,
    `PAY ONLINE 24/7 WITH THE LINK IN THE PAY ONLINE BOX ABOVE OR IN YOUR EMAIL · STATEMENT ID ${input.statementId}.`,
    'sans',
    6.6,
  );
  y += 9;
  text(L, y, 'BALANCES NOT PAID BY THE DUE DATE ARE CONSIDERED PAST DUE.', 'sans', 6.6);
  if (y > CONTENT_BOTTOM) {
    throw new RangeError(`Statement ${input.statementId} needs more than one page.`);
  }

  text(
    PAGE_WIDTH / 2,
    PAGE_HEIGHT - 10,
    'SYNTHETIC SAMPLE · Plainbill demo data · fictional patient, practice and payer · not a real document',
    'sans',
    5.5,
    { align: 'center', color: FOOTER_GRAY },
  );

  const order: AnchorKind[] = [
    'amount_due',
    'charges',
    'split_visit',
    'insurance_payment',
    'discount',
    'patient_responsibility',
    'patient_payment',
    'messages',
  ];
  anchors.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  for (const a of anchors) a.amountsCents = [...new Set(a.amountsCents)];
  return { width: PAGE_WIDTH, height: PAGE_HEIGHT, ops, anchors, table };
}
