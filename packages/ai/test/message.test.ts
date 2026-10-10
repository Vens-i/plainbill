import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { ClaudeMessageDrafter, TemplateMessageDrafter } from '../src/message/drafter';
import type { MessageFacts } from '../src/message/facts';
import { checkMessage, findAmounts } from '../src/message/guard';
import { templateMessage } from '../src/message/template';

const maria: MessageFacts = {
  patientFirstName: 'Maria',
  practiceName: 'Harborview Family Medicine',
  providerName: 'Dr. Patel',
  visitDate: '2026-10-03',
  payerShortName: 'BlueCross',
  selfPay: false,
  billedCents: 85000,
  discountCents: 40000,
  insurancePaidCents: 21000,
  owesCents: 24000,
  deductibleCents: 20000,
  coinsuranceCents: 4000,
  copayCents: 0,
  otherPatientCents: 0,
  plan: { months: 3, firstCents: 8000, regularCents: 8000 },
  partialMinimumCents: 2000,
  dueDate: '2026-11-02',
};

describe('message guard', () => {
  it('finds dollar amounts in several formats', () => {
    expect(findAmounts('You owe $240, of $1,850.50 or $ 80.00 total.')).toEqual([
      24000, 185050, 8000,
    ]);
  });

  it('accepts the design message', () => {
    const design =
      'Hi Maria, thanks for visiting Dr. Patel on Oct 3. Your visit came to $850. Your BlueCross plan lowered that to $450 and paid $210. The $240 left is $200 toward your yearly deductible plus $40 for your share of the cost. You can pay in full or split it into 3 payments of $80.';
    expect(checkMessage(design, maria)).toEqual([]);
  });

  it('rejects invented figures and medical codes', () => {
    expect(checkMessage('You owe $250 for your visit.', maria)).toEqual([
      { kind: 'unknown-amount', detail: "$250.00 is not one of this bill's figures." },
    ]);
    expect(checkMessage('Your 99214 visit costs $240.', maria)[0]).toMatchObject({
      kind: 'medical-code',
    });
    expect(checkMessage('Diagnosis E11.9 means $240.', maria)[0]).toMatchObject({
      kind: 'medical-code',
    });
    expect(checkMessage('  ', maria)).toEqual([{ kind: 'empty', detail: 'The message is empty.' }]);
  });
});

describe('templateMessage', () => {
  it('writes the design copy for Maria', () => {
    expect(templateMessage(maria, 'default')).toBe(
      'Hi Maria, thanks for visiting Dr. Patel on Oct 3. Your visit came to $850. Your BlueCross plan lowered that to $450 and paid $210. The $240 left is $200 toward your yearly deductible plus $40 for your share of the cost. You can pay in full or split it into 3 payments of $80.',
    );
  });

  it('has simpler and Spanish variants that pass the guard', () => {
    for (const variant of ['default', 'simpler', 'spanish'] as const) {
      expect(checkMessage(templateMessage(maria, variant), maria), variant).toEqual([]);
    }
    expect(templateMessage(maria, 'spanish')).toMatch(
      /^Hola Maria, gracias por su visita con el Dr\. Patel el 3 de octubre\./,
    );
    expect(templateMessage(maria, 'simpler')).toBe(
      'Hi Maria. You owe $240 for your Oct 3 visit with Dr. Patel. Your insurance already covered the rest. You can pay it all at once or in 3 payments of $80.',
    );
  });

  it('handles self-pay and uneven plans', () => {
    const kevin: MessageFacts = {
      ...maria,
      patientFirstName: 'Kevin',
      providerName: 'Dr. Kim',
      visitDate: '2026-09-29',
      payerShortName: null,
      selfPay: true,
      billedCents: 27500,
      discountCents: 0,
      insurancePaidCents: 0,
      owesCents: 27500,
      deductibleCents: 0,
      coinsuranceCents: 0,
      plan: { months: 3, firstCents: 9168, regularCents: 9166 },
    };
    const text = templateMessage(kevin, 'default');
    expect(text).toBe(
      'Hi Kevin, thanks for visiting Dr. Kim on Sep 29. Your visit came to $275 at our self-pay rate. You can pay in full or split it into 3 payments: $91.68 first, then $91.66 a month.',
    );
    expect(checkMessage(text, kevin)).toEqual([]);
  });
});

/** A stand-in for the SDK client that returns canned replies in order. */
function fakeClient(replies: Array<string | 'refusal' | Error>) {
  const calls: unknown[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: unknown) => {
          calls.push(params);
          const reply = replies.shift();
          if (reply instanceof Error) throw reply;
          if (reply === 'refusal') return { stop_reason: 'refusal', content: [] };
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: reply ?? '' }] };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, calls };
}

describe('ClaudeMessageDrafter', () => {
  const good =
    'Hi Maria! Your Oct 3 visit with Dr. Patel came to $850; BlueCross paid $210 and you owe $240.';

  it('returns the AI draft when it passes the guard, with fallbacks enabled', async () => {
    const { client, calls } = fakeClient([good]);
    const result = await new ClaudeMessageDrafter({ client, model: 'claude-test' }).draft(
      maria,
      'default',
    );
    expect(result).toEqual({
      text: good,
      variant: 'default',
      source: 'ai',
      model: 'claude-test',
      notes: [],
    });
    expect(calls[0]).toMatchObject({
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
    });
    expect(JSON.stringify(calls[0])).not.toMatch(/99214|Heart rhythm|metabolic/);
  });

  it('retries once with the problems spelled out, then accepts a fixed draft', async () => {
    const { client, calls } = fakeClient(['You owe $245.', good]);
    const result = await new ClaudeMessageDrafter({ client, model: 'claude-test' }).draft(
      maria,
      'default',
    );
    expect(result.source).toBe('ai');
    expect(result.notes).toEqual(["Draft 1 rejected: $245.00 is not one of this bill's figures."]);
    expect(JSON.stringify(calls[1])).toContain('$245.00 is not one of this bill');
  });

  it('falls back to the template after two bad drafts, a refusal, or an API error', async () => {
    const twiceBad = await new ClaudeMessageDrafter({
      client: fakeClient(['$1', '$2']).client,
      model: 'm',
    }).draft(maria, 'simpler');
    expect(twiceBad).toMatchObject({ source: 'template', text: templateMessage(maria, 'simpler') });
    expect(twiceBad.notes).toHaveLength(2);

    const refused = await new ClaudeMessageDrafter({
      client: fakeClient(['refusal']).client,
      model: 'm',
    }).draft(maria, 'default');
    expect(refused).toMatchObject({
      source: 'template',
      notes: ['The model declined to write this message.'],
    });

    const down = await new ClaudeMessageDrafter({
      client: fakeClient([new Error('socket hang up')]).client,
      model: 'm',
    }).draft(maria, 'default');
    expect(down).toMatchObject({ source: 'template', notes: ['AI unavailable (socket hang up).'] });
  });

  it('the template drafter is deterministic', async () => {
    expect(await new TemplateMessageDrafter().draft(maria, 'default')).toMatchObject({
      source: 'template',
      model: null,
    });
  });
});
