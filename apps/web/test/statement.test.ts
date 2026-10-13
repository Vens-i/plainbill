import { describe, expect, it } from 'vitest';
import type { Anchor } from '@plainbill/api/contract';
import {
  arrowPath,
  attachPoint,
  dropArrow,
  PHONE_CROP,
  pinPositions,
  stripCrop,
  highlightShape,
  loopPath,
  placeCards,
  seeded,
  toScreen,
} from '../src/pages/pay/statement/geometry';
import { noteParts } from '../src/pages/pay/statement/format';

const anchor = (over: Partial<Anchor> = {}): Anchor => ({
  id: 'discount',
  kind: 'discount',
  rect: { x: 155, y: 415.4, w: 426, h: 10 },
  style: 'highlight',
  side: 'left',
  attach: 'left',
  quote: 'CO45 −400.00',
  amountsCents: [40000, 85000],
  ...over,
});

const numbers = (path: string) => [...path.matchAll(/-?\d+(\.\d+)?/g)].map((m) => Number(m[0]));

describe('seeded shapes', () => {
  it('are the same every time for the same line, and differ between lines', () => {
    expect(seeded('discount')()).toBe(seeded('discount')());
    expect(seeded('discount')()).not.toBe(seeded('charges')());
    expect(highlightShape(anchor())).toEqual(highlightShape(anchor()));
    expect(loopPath(anchor({ style: 'loop' }))).toBe(loopPath(anchor({ style: 'loop' })));
  });

  it('keeps a highlighter mark on its row, barely crooked', () => {
    const s = highlightShape(anchor());
    expect(Math.abs(s.rotate)).toBeLessThanOrEqual(0.3);
    expect(s.x).toBeGreaterThan(150);
    expect(s.x).toBeLessThan(156);
    expect(s.y).toBeLessThan(415.4);
    expect(s.y + s.h).toBeGreaterThan(425.4);
    expect(s.y + s.h).toBeLessThan(427);
  });

  it('draws a loop just outside its block that overshoots where it started', () => {
    const rect = { x: 32, y: 359.5, w: 548, h: 33.5 };
    const path = loopPath(anchor({ id: 'charges', style: 'loop', rect }));
    const xy = numbers(path);
    const xs = xy.filter((_, i) => i % 2 === 0);
    const ys = xy.filter((_, i) => i % 2 === 1);
    expect(Math.min(...xs)).toBeLessThan(rect.x);
    expect(Math.max(...xs)).toBeGreaterThan(rect.x + rect.w);
    expect(Math.min(...ys)).toBeLessThan(rect.y);
    expect(Math.max(...ys)).toBeGreaterThan(rect.y + rect.h);
    // Within the wobble and drift: never more than ~15 points outside the rect.
    expect(Math.min(...xs)).toBeGreaterThan(rect.x - 20);
    expect(Math.max(...ys)).toBeLessThan(rect.y + rect.h + 20);
    // The pen ends past its start, a little outside it.
    expect(xy.length).toBeGreaterThan(150);
    const [sx, sy] = xy;
    const [ex, ey] = xy.slice(-2);
    expect(Math.hypot(ex! - sx!, ey! - sy!)).toBeGreaterThan(5);
  });
});

describe('arrows', () => {
  it('land on the side of the line facing their note', () => {
    expect(attachPoint(anchor())).toEqual({ x: 153.5, y: 420.4 });
    expect(attachPoint(anchor({ attach: 'right' })).x).toBe(582.5);
    expect(
      attachPoint(anchor({ attach: 'bottom', rect: { x: 392, y: 122, w: 82, h: 30 } })),
    ).toEqual({ x: 433, y: 153 });
  });

  it('are a curve ending at the line with an open V head', () => {
    const { line, head } = arrowPath({ x: 100, y: 200 }, { x: 400, y: 260 }, 'left', 'discount');
    expect(line.startsWith('M100 200 C')).toBe(true);
    expect(line.endsWith('400 260')).toBe(true);
    const [ax, ay, tx, ty, bx, by] = numbers(head);
    expect([tx, ty]).toEqual([400, 260]);
    // Both wings sit 13 px behind the tip.
    expect(Math.hypot(ax! - 400, ay! - 260)).toBeCloseTo(13, 0);
    expect(Math.hypot(bx! - 400, by! - 260)).toBeCloseTo(13, 0);
    expect(arrowPath({ x: 100, y: 200 }, { x: 400, y: 260 }, 'left', 'discount')).toEqual({
      line,
      head,
    });
  });

  it('scale anchor rects onto the screen', () => {
    expect(toScreen({ x: 100, y: 200, w: 50, h: 10 }, { left: 10, top: 20, scale: 2 })).toEqual({
      x: 210,
      y: 420,
      w: 100,
      h: 20,
    });
  });
});

describe('placeCards', () => {
  it('centers each card on its line when there is room', () => {
    const tops = placeCards(
      [
        { id: 'a', desiredCenter: 100, height: 80 },
        { id: 'b', desiredCenter: 400, height: 80 },
      ],
      24,
      1000,
    );
    expect(Object.fromEntries(tops)).toEqual({ a: 60, b: 360 });
  });

  it('pushes crowded cards down with a 24 px gap, in line order', () => {
    const tops = placeCards(
      [
        { id: 'b', desiredCenter: 210, height: 100 },
        { id: 'a', desiredCenter: 200, height: 100 },
      ],
      24,
      1000,
    );
    expect(Object.fromEntries(tops)).toEqual({ a: 150, b: 274 });
  });

  it('pushes back up when the last card would run off the bottom', () => {
    const tops = placeCards(
      [
        { id: 'a', desiredCenter: 300, height: 100 },
        { id: 'b', desiredCenter: 480, height: 100 },
      ],
      24,
      500,
    );
    expect(Object.fromEntries(tops)).toEqual({ a: 250, b: 400 });
    const squeezed = placeCards(
      [
        { id: 'a', desiredCenter: 420, height: 100 },
        { id: 'b', desiredCenter: 480, height: 100 },
      ],
      24,
      500,
    );
    expect(Object.fromEntries(squeezed)).toEqual({ a: 276, b: 400 });
  });
});

describe('note bodies', () => {
  it('bold every amount and link the practice phone, and nothing else', () => {
    expect(
      noteParts(
        'Pay it all now, or split it into 3 payments of $80 with no fees. $240.00 total. Questions? Call (555) 014-2290. <b>hi</b>',
        '(555) 014-2290',
      ),
    ).toEqual([
      { kind: 'text', text: 'Pay it all now, or split it into 3 payments of ' },
      { kind: 'money', text: '$80' },
      { kind: 'text', text: ' with no fees. ' },
      { kind: 'money', text: '$240.00' },
      { kind: 'text', text: ' total. Questions? Call ' },
      { kind: 'phone', text: '(555) 014-2290', href: 'tel:5550142290' },
      { kind: 'text', text: '. <b>hi</b>' },
    ]);
    expect(noteParts('$1,200 came off.', null)).toEqual([
      { kind: 'money', text: '$1,200' },
      { kind: 'text', text: ' came off.' },
    ]);
  });
});

describe('phone geometry', () => {
  const rows = [
    anchor({ id: 'insurance_payment', side: 'right', rect: { x: 155, y: 404.4, w: 426, h: 10 } }),
    anchor({ id: 'discount', side: 'left', rect: { x: 155, y: 415.4, w: 426, h: 10 } }),
    anchor({
      id: 'patient_responsibility',
      side: 'right',
      rect: { x: 155, y: 426.4, w: 426, h: 10 },
    }),
  ];

  it('puts pins at the mark’s edge and pushes neighbours in a column apart', () => {
    const pins = pinPositions(rows, 0.6, PHONE_CROP, 22);
    expect(pins.get('discount')).toEqual({ x: 93, y: (420.4 - 100) * 0.6 });
    const a = pins.get('insurance_payment')!;
    const b = pins.get('patient_responsibility')!;
    expect(a.x).toBeCloseTo(348.6, 5);
    expect(b.y - a.y).toBeGreaterThanOrEqual(24);
  });

  it('crops the zoom strip around the line, inside the page', () => {
    expect(stripCrop({ x: 155, y: 415.4, w: 426, h: 10 }, 380, 68)).toEqual([147, 386.4, 380, 68]);
    expect(stripCrop({ x: 392, y: 122, w: 82, h: 30 }, 380, 68)).toEqual([232, 103, 380, 68]);
    expect(stripCrop({ x: 30, y: 760, w: 552, h: 54 }, 380, 68)[1]).toBe(724);
  });

  it('drops a short arrow into the strip', () => {
    const { line, head } = dropArrow({ x: 100, y: 10 }, { x: 140, y: 120 }, 'discount');
    expect(line.startsWith('M100 10 C')).toBe(true);
    expect(line.endsWith('140 120')).toBe(true);
    expect(head).toContain('L140 120 L');
  });
});
