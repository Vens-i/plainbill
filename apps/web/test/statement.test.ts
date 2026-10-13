import { describe, expect, it } from 'vitest';
import type { Anchor } from '@plainbill/api/contract';
import {
  arrowPath,
  attachPoint,
  highlightShape,
  loopPath,
  placeCards,
  seeded,
  toScreen,
} from '../src/pages/pay/statement/geometry';

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
