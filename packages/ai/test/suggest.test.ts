import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { checkSuggestion, ClaudeSuggester, ruleSuggestion, type RowSituation } from '../src';

const base: Omit<RowSituation, 'id' | 'status'> = {
  selfPay: false,
  daysSinceVisit: 20,
  owesCents: 24000,
  paidCents: 0,
  reviewReason: null,
  denialReason: null,
  invoice: null,
  plans: [
    { months: 3, regularCents: 8000 },
    { months: 6, regularCents: 4000 },
  ],
  activePlan: false,
};

const row = (id: number, status: RowSituation['status'], extra: Partial<RowSituation> = {}) =>
  ({ ...base, id, status, ...extra }) as RowSituation;

describe('rule suggestions (the design’s “AI suggests” column)', () => {
  it('matches the seeded rows', () => {
    expect(ruleSuggestion(row(1, 'ready')).label).toBe('Send invoice + 3-month plan');
    expect(ruleSuggestion(row(2, 'ready', { owesCents: 27500, plans: [] })).label).toBe(
      'Send invoice',
    );
    expect(
      ruleSuggestion(row(3, 'review', { reviewReason: 'Possible duplicate of claim 7731' })).label,
    ).toBe('Possible duplicate — compare');
    expect(
      ruleSuggestion(row(4, 'denied', { denialReason: 'CO-197 prior auth missing' })).label,
    ).toBe('Resubmit with auth number');
    expect(ruleSuggestion(row(5, 'denied', { denialReason: 'CO-16 referral missing' })).label).toBe(
      'Add referral & resubmit',
    );
    expect(
      ruleSuggestion(row(6, 'sent', { invoice: { daysSinceSent: 60, openCount: 2 } })).label,
    ).toBe('Send friendly reminder');
    expect(
      ruleSuggestion(row(7, 'sent', { invoice: { daysSinceSent: 20, openCount: 0 } })).label,
    ).toBe('Offer 3-month plan');
    expect(
      ruleSuggestion(
        row(8, 'partial', {
          owesCents: 60000,
          paidCents: 60000,
          plans: [
            { months: 3, regularCents: 20000 },
            { months: 6, regularCents: 10000 },
          ],
        }),
      ).label,
    ).toBe('Offer 6-month plan · $100/mo');
    expect(
      ruleSuggestion(row(10, 'sent', { invoice: { daysSinceSent: 2, openCount: 0 } })),
    ).toMatchObject({ action: 'none', label: 'Sent recently' });
    expect(ruleSuggestion(row(9, 'partial', { activePlan: true }))).toMatchObject({
      action: 'none',
      label: 'Plan on track',
    });
  });
});

describe('checking a model suggestion', () => {
  it('rejects actions that don’t fit the status, long labels and unknown figures', () => {
    const sent = row(1, 'sent', { invoice: { daysSinceSent: 10, openCount: 1 } });
    expect(checkSuggestion({ id: 1, action: 'send_invoice', label: 'Send invoice' }, sent)).toMatch(
      /doesn't fit/,
    );
    expect(
      checkSuggestion({ id: 1, action: 'send_reminder', label: 'x'.repeat(41) }, sent),
    ).toMatch(/1–40/);
    expect(
      checkSuggestion({ id: 1, action: 'offer_plan', label: 'Offer 3 × $85 plan' }, sent),
    ).toMatch(/\$85 is not/);
    expect(
      checkSuggestion({ id: 1, action: 'offer_plan', label: 'Offer 3 × $80 plan' }, sent),
    ).toBeNull();
    expect(checkSuggestion({ id: 1, action: 'none', label: 'Wait' }, sent)).toMatch(/next step/);
  });
});

function fakeParse(output: unknown) {
  const calls: unknown[] = [];
  const client = {
    beta: {
      messages: {
        parse: async (params: unknown) => {
          calls.push(params);
          if (output instanceof Error) throw output;
          return { parsed_output: output };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, calls };
}

describe('Claude suggester', () => {
  const rows = [
    row(1, 'sent', { invoice: { daysSinceSent: 30, openCount: 3 } }),
    row(2, 'denied', { denialReason: 'CO-197 prior auth missing' }),
  ];

  it('keeps valid suggestions and replaces invalid ones with the rule', async () => {
    const { client, calls } = fakeParse({
      suggestions: [
        { id: 1, action: 'offer_plan', label: 'Opened 3× — offer 3 × $80' },
        { id: 2, action: 'send_reminder', label: 'Remind the patient' },
      ],
    });
    const batch = await new ClaudeSuggester({ client, model: 'claude-test' }).suggest(rows);
    expect(batch.via).toBe('claude');
    expect(batch.suggestions).toEqual([
      { id: 1, action: 'offer_plan', label: 'Opened 3× — offer 3 × $80' },
      { id: 2, action: 'resubmit_with_auth', label: 'Resubmit with auth number' },
    ]);
    expect(batch.notes.join(' ')).toMatch(/Row 2/);
    // The model sees dollars and statuses, not names.
    const sent = (calls[0] as { messages: Array<{ content: string }> }).messages[0]!.content;
    expect(sent).toContain('"owes":"$240"');
    expect(sent).toContain('"status":"sent"');
  });

  it('falls back to the rules when the API fails', async () => {
    const { client } = fakeParse(new Error('timeout'));
    const batch = await new ClaudeSuggester({ client, model: 'claude-test' }).suggest(rows);
    expect(batch.via).toBe('rules');
    expect(batch.suggestions.map((s) => s.label)).toEqual([
      'Send friendly reminder',
      'Resubmit with auth number',
    ]);
  });
});
