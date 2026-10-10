import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  assistantAmounts,
  checkAnswer,
  ClaudeBillAssistant,
  explainOwes,
  RuleBillAssistant,
  sourceLine,
  type BillFacts,
  type ProposalHandler,
  type ProposalInput,
} from '../src';

const maria: BillFacts = {
  patientFirstName: 'Maria',
  practice: { name: 'Harborview Family Medicine', phone: '(555) 014-2290', hours: 'Mon–Fri 8–5' },
  visitDate: '2026-10-03',
  provider: 'Dr. Patel',
  selfPay: false,
  payerShortName: 'BlueCross',
  billedCents: 85000,
  discountCents: 40000,
  allowedCents: 45000,
  insurancePaidCents: 21000,
  deductibleCents: 20000,
  coinsuranceCents: 4000,
  copayCents: 0,
  otherPatientCents: 0,
  patientShareCents: 24000,
  paidCents: 0,
  remainingCents: 24000,
  dueDate: '2026-11-02',
  services: [
    { name: 'Office visit with Dr. Patel', chargeCents: 35000 },
    { name: 'Blood work (metabolic panel)', chargeCents: 18000 },
    { name: 'Heart rhythm test (ECG)', chargeCents: 32000 },
  ],
  options: {
    payInFull: true,
    partialMinimumCents: null,
    plans: [
      { months: 3, firstCents: 8000, regularCents: 8000 },
      { months: 6, firstCents: 4000, regularCents: 4000 },
    ],
  },
  activePlan: null,
};

/** Records proposals and answers like the API would (cards built by code). */
function handler(): ProposalHandler & { seen: ProposalInput[] } {
  const seen: ProposalInput[] = [];
  return {
    seen,
    async propose(input) {
      seen.push(input);
      if (input.kind === 'partial_payment')
        return { ok: false, reason: 'Partial payments are not offered.' };
      const amount =
        input.kind === 'payment_plan' ? 8000 : input.kind === 'pay_in_full' ? 24000 : null;
      return {
        ok: true,
        card: {
          id: input.kind === 'phone_call' ? null : `act-${seen.length}`,
          kind: input.kind,
          title: input.kind,
          detail: [],
          amountCents: amount,
          confirmLabel: input.kind === 'phone_call' ? null : 'Confirm',
        },
        summary: `Card shown for ${input.kind}. The patient must tap Confirm.`,
      };
    },
  };
}

type Reply =
  { text: string } | { tool: string; input: Record<string, unknown> } | 'refusal' | Error;

/** Canned model turns, in order. */
function fakeClient(replies: Reply[]) {
  const calls: Array<{ messages: unknown[]; tools: Array<{ name: string }> }> = [];
  const client = {
    beta: {
      messages: {
        create: async (params: { messages: unknown[]; tools: Array<{ name: string }> }) => {
          calls.push({ messages: structuredClone(params.messages), tools: params.tools });
          const next = replies.shift();
          if (!next) throw new Error('no more canned replies');
          if (next instanceof Error) throw next;
          if (next === 'refusal') return { stop_reason: 'refusal', content: [] };
          if ('tool' in next) {
            return {
              stop_reason: 'tool_use',
              content: [
                { type: 'tool_use', id: `tu-${calls.length}`, name: next.tool, input: next.input },
              ],
            };
          }
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: next.text }] };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, calls };
}

const ask = (message: string, replies: Reply[], h = handler()) => {
  const { client, calls } = fakeClient(replies);
  const assistant = new ClaudeBillAssistant({ client, model: 'claude-test' });
  return assistant
    .reply({ facts: maria, history: [], message, handler: h })
    .then((r) => ({ r, calls, h }));
};

describe('bill facts', () => {
  it('explains the balance in the design’s words, with only the bill’s figures', () => {
    expect(explainOwes(maria)).toBe(
      'Your plan put $200 toward your yearly deductible — the amount you pay before insurance starts sharing costs. After that, your share was $40 (coinsurance). $200 + $40 = $240.',
    );
    expect(sourceLine(maria)).toBe("Based on BlueCross's statement for your Oct 3 visit");
    expect(checkAnswer(explainOwes(maria), maria)).toEqual([]);
  });

  it('allows the plan and service amounts, and rejects anything else', () => {
    const allowed = assistantAmounts(maria);
    for (const c of [8000, 4000, 35000, 45000, 24000]) expect(allowed.has(c)).toBe(true);
    expect(checkAnswer('You owe $245.', maria)[0]).toMatchObject({ kind: 'unknown-amount' });
    expect(checkAnswer('Code PR-1 means deductible.', maria)[0]).toMatchObject({
      kind: 'medical-code',
    });
    expect(checkAnswer('The 99214 visit.', maria)[0]).toMatchObject({ kind: 'medical-code' });
  });

  it('explains self-pay and partly paid balances', () => {
    const aisha: BillFacts = {
      ...maria,
      patientFirstName: 'Aisha',
      selfPay: true,
      payerShortName: null,
      billedCents: 120000,
      discountCents: 0,
      allowedCents: 120000,
      insurancePaidCents: 0,
      deductibleCents: 0,
      coinsuranceCents: 0,
      patientShareCents: 120000,
      paidCents: 60000,
      remainingCents: 60000,
    };
    expect(explainOwes(aisha)).toBe(
      "Your visit came to $1,200 at Harborview's self-pay price. You've paid $600 so far, so $600 is left.",
    );
    expect(sourceLine(aisha)).toBe("Based on Harborview's self-pay rate for your Oct 3 visit");
  });
});

describe('Claude bill assistant', () => {
  it('answers from the facts and shows its source', async () => {
    const { r, calls } = await ask('Why do I owe $240?', [
      {
        text: 'Your plan put $200 toward your deductible, and your coinsurance share was $40. $200 + $40 = $240.',
      },
    ]);
    expect(r).toMatchObject({
      via: 'claude',
      cards: [],
      source: "Based on BlueCross's statement for your Oct 3 visit",
    });
    // Only the tools that fit this bill: no partial payments were offered.
    expect(calls[0]!.tools.map((t) => t.name).sort()).toEqual([
      'offer_phone_call',
      'propose_pay_in_full',
      'propose_payment_plan',
    ]);
  });

  it('proposes a plan through a tool; the card comes from code, not the model', async () => {
    const { r, h, calls } = await ask('Can I pay over time?', [
      { tool: 'propose_payment_plan', input: { months: 3 } },
      {
        text: 'Yes! You can split it into 3 payments of $80, no interest. Tap Confirm below to set it up.',
      },
    ]);
    expect(h.seen).toEqual([{ kind: 'payment_plan', months: 3 }]);
    expect(r.cards).toHaveLength(1);
    expect(r.cards[0]).toMatchObject({ kind: 'payment_plan', id: 'act-1', amountCents: 8000 });
    // The tool result went back to the model before it wrote the answer.
    expect(JSON.stringify(calls[1]!.messages)).toContain('The patient must tap Confirm.');
  });

  it('retries once when the answer invents a figure, then falls back to the deterministic answer', async () => {
    const { r } = await ask('Why do I owe this?', [
      { text: 'You owe $245 because of your deductible.' },
      { text: 'It is $250 after the discount.' },
    ]);
    expect(r.via).toBe('rules');
    expect(r.text).toContain('$200 + $40 = $240.');
    expect(r.notes.join(' ')).toMatch(/\$245 is not one of this bill's figures/);
  });

  it('accepts a corrected second answer', async () => {
    const { r, calls } = await ask('Why do I owe this?', [
      { text: 'You owe $245.' },
      { text: 'You owe $240: $200 deductible plus $40 coinsurance.' },
    ]);
    expect(r.via).toBe('claude');
    expect(JSON.stringify(calls[1]!.messages)).toContain('$245 is not one of');
  });

  it('falls back when the API fails or refuses', async () => {
    const down = await ask('Can I talk to someone?', [new Error('socket hang up')]);
    expect(down.r.via).toBe('rules');
    expect(down.r.text).toContain('(555) 014-2290');
    expect(down.r.cards.map((c) => c.kind)).toEqual(['phone_call']);
    const refused = await ask('Why?', ['refusal']);
    expect(refused.r.via).toBe('rules');
  });

  it('tells the model when a proposal was refused', async () => {
    const { calls } = await ask('Can I pay $50 now?', [
      { tool: 'offer_phone_call', input: {} },
      {
        text: 'Partial payments aren’t available for this bill. You can pay $240 in full or start a plan.',
      },
    ]);
    expect(calls).toHaveLength(2);
  });
});

describe('rule-based helper (offline)', () => {
  const rules = new RuleBillAssistant();
  const reply = (message: string, h = handler()) =>
    rules.reply({ facts: maria, history: [], message, handler: h }).then((r) => ({ r, h }));

  it('answers "why do I owe" with the explanation', async () => {
    const { r } = await reply('Why do I owe $240?');
    expect(r.text).toBe(`Good question! ${explainOwes(maria)}`);
    expect(r.cards).toEqual([]);
  });

  it('offers the plan staff made available', async () => {
    const { r, h } = await reply('Can I pay over time?');
    expect(h.seen).toEqual([{ kind: 'payment_plan', months: 3 }]);
    expect(r.text).toContain('3 payments of $80');
    expect(checkAnswer(r.text, maria)).toEqual([]);
  });

  it('explains and offers a call for "is this right?"', async () => {
    const { r } = await reply('Is this right?');
    expect(r.text).toContain('$200 + $40 = $240.');
    expect(r.cards.map((c) => c.kind)).toEqual(['phone_call']);
  });
});
