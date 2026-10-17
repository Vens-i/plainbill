import { describe, expect, it } from 'vitest';
import { buildFlow, layoutFlow, tweenFlow, type FlowRow } from '../src/pages/insights/flow';

const SIZE = { width: 900, height: 320 };
const paid = (balanceId: number): FlowRow => ({
  balanceId,
  status: 'Paid',
  billed: 560,
  insuranceDiscount: 50,
  insurancePaid: 410,
  patientShare: 100,
  patientPaid: 100,
  stillOwed: 0,
  aging: 'Settled',
});

/** Every number that isn't finite, and every string (SVG path) with NaN or Infinity in it. */
function finite(v: unknown, at = 'flow'): string[] {
  if (typeof v === 'number') return Number.isFinite(v) ? [] : [`${at}=${v}`];
  if (typeof v === 'string') return /NaN|Infinity/.test(v) ? [`${at}="${v.slice(0, 40)}"`] : [];
  if (v && typeof v === 'object')
    return Object.entries(v).flatMap(([k, x]) => finite(x, `${at}.${k}`));
  return [];
}

describe('money flow edge cases', () => {
  it('a filter that matches nothing gives an empty model and a layout without NaN', () => {
    const empty = buildFlow([]);
    expect(empty.nodes).toEqual([]);
    expect(finite(layoutFlow(empty, SIZE))).toEqual([]);
  });

  it('every balance paid: the patient share all flows to Collected, no owed stages', () => {
    const model = buildFlow([paid(1), paid(2)]);
    expect(model.nodes.map((n) => n.id)).toEqual([
      'billed',
      'discount',
      'insurance',
      'share',
      'collected',
    ]);
    expect(model.nodes.find((n) => n.id === 'collected')!.cents).toBe(20_000);
    expect(finite(layoutFlow(model, SIZE))).toEqual([]);
  });

  it('tweens to and from nothing without NaN', () => {
    const full = buildFlow([paid(1)]);
    const empty = buildFlow([]);
    for (const t of [0, 0.5, 1]) {
      expect(finite(layoutFlow(tweenFlow(full, empty, t), SIZE))).toEqual([]);
      expect(finite(layoutFlow(tweenFlow(empty, full, t), SIZE))).toEqual([]);
    }
  });
});
