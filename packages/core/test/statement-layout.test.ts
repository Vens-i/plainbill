import { describe, expect, it } from 'vitest';
import { textWidth, winAnsi } from '../src/statement/metrics';
import { layoutStatement, wrapText, type Op, type Rect } from '../src/statement/layout';
import { buildStatementModel, type StatementInput } from '../src/statement/model';
import {
  AISHA,
  KEVIN,
  LINDA,
  MARIA,
  MARIA_ON_PLAN,
  SAMUEL,
  SELF_PAY_DISCOUNT,
  THEO,
} from './fixtures/statements';

const ALL: Array<[string, StatementInput]> = [
  ['Maria', MARIA],
  ['Samuel', SAMUEL],
  ['Aisha', AISHA],
  ['Kevin', KEVIN],
  ['Linda', LINDA],
  ['self-pay discount', SELF_PAY_DISCOUNT],
  ['Maria on a plan', MARIA_ON_PLAN],
  ['Theo (split visit)', THEO],
];

const layout = (input: StatementInput) => layoutStatement(buildStatementModel(input));

function inside(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Horizontal extent of a text op. */
function textSpan(op: Extract<Op, { t: 'text' }>): [number, number] {
  const w = textWidth(op.s, op.font, op.size);
  if (op.align === 'right') return [op.x - w, op.x];
  if (op.align === 'center') return [op.x - w / 2, op.x + w / 2];
  return [op.x, op.x + w];
}

const PAGE: Rect = { x: 0, y: 0, w: 612, h: 792 };
const ROW_KINDS = [
  'charges',
  'split_visit',
  'insurance_payment',
  'discount',
  'patient_responsibility',
  'patient_payment',
];

describe('text metrics', () => {
  it('measures Helvetica and Courier like pdf-lib', () => {
    expect(textWidth('PATIENT STATEMENT', 'sans-bold', 11)).toBeCloseTo(117.34, 2);
    expect(textWidth('$240.00', 'sans', 10)).toBeCloseTo(36.14, 2);
    expect(textWidth('CO45', 'mono', 7.2)).toBeCloseTo(17.28, 2);
    expect(textWidth('TOMÁS', 'sans', 10)).toBe(textWidth('TOMAS', 'sans', 10));
  });

  it('keeps text WinAnsi-safe for the PDF fonts', () => {
    expect(winAnsi('Tomás · Mon–Fri')).toBe('Tomás · Mon–Fri');
    expect(winAnsi('Nguyễn −400 ▲ 李')).toBe('Nguyen ?400 ? ?');
  });

  it('wraps words, and breaks a long link by character', () => {
    expect(wrapText('ONE TWO THREE', 'mono', 10, 40)).toEqual(['ONE', 'TWO', 'THREE']);
    expect(wrapText('abcdefghij', 'mono', 10, 36)).toEqual(['abcdef', 'ghij']);
  });
});

describe('layoutStatement', () => {
  it("anchors Maria's six notes, in note order", () => {
    expect(
      layout(MARIA).anchors.map((a) => ({
        id: a.id,
        style: a.style,
        side: a.side,
        attach: a.attach,
        quote: a.quote,
        amountsCents: a.amountsCents,
        rect: a.rect,
      })),
    ).toMatchInlineSnapshot(`
      [
        {
          "amountsCents": [
            24000,
          ],
          "attach": "bottom",
          "id": "amount_due",
          "quote": "PAY THIS AMOUNT $240.00",
          "rect": {
            "h": 30,
            "w": 82,
            "x": 392,
            "y": 122,
          },
          "side": "right",
          "style": "highlight",
        },
        {
          "amountsCents": [
            85000,
            35000,
            18000,
            32000,
          ],
          "attach": "left",
          "id": "charges",
          "quote": "99214 · 80053 · 93000",
          "rect": {
            "h": 33.5,
            "w": 548,
            "x": 32,
            "y": 359.5,
          },
          "side": "left",
          "style": "loop",
        },
        {
          "amountsCents": [
            21000,
          ],
          "attach": "right",
          "id": "insurance_payment",
          "quote": "INSPMT −210.00",
          "rect": {
            "h": 10,
            "w": 426,
            "x": 155,
            "y": 404.4,
          },
          "side": "right",
          "style": "highlight",
        },
        {
          "amountsCents": [
            40000,
            85000,
          ],
          "attach": "left",
          "id": "discount",
          "quote": "CO45 −400.00",
          "rect": {
            "h": 10,
            "w": 426,
            "x": 155,
            "y": 415.4,
          },
          "side": "left",
          "style": "highlight",
        },
        {
          "amountsCents": [
            20000,
            4000,
            24000,
          ],
          "attach": "right",
          "id": "patient_responsibility",
          "quote": "PR1 PR2 · DED 200.00 COINS 40.00",
          "rect": {
            "h": 10,
            "w": 426,
            "x": 155,
            "y": 426.4,
          },
          "side": "right",
          "style": "highlight",
        },
        {
          "amountsCents": [
            24000,
            8000,
          ],
          "attach": "left",
          "id": "messages",
          "quote": "3 MONTHLY PAYMENTS",
          "rect": {
            "h": 54,
            "w": 552,
            "x": 30,
            "y": 515,
          },
          "side": "left",
          "style": "loop",
        },
      ]
    `);
  });

  it.each(ALL)('%s: an anchor for every non-zero amount', (_, input) => {
    const ids = layout(input).anchors.map((a) => a.id);
    expect(ids[0]).toBe('amount_due');
    expect(ids).toContain('charges');
    expect(ids.at(-1)).toBe('messages');
    expect(ids.includes('insurance_payment')).toBe((input.insurancePaidCents ?? 0) > 0);
    expect(ids.includes('discount')).toBe(input.contractualCents > 0);
    const share = input.patientShare;
    expect(ids.includes('patient_responsibility')).toBe(
      !input.visit.selfPay &&
        share.deductibleCents + share.coinsuranceCents + share.copayCents + share.otherCents > 0,
    );
    expect(ids.filter((id) => id.startsWith('payment-'))).toHaveLength(input.payments.length);
  });

  it.each(ALL)('%s: rects sit on the page, row anchors inside the table', (_, input) => {
    const l = layout(input);
    for (const a of l.anchors) {
      expect(inside(a.rect, PAGE)).toBe(true);
      if (ROW_KINDS.includes(a.kind)) expect(inside(a.rect, l.table)).toBe(true);
    }
  });

  it.each(ALL)('%s: no two highlighter marks overlap', (_, input) => {
    const marks = layout(input).anchors.filter((a) => a.style === 'highlight');
    for (const [i, a] of marks.entries()) {
      for (const b of marks.slice(i + 1))
        expect(overlaps(a.rect, b.rect), `${a.id}/${b.id}`).toBe(false);
    }
  });

  it.each(ALL)('%s: every piece of text fits on the page, in WinAnsi', (_, input) => {
    for (const op of layout(input).ops) {
      if (op.t !== 'text') continue;
      const [from, to] = textSpan(op);
      expect(from, op.s).toBeGreaterThanOrEqual(20);
      expect(to, op.s).toBeLessThanOrEqual(592);
      expect(winAnsi(op.s)).toBe(op.s);
    }
  });

  it('keeps the coupon text inside the Pay online box', () => {
    const coupon = { x: 318, y: 26, w: 264, h: 88 };
    const texts = layout(MARIA).ops.filter(
      (op): op is Extract<Op, { t: 'text' }> =>
        op.t === 'text' && op.x >= coupon.x && op.y > coupon.y && op.y < coupon.y + coupon.h,
    );
    expect(texts.length).toBeGreaterThan(5);
    for (const op of texts) {
      const [from, to] = textSpan(op);
      expect(from).toBeGreaterThan(coupon.x);
      expect(to, op.s).toBeLessThan(coupon.x + coupon.w);
    }
  });

  it('prints the pay link and statement ID, and no credit-card fields', () => {
    const strings = layout({
      ...MARIA,
      payUrl: 'https://plainbill.onrender.com/pay/7Yq0c3uM2kQx5d8RZtWb1nVgH4sJpL6e',
    }).ops.flatMap((op) => (op.t === 'text' ? [op.s] : []));
    expect(strings.join('')).toContain(
      'https://plainbill.onrender.com/pay/7Yq0c3uM2kQx5d8RZtWb1nVgH4sJpL6e',
    );
    expect(strings.some((s) => s.includes('STATEMENT ID S0000014'))).toBe(true);
    expect(strings.join(' ')).not.toMatch(
      /IF PAYING BY CREDIT CARD|CARD NUMBER\b|EXP\. DATE|SIGNATURE|BILLING ZIP/,
    );
    expect(strings).toContain('$240.00');
  });

  it('is deterministic', () => {
    expect(layout(AISHA)).toEqual(layout(AISHA));
  });

  it('refuses a statement that needs a second page', () => {
    const lines = Array.from({ length: 30 }, () => ({ code: '99213', chargeCents: 1000 }));
    expect(() =>
      layout({ ...KEVIN, lines, patientShare: { ...KEVIN.patientShare }, remainingCents: 30000 }),
    ).toThrow(/more than one page/);
  });
});

describe('the split visit', () => {
  it('highlights the problem-visit line inside the charges loop', () => {
    const l = layout(THEO);
    expect(l.anchors.map((a) => a.id)).toEqual([
      'amount_due',
      'charges',
      'split_visit',
      'insurance_payment',
      'discount',
      'patient_responsibility',
      'messages',
    ]);
    const split = l.anchors.find((a) => a.id === 'split_visit')!;
    const charges = l.anchors.find((a) => a.id === 'charges')!;
    expect(split).toMatchObject({
      kind: 'split_visit',
      style: 'highlight',
      side: 'right',
      quote: '99213 220.00',
      amountsCents: [22000, 15000],
    });
    // Same rows as the loop (row highlights run to the table edge, a point past the loop).
    expect(split.rect.y).toBeGreaterThanOrEqual(charges.rect.y);
    expect(split.rect.y + split.rect.h).toBeLessThanOrEqual(charges.rect.y + charges.rect.h);
  });

  it('is only there when the input says so', () => {
    expect(layout(MARIA).anchors.some((a) => a.kind === 'split_visit')).toBe(false);
    expect(
      layout({ ...THEO, splitVisit: null }).anchors.some((a) => a.kind === 'split_visit'),
    ).toBe(false);
  });

  it('refuses a split visit that points at missing lines or owes more than the patient share', () => {
    const sv = THEO.splitVisit!;
    expect(() =>
      buildStatementModel({ ...THEO, splitVisit: { ...sv, problemLineIndex: 7 } }),
    ).toThrow(RangeError);
    expect(() =>
      buildStatementModel({
        ...THEO,
        splitVisit: { ...sv, problemShare: { ...sv.problemShare, totalCents: 99999 } },
      }),
    ).toThrow(/more than the patient's share/);
  });
});
