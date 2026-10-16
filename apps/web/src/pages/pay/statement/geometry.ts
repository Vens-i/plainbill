/**
 * Pure geometry for the explained statement: seeded "hand-drawn" shapes (so a given line always
 * gets the same wobble), arrows between note cards and their lines, and note placement. All of
 * it is deterministic and unit-tested; the components only measure and render.
 */
import type { Anchor, Rect } from '@plainbill/api/contract';

/** A small deterministic random source per anchor id (mulberry32 over a string hash). */
export function seeded(key: string): () => number {
  let h = 1779033703 ^ key.length;
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A value in [-1, 1). */
const signed = (rand: () => number) => rand() * 2 - 1;
const round = (n: number) => Math.round(n * 100) / 100;

export interface HighlightShape {
  x: number;
  y: number;
  w: number;
  h: number;
  rx: number;
  ry: number;
  /** Degrees, around the shape's center. */
  rotate: number;
}

/** A highlighter stroke over a row or value: a touch bigger than the text, slightly crooked. */
export function highlightShape(anchor: Pick<Anchor, 'id' | 'rect'>): HighlightShape {
  const rand = seeded(anchor.id);
  const { x, y, w, h } = anchor.rect;
  return {
    x: round(x - 1.5 + signed(rand)),
    y: round(y - 0.8),
    w: round(w + 3 + signed(rand) * 2),
    h: round(h + 1.6),
    rx: round(2 + rand() * 2),
    ry: round(3 + rand() * 2),
    rotate: round(signed(rand) * 0.3),
  };
}

/**
 * A hand-drawn loop around a block of rows: a superellipse a few points outside the rect, with
 * ±3% wobble in its radius and an overshoot past the start, the way a pen loop doesn't close
 * exactly.
 */
export function loopPath(anchor: Pick<Anchor, 'id' | 'rect'>): string {
  const rand = seeded(`${anchor.id}:loop`);
  const { x, y, w, h } = anchor.rect;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rx = w / 2 + 6;
  const ry = h / 2 + 7;
  const n = 5; // superellipse exponent: flat sides, round corners
  const phase = [rand() * Math.PI * 2, rand() * Math.PI * 2];
  const start = Math.PI * (0.9 + rand() * 0.2); // begin at the left side
  const overshoot = 0.32 + rand() * 0.12;
  const steps = 96;
  const points: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const p = i / steps;
    const t = start + p * (Math.PI * 2 + overshoot);
    const wobble =
      1 + 0.03 * (Math.sin(t * 2 + phase[0]!) * 0.6 + Math.sin(t * 3 + phase[1]!) * 0.4);
    // The pen drifts outward a little over the loop, so the end passes outside the start.
    const drift = 1 + 0.035 * p;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const px = cx + rx * wobble * drift * Math.sign(c) * Math.abs(c) ** (2 / n);
    const py = cy + ry * wobble * drift * Math.sign(s) * Math.abs(s) ** (2 / n);
    points.push(`${i ? 'L' : 'M'}${round(px)} ${round(py)}`);
  }
  return points.join(' ');
}

/** Where an arrow lands on an anchor, in the anchor's own coordinates. */
export function attachPoint(anchor: Pick<Anchor, 'rect' | 'attach' | 'style'>): {
  x: number;
  y: number;
} {
  const { x, y, w, h } = anchor.rect;
  // Loops are drawn a few points outside the rect: land on the line, not inside it.
  const pad = anchor.style === 'loop' ? 6 : 1.5;
  if (anchor.attach === 'bottom') return { x: x + w / 2, y: y + h + 1 };
  if (anchor.attach === 'left') return { x: x - pad, y: y + h / 2 };
  return { x: x + w + pad, y: y + h / 2 };
}

export interface Point {
  x: number;
  y: number;
}

/**
 * A hand-drawn arrow from a note card's inner edge to its line: a cubic curve whose control
 * points sit ~40% of the horizontal gap in (with a few pixels of seeded wobble), and an open V
 * head 13 px long at ±28°. Coordinates are screen pixels.
 */
export function arrowPath(
  from: Point,
  to: Point,
  attach: Anchor['attach'],
  key: string,
): { line: string; head: string } {
  const rand = seeded(`${key}:arrow`);
  const dx = to.x - from.x;
  const reach = Math.max(Math.abs(dx) * 0.4, 24);
  const dir = Math.sign(dx) || 1;
  const c1 = { x: from.x + dir * reach + signed(rand) * 6, y: from.y + signed(rand) * 6 };
  const c2 =
    attach === 'bottom'
      ? {
          x: to.x + dir * 8 + signed(rand) * 6,
          y: to.y + Math.max(48, Math.abs(to.y - from.y) * 0.5),
        }
      : { x: to.x - dir * reach + signed(rand) * 6, y: to.y + signed(rand) * 6 };
  const line = `M${round(from.x)} ${round(from.y)} C${round(c1.x)} ${round(c1.y)} ${round(c2.x)} ${round(c2.y)} ${round(to.x)} ${round(to.y)}`;
  // The head follows the curve's direction where it arrives (from c2 toward the tip).
  const angle = Math.atan2(to.y - c2.y, to.x - c2.x);
  const len = 13;
  const spread = (28 * Math.PI) / 180;
  const wing = (a: number) => ({
    x: to.x - len * Math.cos(angle + a),
    y: to.y - len * Math.sin(angle + a),
  });
  const a = wing(spread);
  const b = wing(-spread);
  const head = `M${round(a.x)} ${round(a.y)} L${round(to.x)} ${round(to.y)} L${round(b.x)} ${round(b.y)}`;
  return { line, head };
}

/** Scale an anchor rect (PDF points) into screen pixels inside the statement's box. */
export function toScreen(rect: Rect, box: { left: number; top: number; scale: number }): Rect {
  return {
    x: box.left + rect.x * box.scale,
    y: box.top + rect.y * box.scale,
    w: rect.w * box.scale,
    h: rect.h * box.scale,
  };
}

/**
 * Stack note cards beside their lines: each wants its center level with its anchor; sorted by
 * that, cards are pushed down to keep `gap` between them, and if the last one runs past
 * `bottom`, a reverse pass pushes them back up. When the cards are taller than the column
 * altogether, the first one stops at the top and the rest stack below it (past `bottom`)
 * rather than overlap.
 */
export function placeCards(
  cards: Array<{ id: string; desiredCenter: number; height: number }>,
  gap: number,
  bottom: number,
): Map<string, number> {
  const sorted = [...cards].sort((a, b) => a.desiredCenter - b.desiredCenter);
  const tops = sorted.map((c) => Math.max(0, c.desiredCenter - c.height / 2));
  for (let i = 1; i < sorted.length; i++) {
    tops[i] = Math.max(tops[i]!, tops[i - 1]! + sorted[i - 1]!.height + gap);
  }
  const last = sorted.length - 1;
  if (last >= 0 && tops[last]! + sorted[last]!.height > bottom) {
    tops[last] = bottom - sorted[last]!.height;
    for (let i = last - 1; i >= 0; i--) {
      tops[i] = Math.min(tops[i]!, tops[i + 1]! - gap - sorted[i]!.height);
    }
    if (tops[0]! < 0) {
      tops[0] = 0;
      for (let i = 1; i < sorted.length; i++) {
        tops[i] = Math.max(tops[i]!, tops[i - 1]! + sorted[i - 1]!.height + gap);
      }
    }
  }
  return new Map(sorted.map((c, i) => [c.id, Math.max(0, tops[i]!)]));
}

/** The part of the page the phone thumbnail shows (PDF points): coupon amount box to messages. */
export const PHONE_CROP: [number, number, number, number] = [0, 100, 612, 500];

/**
 * Numbered pins beside each mark on the phone thumbnail, in thumbnail pixels: at the mark's left
 * edge for left-side notes, its right edge for right-side ones, nudged apart vertically where
 * neighbouring rows would make them overlap.
 */
export function pinPositions(
  anchors: Array<Pick<Anchor, 'id' | 'rect' | 'side'>>,
  scale: number,
  crop: [number, number, number, number] = PHONE_CROP,
  size = 22,
): Map<string, Point> {
  const out = new Map<string, Point>();
  const groups = new Map<string, Array<{ id: string; x: number; y: number }>>();
  for (const a of anchors) {
    const x = ((a.side === 'left' ? a.rect.x : a.rect.x + a.rect.w) - crop[0]) * scale;
    const y = (a.rect.y + a.rect.h / 2 - crop[1]) * scale;
    // Pins in the same column (within a pin's width) can collide; others can't.
    const key = `${a.side}:${Math.round(x / size)}`;
    groups.set(key, [...(groups.get(key) ?? []), { id: a.id, x, y }]);
  }
  for (const pins of groups.values()) {
    const tops = placeCards(
      pins.map((p) => ({ id: p.id, desiredCenter: p.y, height: size })),
      2,
      Number.POSITIVE_INFINITY,
    );
    for (const p of pins) out.set(p.id, { x: p.x, y: tops.get(p.id)! + size / 2 });
  }
  return out;
}

/**
 * The zoom strip's crop around a mark (PDF points): `width` × `height` points, centered on the
 * mark's rows; wide marks start at their left edge, narrow ones are centered.
 */
export function stripCrop(
  rect: Rect,
  width: number,
  height: number,
): [number, number, number, number] {
  const x = rect.w < width * 0.8 ? rect.x + rect.w / 2 - width / 2 : rect.x - 8;
  const y = rect.y + rect.h / 2 - height / 2;
  return [
    round(Math.min(Math.max(0, x), 612 - width)),
    round(Math.min(Math.max(0, y), 792 - height)),
    round(width),
    round(height),
  ];
}

/** A short hand-drawn arrow dropping from a mark down into the zoom strip. */
export function dropArrow(from: Point, to: Point, key: string): { line: string; head: string } {
  const rand = seeded(`${key}:drop`);
  const bend = 18 + rand() * 10;
  const c1 = { x: from.x + bend, y: from.y + (to.y - from.y) * 0.35 };
  const c2 = { x: to.x + bend * 0.4, y: to.y - (to.y - from.y) * 0.4 };
  const line = `M${round(from.x)} ${round(from.y)} C${round(c1.x)} ${round(c1.y)} ${round(c2.x)} ${round(c2.y)} ${round(to.x)} ${round(to.y)}`;
  const angle = Math.atan2(to.y - c2.y, to.x - c2.x);
  const wing = (a: number) =>
    `${round(to.x - 11 * Math.cos(angle + a))} ${round(to.y - 11 * Math.sin(angle + a))}`;
  const spread = (28 * Math.PI) / 180;
  return { line, head: `M${wing(spread)} L${round(to.x)} ${round(to.y)} L${wing(-spread)}` };
}
