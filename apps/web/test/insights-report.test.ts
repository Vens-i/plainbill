import { describe, expect, it } from 'vitest';
import type { InsightsData } from '@plainbill/api/contract';
import {
  ADJUSTMENTS_DESCRIPTION,
  PATIENT_FIELD,
  DATE_FILTER_HINT,
  insightsSources,
} from '../src/pages/insights/report';

const empty: InsightsData = {
  today: '2026-10-10',
  patientNames: 'full',
  balances: [],
  payments: [],
  adjustments: [],
};

describe('insightsSources', () => {
  it('tells the analyst how to write date filters so Studio keeps the right day', () => {
    // Found live: in America/New_York, Studio read a "2026-10-01T00:00:00Z" lower bound as
    // Sep 30, so a Sep 30 denial was reported as "this quarter".
    const { description } = insightsSources(empty);
    expect(description).toContain('Today is 2026-10-10.');
    expect(description).toContain(DATE_FILTER_HINT);
    expect(DATE_FILTER_HINT).toMatch(/2026-10-01T00:00:00 /);
  });

  it('ties payments and adjustments to their balance, so balance filters narrow them too', () => {
    // Found live: clicking "90+ days" in the money flow showed Collected $600 in the flow but
    // $1,180 on the Collected tile, which sums payments and ignored the balance filter.
    const { relationships } = insightsSources(empty);
    expect(relationships).toEqual(
      ['payments', 'adjustments'].map((tableId) => ({
        id: `${tableId}-balance`,
        source: { tableId, fieldId: 'balanceId' },
        target: { tableId: 'balances', fieldId: 'balanceId' },
        type: 'many-to-one',
      })),
    );
  });

  it('says self-pay visits have no adjustments, so the patient share there is not "unexplained"', () => {
    const adjustments = insightsSources(empty).sources.find((s) => s.id === 'adjustments')!;
    expect(adjustments.description).toBe(ADJUSTMENTS_DESCRIPTION);
    expect(ADJUSTMENTS_DESCRIPTION).toContain('Self-pay visits have no adjustments');
  });

  it('gives Balances and Payments a Patient field that says what it holds', () => {
    // Found live: the analyst could only say "visit #11" while the widget showed Aisha Bello.
    for (const mode of ['full', 'initials', 'off'] as const) {
      const { sources } = insightsSources({ ...empty, patientNames: mode });
      for (const id of ['balances', 'payments']) {
        const fields = sources.find((s) => s.id === id)!.fields;
        expect(fields.find((f) => f.id === 'patientId')).toBeTruthy();
        expect(fields.find((f) => f.id === 'patient')).toMatchObject({
          description: PATIENT_FIELD[mode],
        });
      }
    }
  });
});
