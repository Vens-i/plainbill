import { describe, expect, it } from 'vitest';
import { DATE_FILTER_HINT, insightsSources } from '../src/pages/insights/report';

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
});
