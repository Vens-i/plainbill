/**
 * "Where every dollar went": the money-flow model and its layout, as pure functions.
 *
 * Every billed dollar ends in exactly one place: written off by contract, written off as a
 * denial, paid by insurance, or the patient's share; the patient's share is either collected or
 * still owed (by age). Amounts are summed in integer cents from the same computed rows as the
 * grid, and the splits must add up exactly, or we refuse to draw.
 */

export interface FlowRow {
  balanceId: number;
  status: string;
  billed: number;
  insuranceDiscount: number;
  insurancePaid: number;
  patientShare: number;
  patientPaid: number;
  stillOwed: number;
  aging: string;
}

export type FlowNodeId =
  | 'billed'
  | 'discount'
  | 'denied'
  | 'insurance'
  | 'share'
  | 'collected'
  | 'owed-0-30'
  | 'owed-31-60'
  | 'owed-61-90'
  | 'owed-90';

export interface FlowNode {
  id: FlowNodeId;
  label: string;
  column: 0 | 1 | 2;
  cents: number;
  visits: number;
  /** The stage bar. */
  color: string;
  /** The streams into this stage: a pale tint, so the page stays calm. */
  tint: string;
  /** The stage name's text color (the aging pills' ink for ages). */
  ink: string;
  /** What clicking the node filters the other widgets to, if anything. */
  filter: { field: 'balances.aging' | 'balances.status'; value: string } | null;
}

export interface FlowLink {
  id: string;
  from: FlowNodeId;
  to: FlowNodeId;
  cents: number;
  visits: number;
}

export interface FlowModel {
  nodes: FlowNode[];
  links: FlowLink[];
}

const cents = (dollars: number) => Math.round(dollars * 100);

// Teal for the money that moved, warm neutrals for write-offs, a muted red for denials, and the
// aging pills' colors (CLAUDE.md) for what's still owed, older getting warmer.
const NODES: Array<Omit<FlowNode, 'cents' | 'visits'>> = [
  {
    id: 'billed',
    label: 'Billed',
    column: 0,
    color: '#134545',
    tint: '#134545',
    ink: '#1C2B2D',
    filter: null,
  },
  {
    id: 'discount',
    label: 'Insurance discount',
    column: 1,
    color: '#B9B2A6',
    tint: '#ECE8E1',
    ink: '#1C2B2D',
    filter: null,
  },
  {
    id: 'denied',
    label: 'Denied claims',
    column: 1,
    color: '#B5483E',
    tint: '#F6E3DF',
    ink: '#9B2C24',
    filter: { field: 'balances.status', value: 'Denied' },
  },
  {
    id: 'insurance',
    label: 'Insurance paid',
    column: 1,
    color: '#6F9C96',
    tint: '#E2EEEC',
    ink: '#1C2B2D',
    filter: null,
  },
  {
    id: 'share',
    label: 'Patient share',
    column: 1,
    color: '#1D5C5C',
    tint: '#D3E4E1',
    ink: '#1C2B2D',
    filter: null,
  },
  {
    id: 'collected',
    label: 'Collected',
    column: 2,
    color: '#2E7D4A',
    tint: '#DCEFE1',
    ink: '#24633A',
    filter: null,
  },
  {
    id: 'owed-0-30',
    label: 'Owed · 0–30 days',
    column: 2,
    color: '#8C9695',
    tint: '#ECEAE5',
    ink: '#454B4D',
    filter: { field: 'balances.aging', value: '0–30 days' },
  },
  {
    id: 'owed-31-60',
    label: 'Owed · 31–60 days',
    column: 2,
    color: '#D3A03F',
    tint: '#FAEFD6',
    ink: '#7A4E00',
    filter: { field: 'balances.aging', value: '31–60 days' },
  },
  {
    id: 'owed-61-90',
    label: 'Owed · 61–90 days',
    column: 2,
    color: '#C0743F',
    tint: '#F8E1CC',
    ink: '#7D3F12',
    filter: { field: 'balances.aging', value: '61–90 days' },
  },
  {
    id: 'owed-90',
    label: 'Owed · 90+ days',
    column: 2,
    color: '#9B2C24',
    tint: '#FAE5E1',
    ink: '#9B2C24',
    filter: { field: 'balances.aging', value: '90+ days' },
  },
];

const OWED_BY_AGING: Record<string, FlowNodeId> = {
  '0–30 days': 'owed-0-30',
  '31–60 days': 'owed-31-60',
  '61–90 days': 'owed-61-90',
  '90+ days': 'owed-90',
};

export class FlowMismatchError extends Error {
  override name = 'FlowMismatchError';
}

export function buildFlow(rows: FlowRow[]): FlowModel {
  const linkTotals = new Map<
    string,
    { from: FlowNodeId; to: FlowNodeId; cents: number; visits: number }
  >();
  const add = (from: FlowNodeId, to: FlowNodeId, amount: number) => {
    if (amount <= 0) return;
    const key = `${from}>${to}`;
    const link = linkTotals.get(key) ?? { from, to, cents: 0, visits: 0 };
    link.cents += amount;
    link.visits += 1;
    linkTotals.set(key, link);
  };

  for (const r of rows) {
    const billed = cents(r.billed);
    const discount = cents(r.insuranceDiscount);
    const insurance = cents(r.insurancePaid);
    const share = cents(r.patientShare);
    const paid = cents(r.patientPaid);
    const owed = cents(r.stillOwed);
    const denied = r.status === 'Denied';
    if (billed !== discount + insurance + share) {
      throw new FlowMismatchError(`Balance ${r.balanceId}: billed doesn't split exactly.`);
    }
    if (!denied && share !== paid + owed) {
      throw new FlowMismatchError(`Balance ${r.balanceId}: patient share doesn't split exactly.`);
    }
    add('billed', denied ? 'denied' : 'discount', discount);
    add('billed', 'insurance', insurance);
    add('billed', 'share', share);
    add('share', 'collected', paid);
    if (owed > 0) {
      const bucket = OWED_BY_AGING[r.aging];
      if (!bucket) throw new FlowMismatchError(`Balance ${r.balanceId}: unknown age "${r.aging}".`);
      add('share', bucket, owed);
    }
  }

  const links: FlowLink[] = [...linkTotals.values()].map((l) => ({
    id: `${l.from}>${l.to}`,
    ...l,
  }));
  const inOf = (id: FlowNodeId) => links.filter((l) => l.to === id);
  const outOf = (id: FlowNodeId) => links.filter((l) => l.from === id);
  const sum = (ls: FlowLink[]) => ls.reduce((s, l) => s + l.cents, 0);

  const nodes = NODES.map((n) => {
    const incoming = inOf(n.id);
    const outgoing = outOf(n.id);
    const visits =
      n.id === 'billed'
        ? rows.length
        : Math.max(...[incoming, outgoing].map((ls) => ls.reduce((s, l) => s + l.visits, 0)));
    return { ...n, cents: n.id === 'billed' ? sum(outgoing) : sum(incoming), visits };
  }).filter((n) => n.cents > 0);

  // Conservation: what leaves a node equals what entered it (where both sides exist).
  for (const n of nodes) {
    const incoming = sum(inOf(n.id));
    const outgoing = sum(outOf(n.id));
    if (incoming && outgoing && incoming !== outgoing) {
      throw new FlowMismatchError(`${n.label}: ${incoming} in, ${outgoing} out.`);
    }
  }
  return { nodes, links: links.filter((l) => nodes.some((n) => n.id === l.to)) };
}

// ── Layout ────────────────────────────────────────────────────────────────────

export interface NodeBox {
  node: FlowNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LinkShape {
  link: FlowLink;
  /** Ribbon outline (filled). */
  path: string;
  /** Centerline as a cubic Bézier, for particles. */
  curve: [Point, Point, Point, Point];
  thickness: number;
  color: string;
  tint: string;
}

export interface Point {
  x: number;
  y: number;
}

export interface FlowLayout {
  width: number;
  height: number;
  nodes: NodeBox[];
  links: LinkShape[];
}

export interface LayoutOptions {
  width: number;
  height: number;
  /** Room for labels left of column 0 and right of column 2. */
  padLeft?: number;
  padRight?: number;
  padY?: number;
  nodeWidth?: number;
  gap?: number;
  /** Gap above the patient share, where its label sits clear of the streams fanning out. */
  shareGap?: number;
  /** Gap between the outcomes on the right. */
  rightGap?: number;
  /** Least room an outcome on the right takes, so its label never touches the next one. */
  minSlot?: number;
}

export function layoutFlow(model: FlowModel, opts: LayoutOptions): FlowLayout {
  const { width, height } = opts;
  const padLeft = opts.padLeft ?? 120;
  const padRight = opts.padRight ?? 170;
  const padY = opts.padY ?? 12;
  const nodeWidth = opts.nodeWidth ?? 12;
  const gap = opts.gap ?? 16;
  const shareGap = opts.shareGap ?? 28;
  const rightGap = opts.rightGap ?? 2;
  const minSlot = opts.minSlot ?? 22;
  const innerH = height - padY * 2;
  const byColumn = (c: 0 | 1 | 2) => model.nodes.filter((n) => n.column === c);
  const total = (ns: FlowNode[]) => ns.reduce((s, n) => s + n.cents, 0);
  const left = byColumn(0);
  const middle = byColumn(1);
  const right = byColumn(2);
  // The patient share's label sits above it, so it always has room there, even on top.
  const gapBefore = (n: FlowNode, i: number) =>
    n.id === 'share' && right.length ? shareGap : i === 0 ? 0 : gap;
  const middleGaps = middle.reduce((s, n, i) => s + gapBefore(n, i), 0);
  const rightGaps = rightGap * Math.max(0, right.length - 1);
  // Each outcome on the right gets a slot at least one label tall, so small ages never stack
  // their labels on each other; the bar sits in the middle of its slot.
  const slot = (n: FlowNode, scale: number) => Math.max(minSlot, n.cents * scale);
  const rightSlots = (scale: number) => right.reduce((s, n) => s + slot(n, scale), 0) + rightGaps;
  // The outcomes start level with the patient share's top, so the streams fanning out never
  // climb into the labels above; what they need beyond the share hangs below it.
  const hasShare = middle.some((n) => n.id === 'share');
  const overhang = (scale: number) =>
    hasShare ? Math.max(0, rightSlots(scale) - total(right) * scale) : 0;

  // One scale for the whole diagram (cents → px), set by the column that needs the most room.
  // The right column's slots depend on the scale, so settle it in a few passes (it only shrinks).
  const fit = (ns: FlowNode[], gaps: number) =>
    ns.length ? Math.max(0, innerH - gaps) / Math.max(1, total(ns)) : Infinity;
  let scale = Math.min(fit(left, 0), fit(middle, middleGaps), fit(right, rightGaps));
  for (let pass = 0; pass < 3; pass++) {
    const padded = right.reduce((s, n) => s + Math.max(0, minSlot - n.cents * scale), 0);
    scale = Math.min(
      fit(left, 0),
      fit(middle, middleGaps + overhang(scale)),
      fit(right, rightGaps + padded),
    );
  }
  if (!Number.isFinite(scale)) scale = 0;
  const span = width - padLeft - padRight - nodeWidth;
  const colX = [padLeft, padLeft + span / 2, padLeft + span];

  const boxes = new Map<FlowNodeId, NodeBox>();
  const h = (n: FlowNode) => Math.max(2, n.cents * scale);
  const leftH = total(left) * scale;
  let y = padY + (innerH - leftH) / 2;
  for (const n of left) {
    boxes.set(n.id, { node: n, x: colX[0]!, y, w: nodeWidth, h: h(n) });
    y += h(n);
  }
  const middleH = middle.reduce((s, n) => s + h(n), 0) + middleGaps;
  y = padY + Math.max(0, (innerH - middleH - overhang(scale)) / 2);
  middle.forEach((n, i) => {
    y += gapBefore(n, i);
    boxes.set(n.id, { node: n, x: colX[1]!, y, w: nodeWidth, h: h(n) });
    y += h(n);
  });
  const share = boxes.get('share');
  const rightH = rightSlots(scale);
  const rightTop = share ? share.y : padY + (innerH - rightH) / 2;
  y = Math.max(padY, Math.min(rightTop, height - padY - rightH));
  for (const n of right) {
    const room = slot(n, scale);
    boxes.set(n.id, { node: n, x: colX[2]!, y: y + (room - h(n)) / 2, w: nodeWidth, h: h(n) });
    y += room + rightGap;
  }

  // Ribbons: stacked in each node in target (or source) order, so they never cross at a node.
  const outOffset = new Map<FlowNodeId, number>();
  const inOffset = new Map<FlowNodeId, number>();
  const order = (id: FlowNodeId) => model.nodes.findIndex((n) => n.id === id);
  const links = [...model.links].sort((a, b) => order(a.to) - order(b.to));
  const shapes: LinkShape[] = [];
  for (const link of links) {
    const s = boxes.get(link.from);
    const t = boxes.get(link.to);
    if (!s || !t) continue;
    const thickness = Math.max(1, link.cents * scale);
    const sy = s.y + (outOffset.get(link.from) ?? 0);
    const ty = t.y + (inOffset.get(link.to) ?? 0);
    outOffset.set(link.from, (outOffset.get(link.from) ?? 0) + thickness);
    inOffset.set(link.to, (inOffset.get(link.to) ?? 0) + thickness);
    const x0 = s.x + s.w;
    const x1 = t.x;
    const mx = (x0 + x1) / 2;
    const path =
      `M${x0},${sy} C${mx},${sy} ${mx},${ty} ${x1},${ty} ` +
      `L${x1},${ty + thickness} C${mx},${ty + thickness} ${mx},${sy + thickness} ${x0},${sy + thickness} Z`;
    const c0 = { x: x0, y: sy + thickness / 2 };
    const c3 = { x: x1, y: ty + thickness / 2 };
    shapes.push({
      link,
      path,
      curve: [c0, { x: mx, y: c0.y }, { x: mx, y: c3.y }, c3],
      thickness,
      color: t.node.color,
      tint: t.node.tint,
    });
  }
  return { width, height, nodes: [...boxes.values()], links: shapes };
}

/** Point on a cubic Bézier at t ∈ [0, 1]. */
export function bezierPoint([p0, p1, p2, p3]: LinkShape['curve'], t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/** Particles per stream: about one per $200, at least one, at most 24. A hint of motion. */
export function particleCount(link: FlowLink): number {
  return Math.min(24, Math.max(1, Math.round(link.cents / 20_000)));
}

/** Interpolate two models' amounts (same node and link ids) for a smooth update. */
export function tweenFlow(from: FlowModel, to: FlowModel, t: number): FlowModel {
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  const fromNode = new Map(from.nodes.map((n) => [n.id, n.cents]));
  const fromLink = new Map(from.links.map((l) => [l.id, l.cents]));
  const ids = new Set([...from.links.map((l) => l.id), ...to.links.map((l) => l.id)]);
  const toLink = new Map(to.links.map((l) => [l.id, l]));
  const links = [...ids].map((id) => {
    const target = toLink.get(id);
    const source = from.links.find((l) => l.id === id)!;
    const base = target ?? { ...source, cents: 0 };
    return { ...base, cents: mix(fromLink.get(id) ?? 0, target?.cents ?? 0) };
  });
  const nodeIds = new Set([...from.nodes.map((n) => n.id), ...to.nodes.map((n) => n.id)]);
  const nodes = [...nodeIds].map((id) => {
    const target = to.nodes.find((n) => n.id === id) ?? {
      ...from.nodes.find((n) => n.id === id)!,
      cents: 0,
    };
    return { ...target, cents: mix(fromNode.get(id) ?? 0, target.cents) };
  });
  const order = (id: FlowNodeId) => NODES.findIndex((n) => n.id === id);
  nodes.sort((a, b) => order(a.id) - order(b.id));
  return { nodes: nodes.filter((n) => n.cents > 0), links: links.filter((l) => l.cents > 0) };
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The particle canvas sits above the diagram, so particles used to drift across the stage labels
 * ("Patient share $3,523" at 1280×720). Particles are clipped out of each label's box, padded to
 * cover the label's white halo.
 */
export function labelKeepOut(labels: Box[], pad = 3): Box[] {
  return labels
    .filter((b) => b.width > 0 && b.height > 0)
    .map((b) => ({
      x: b.x - pad,
      y: b.y - pad,
      width: b.width + 2 * pad,
      height: b.height + 2 * pad,
    }));
}
