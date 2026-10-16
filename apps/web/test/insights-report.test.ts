import { describe, expect, it } from 'vitest';
import { DATE_FILTER_HINT, insightsSources } from '../src/pages/insights/report';

const empty = { today: '2026-10-10', balances: [], payments: [], adjustments: [] };

describe('insightsSources', () => {
  it('tells the analyst how to write date filters so Studio keeps the right day', () => {
    // Found live: in America/New_York, Studio read a "2026-10-01T00:00:00Z" lower bound as
    // Sep 30, so a Sep 30 denial was reported as "this quarter".
    const { description } = insightsSources({
      today: '2026-10-10',
      balances: [],
      payments: [],
      adjustments: [],
    });
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
});
