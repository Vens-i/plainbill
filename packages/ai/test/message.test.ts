import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { ClaudeMessageDrafter, TemplateMessageDrafter } from '../src/message/drafter';
import type { MessageFacts } from '../src/message/facts';
import { checkMessage, findAmounts } from '../src/message/guard';
import { messageTemplate, templateMessage } from '../src/message/template';

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

  it('with strictNumbers, checks figures written without a dollar sign', () => {
    const strict = { strictNumbers: true };
    // Vietnamese and French put the currency after the number.
    expect(
      checkMessage(
        'Chào Maria, ngày 3/10/2026 bạn còn nợ 240 đô la, trả 3 lần 80 $.',
        maria,
        strict,
      ),
    ).toEqual([]);
    expect(checkMessage('Vous devez 250 $.', maria, strict)).toEqual([
      { kind: 'unknown-number', detail: `"250" is not one of this bill's figures.` },
    ]);
    expect(checkMessage('Вы должны 240,00 $ (визит 03.10.2026).', maria, strict)).toEqual([]);
    expect(checkMessage('您需支付240美元，或分7期。', maria, strict)[0]).toMatchObject({
      kind: 'unknown-number',
    });
    // A dollar-sign figure is still checked once, by the dollar rule.
    expect(checkMessage('Debe $245.', maria, strict)).toEqual([
      { kind: 'unknown-amount', detail: "$245.00 is not one of this bill's figures." },
    ]);
    // English keeps today's rule: bare numbers (a phone extension, say) are fine.
    expect(checkMessage('Call ext. 250 about your $240.', maria)).toEqual([]);
  });
});

describe('templateMessage', () => {
  it('writes the design copy for Maria', () => {
    expect(templateMessage(maria, 'default')).toBe(
      'Hi Maria, thanks for visiting Dr. Patel on Oct 3. Your visit came to $850. Your BlueCross plan lowered that to $450 and paid $210. The $240 left is $200 toward your yearly deductible plus $40 for your share of the cost. You can pay in full or split it into 3 payments of $80.',
    );
  });

  it('has simpler and Spanish versions that pass the guard', () => {
    for (const lang of ['en', 'es']) {
      for (const variant of ['default', 'simpler'] as const) {
        const text = templateMessage(maria, variant, lang);
        expect(checkMessage(text, maria, { strictNumbers: true }), `${lang} ${variant}`).toEqual(
          [],
        );
      }
    }
    expect(templateMessage(maria, 'default', 'es')).toMatch(
      /^Hola Maria, gracias por su visita del 3 de octubre \(Dr\. Patel\)\./,
    );
    expect(templateMessage(maria, 'simpler')).toBe(
      'Hi Maria. You owe $240 for your Oct 3 visit with Dr. Patel. Your insurance already covered the rest. You can pay it all at once or in 3 payments of $80.',
    );
    expect(templateMessage(maria, 'simpler', 'es')).toBe(
      'Hola Maria. Debe $240 por su visita del 3 de octubre (Dr. Patel). Su seguro ya pagó el resto. Puede pagar todo junto o en 3 pagos de $80.',
    );
  });

  it('falls back to English for languages without a template, and says which it used', () => {
    expect(messageTemplate(maria, 'default', 'vi')).toEqual({
      text: templateMessage(maria, 'default'),
      lang: 'en',
    });
    expect(messageTemplate(maria, 'simpler', 'es').lang).toBe('es');
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
    const result = await new ClaudeMessageDrafter({ client, model: 'claude-test' }).draft(maria, {
      variant: 'default',
      lang: 'en',
    });
    expect(result).toEqual({
      text: good,
      variant: 'default',
      lang: 'en',
      requestedLang: 'en',
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
    const result = await new ClaudeMessageDrafter({ client, model: 'claude-test' }).draft(maria, {
      variant: 'default',
      lang: 'en',
    });
    expect(result.source).toBe('ai');
    expect(result.notes).toEqual(["Draft 1 rejected: $245.00 is not one of this bill's figures."]);
    expect(JSON.stringify(calls[1])).toContain('$245.00 is not one of this bill');
  });

  it('falls back to the template after two bad drafts, a refusal, or an API error', async () => {
    const twiceBad = await new ClaudeMessageDrafter({
      client: fakeClient(['$1', '$2']).client,
      model: 'm',
    }).draft(maria, { variant: 'simpler', lang: 'en' });
    expect(twiceBad).toMatchObject({ source: 'template', text: templateMessage(maria, 'simpler') });
    expect(twiceBad.notes).toHaveLength(2);

    const refused = await new ClaudeMessageDrafter({
      client: fakeClient(['refusal']).client,
      model: 'm',
    }).draft(maria, { variant: 'default', lang: 'en' });
    expect(refused).toMatchObject({
      source: 'template',
      notes: ['The model declined to write this message.'],
    });

    const down = await new ClaudeMessageDrafter({
      client: fakeClient([new Error('socket hang up')]).client,
      model: 'm',
    }).draft(maria, { variant: 'default', lang: 'en' });
    expect(down).toMatchObject({ source: 'template', notes: ['AI unavailable (socket hang up).'] });
  });

  it('the template drafter is deterministic', async () => {
    expect(
      await new TemplateMessageDrafter().draft(maria, { variant: 'default', lang: 'en' }),
    ).toMatchObject({
      source: 'template',
      model: null,
      lang: 'en',
      notes: [],
    });
  });

  it('drafts in any statement language, asking for "$" figures', async () => {
    const vi =
      'Chào Maria, bạn còn nợ $240 cho lần khám ngày 3/10 với Dr. Patel. Bảo hiểm đã trả $210.';
    const { client, calls } = fakeClient([vi]);
    const result = await new ClaudeMessageDrafter({ client, model: 'm' }).draft(maria, {
      variant: 'simpler',
      lang: 'vi',
    });
    expect(result).toMatchObject({ text: vi, lang: 'vi', requestedLang: 'vi', source: 'ai' });
    const prompt = JSON.stringify(calls[0]);
    expect(prompt).toContain('natural Vietnamese');
    expect(prompt).toContain('under 50 words');
    expect(prompt).toContain('dollar sign before the digits');
  });

  it('applies the guard in other languages, bare numbers included', async () => {
    const { client, calls } = fakeClient([
      'Bonjour Maria, vous devez 245 $.',
      'Bonjour Maria, vous devez 240 $ pour votre visite du 3 octobre.',
    ]);
    const result = await new ClaudeMessageDrafter({ client, model: 'm' }).draft(maria, {
      variant: 'default',
      lang: 'fr',
    });
    expect(result).toMatchObject({ source: 'ai', lang: 'fr' });
    expect(result.notes).toEqual([`Draft 1 rejected: "245" is not one of this bill's figures.`]);
    expect(JSON.stringify(calls[1])).toContain('245');
  });

  it('falls back to the Spanish template, or to English with a note when there is none', async () => {
    const es = await new ClaudeMessageDrafter({
      client: fakeClient([new Error('down')]).client,
      model: 'm',
    }).draft(maria, { variant: 'default', lang: 'es' });
    expect(es).toMatchObject({
      source: 'template',
      lang: 'es',
      text: templateMessage(maria, 'default', 'es'),
    });

    const ht = await new ClaudeMessageDrafter({
      client: fakeClient(['Ou dwe 999 dola.', 'Ou dwe 999 dola.']).client,
      model: 'm',
    }).draft(maria, { variant: 'default', lang: 'ht' });
    expect(ht).toMatchObject({
      source: 'template',
      lang: 'en',
      requestedLang: 'ht',
      text: templateMessage(maria, 'default'),
    });
    expect(ht.notes).toHaveLength(3);
    expect(ht.notes.at(-1)).toBe('There’s no Haitian Creole template, so this is the English one.');

    const offline = await new TemplateMessageDrafter().draft(maria, {
      variant: 'simpler',
      lang: 'ko',
    });
    expect(offline).toMatchObject({ lang: 'en', requestedLang: 'ko' });
    expect(offline.notes).toEqual(['There’s no Korean template, so this is the English one.']);

    // Unknown codes are treated as English.
    expect(
      await new TemplateMessageDrafter().draft(maria, { variant: 'default', lang: 'xx' }),
    ).toMatchObject({ lang: 'en', requestedLang: 'en', notes: [] });
  });
});
