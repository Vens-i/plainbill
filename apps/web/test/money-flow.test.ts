import { describe, expect, it } from 'vitest';
import {
  bezierPoint,
  buildFlow,
  FlowMismatchError,
  labelKeepOut,
  layoutFlow,
  particleCount,
  tweenFlow,
  type FlowRow,
} from '../src/pages/insights/flow';

const row = (over: Partial<FlowRow>): FlowRow => ({
  balanceId: 1,
  status: 'Ready to invoice',
  billed: 850,
  insuranceDiscount: 400,
  insurancePaid: 210,
  patientShare: 240,
  patientPaid: 0,
  stillOwed: 240,
  aging: '0–30 days',
  ...over,
});

const ROWS: FlowRow[] = [
  row({}),
  row({
    balanceId: 2,
    status: 'Denied',
    billed: 2400,
    insuranceDiscount: 2400,
    insurancePaid: 0,
    patientShare: 0,
    stillOwed: 0,
    aging: '0–30 days',
  }),
  row({
    balanceId: 3,
    status: 'Partially paid',
    billed: 1200,
    insuranceDiscount: 0,
    insurancePaid: 0,
    patientShare: 1200,
    patientPaid: 600,
    stillOwed: 600,
    aging: '90+ days',
  }),
  row({
    balanceId: 4,
    status: 'Paid',
    billed: 560,
    insuranceDiscount: 50,
    insurancePaid: 410,
    patientShare: 100,
    patientPaid: 100,
    stillOwed: 0,
    aging: 'Settled',
  }),
];

const node = (m: ReturnType<typeof buildFlow>, id: string) => m.nodes.find((n) => n.id === id);

describe('buildFlow', () => {
  it('sends every billed dollar to exactly one place, in cents', () => {
    const m = buildFlow(ROWS);
    expect(node(m, 'billed')!.cents).toBe(501000);
    const column1 = m.nodes.filter((n) => n.column === 1).reduce((s, n) => s + n.cents, 0);
    expect(column1).toBe(501000);
    expect(node(m, 'denied')!.cents).toBe(240000);
    expect(node(m, 'discount')!.cents).toBe(45000);
    expect(node(m, 'share')!.cents).toBe(154000);
    expect(node(m, 'collected')!.cents).toBe(70000);
    expect(node(m, 'owed-0-30')!.cents).toBe(24000);
    expect(node(m, 'owed-90')!.cents).toBe(60000);
    expect(node(m, 'owed-31-60')).toBeUndefined();
    expect(node(m, 'billed')!.visits).toBe(4);
    expect(node(m, 'collected')!.visits).toBe(2);
  });

  it('refuses rows that do not add up', () => {
    expect(() => buildFlow([row({ insurancePaid: 211 })])).toThrow(FlowMismatchError);
    expect(() => buildFlow([row({ stillOwed: 239 })])).toThrow(FlowMismatchError);
  });

  it('sums cents exactly (no floating-point drift)', () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      row({
        balanceId: i,
        billed: 0.3,
        insuranceDiscount: 0.1,
        insurancePaid: 0.1,
        patientShare: 0.1,
        stillOwed: 0.1,
      }),
    );
    expect(node(buildFlow(rows), 'billed')!.cents).toBe(900);
  });
});

describe('layoutFlow', () => {
  const layout = layoutFlow(buildFlow(ROWS), { width: 1000, height: 360 });

  it('keeps every node on the canvas and nodes in a column apart', () => {
    for (const b of layout.nodes) {
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.y + b.h).toBeLessThanOrEqual(360);
    }
    for (const c of [0, 1, 2]) {
      const col = layout.nodes.filter((b) => b.node.column === c).sort((a, b) => a.y - b.y);
      for (let i = 1; i < col.length; i++) {
        expect(col[i]!.y).toBeGreaterThanOrEqual(col[i - 1]!.y + col[i - 1]!.h);
      }
    }
  });

  it('draws each stream as thick as its share of the money', () => {
    const billed = layout.nodes.find((b) => b.node.id === 'billed')!;
    const fromBilled = layout.links.filter((l) => l.link.from === 'billed');
    expect(fromBilled.reduce((s, l) => s + l.thickness, 0)).toBeCloseTo(billed.h, 5);
  });

  it('starts and ends each particle path on its nodes', () => {
    const l = layout.links[0]!;
    expect(bezierPoint(l.curve, 0)).toEqual(l.curve[0]);
    expect(bezierPoint(l.curve, 1).x).toBeCloseTo(l.curve[3].x, 6);
  });
});

describe('animation helpers', () => {
  it('scales particles with the money', () => {
    const m = buildFlow(ROWS);
    const counts = Object.fromEntries(m.links.map((l) => [l.id, particleCount(l)]));
    expect(counts['billed>denied']).toBe(20);
    expect(counts['share>owed-0-30']).toBe(2);
  });

  it('tweens between two states and lands exactly on the new one', () => {
    const before = buildFlow(ROWS);
    const after = buildFlow([
      row({ patientPaid: 240, stillOwed: 0, aging: 'Settled', status: 'Paid' }),
      ...ROWS.slice(1),
    ]);
    expect(tweenFlow(before, after, 1)).toEqual({
      nodes: after.nodes,
      links: expect.arrayContaining(after.links),
    });
    const mid = tweenFlow(before, after, 0.5);
    expect(mid.nodes.find((n) => n.id === 'owed-0-30')!.cents).toBe(12000);
  });
});

describe('labelKeepOut', () => {
  it('pads each label box so particles stay clear of the text and its halo', () => {
    // Found in the browser pass: at 1280×720 particles drifted across "Patient share $3,523".
    expect(labelKeepOut([{ x: 10, y: 20, width: 100, height: 14 }])).toEqual([
      { x: 7, y: 17, width: 106, height: 20 },
    ]);
    expect(labelKeepOut([{ x: 0, y: 0, width: 0, height: 0 }])).toEqual([]);
  });
});
