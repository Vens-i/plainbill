import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  buildStatementModel,
  layoutStatement,
  statementAging,
  type StatementInput,
} from '@plainbill/core';
import {
  annotateFactsFor,
  checkNote,
  ClaudeStatementAnnotator,
  TemplateStatementAnnotator,
  type AnnotateFacts,
  type MessageFacts,
  type NoteDraft,
} from '../src';

const MARIA_INPUT: StatementInput = {
  practice: {
    name: 'Harborview Family Medicine',
    addressLine1: '220 Harbor St',
    addressLine2: 'Suite 4',
    city: 'Harborview',
    state: 'CA',
    zip: '94000',
    phone: '(555) 014-2290',
    hours: 'Mon–Fri 8–5',
    payUrlHost: 'pay.example.test',
  },
  patient: { firstName: 'Maria', lastName: 'Delgado', addressLines: [] },
  accountNumber: '000001',
  statementId: 'S0000014',
  statementDate: '2026-10-10',
  dueDate: '2026-11-02',
  payUrl: 'https://pay.example.test/pay/abc',
  visit: {
    date: '2026-10-03',
    providerName: 'Dr. Patel',
    payerName: 'BlueCross BlueShield',
    payerShortName: 'BlueCross',
    selfPay: false,
    claimFiledDate: null,
    paymentDate: '2026-10-08',
    traceNumber: 'BC1008120117',
  },
  lines: [
    { code: '99214', chargeCents: 35000 },
    { code: '80053', chargeCents: 18000 },
    { code: '93000', chargeCents: 32000 },
  ],
  contractualCents: 40000,
  contractualCode: 'CO45',
  insurancePaidCents: 21000,
  patientShare: {
    deductibleCents: 20000,
    coinsuranceCents: 4000,
    copayCents: 0,
    otherCents: 0,
    selfPayCents: 0,
  },
  payments: [],
  remainingCents: 24000,
  aging: statementAging(24000, 7),
  planOffer: { months: 3, firstCents: 8000, regularCents: 8000 },
  planActive: null,
};

const MARIA_MESSAGE: MessageFacts = {
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
  partialMinimumCents: null,
  dueDate: '2026-11-02',
};

function facts(code = 'es', name = 'Spanish'): AnnotateFacts {
  const model = buildStatementModel(MARIA_INPUT);
  return annotateFactsFor(MARIA_MESSAGE, { model, layout: layoutStatement(model) }, { code, name });
}

/** Good Spanish notes, one per anchor. */
const SPANISH: NoteDraft[] = [
  { anchorId: 'amount_due', title: 'Esto es lo que debe', body: '$240.00 es todo lo que debe.' },
  {
    anchorId: 'charges',
    title: 'Lo que le hicieron',
    body: 'Su visita del 3 de octubre con Dr. Patel. Precio completo: $850.',
  },
  {
    anchorId: 'insurance_payment',
    title: 'Su seguro pagó $210',
    body: 'BlueCross pagó $210 a la clínica.',
  },
  {
    anchorId: 'discount',
    title: 'Un descuento, no un cobro',
    body: 'Se descuentan $400. Usted nunca paga esta parte.',
  },
  {
    anchorId: 'patient_responsibility',
    title: '¿Por qué debe $240?',
    body: '$200 van a su deducible y $40 es su coseguro.',
  },
  {
    anchorId: 'messages',
    title: 'Tiene opciones',
    body: 'Pague todo o en 3 pagos de $80. Llame al (555) 014-2290.',
  },
];

type Reply = NoteDraft[] | Error | 'refusal';

/** A client whose `beta.messages.parse` answers from a script, one reply per call. */
function fakeClient(replies: Reply[]) {
  const calls: Array<{ content: string }> = [];
  const client = {
    beta: {
      messages: {
        parse: async (params: { messages: Array<{ content: string }> }) => {
          calls.push({ content: params.messages[0]!.content });
          const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
          if (reply instanceof Error) throw reply;
          if (reply === 'refusal') return { stop_reason: 'refusal', parsed_output: null };
          return { stop_reason: 'end_turn', parsed_output: { notes: reply } };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, calls };
}

const annotator = (replies: Reply[]) => {
  const { client, calls } = fakeClient(replies);
  return { a: new ClaudeStatementAnnotator({ client, model: 'claude-test' }), calls };
};

describe('statement note guard', () => {
  const f = facts();
  const anchor = (id: string) => f.anchors.find((a) => a.id === id)!;

  it('accepts the figures listed on the line, plus what the patient owes', () => {
    expect(
      checkNote(
        { anchorId: 'discount', title: 'Un descuento', body: '$400 de $850; usted debe $240.' },
        anchor('discount'),
        f,
      ),
    ).toEqual([]);
  });

  it('rejects an invented amount, a code, an empty note, a long one and an unknown line', () => {
    const kinds = (draft: NoteDraft) =>
      checkNote(draft, anchor(draft.anchorId), f).map((i) => i.kind);
    expect(
      kinds({ anchorId: 'discount', title: 'Descuento', body: 'Se descuentan $410.' }),
    ).toEqual(['unknown-amount']);
    expect(kinds({ anchorId: 'charges', title: 'Servicios', body: 'El código 99214.' })).toEqual([
      'medical-code',
    ]);
    expect(kinds({ anchorId: 'charges', title: '', body: 'x' })).toEqual(['empty']);
    expect(
      kinds({ anchorId: 'charges', title: 'Servicios', body: Array(60).fill('palabra').join(' ') }),
    ).toEqual(['too-long']);
    expect(checkNote({ anchorId: 'nope', title: 'a', body: 'b' }, undefined, f)[0]!.kind).toBe(
      'unknown-anchor',
    );
  });

  it('counts Chinese by characters, not spaces', () => {
    const zh = facts('zh', 'Chinese (Simplified)');
    expect(
      checkNote(
        { anchorId: 'charges', title: '您做了什么', body: '这'.repeat(150) },
        zh.anchors[1],
        zh,
      ).map((i) => i.kind),
    ).toEqual(['too-long']);
    expect(
      checkNote(
        { anchorId: 'charges', title: '您做了什么', body: '这'.repeat(60) },
        zh.anchors[1],
        zh,
      ),
    ).toEqual([]);
  });
});

describe('TemplateStatementAnnotator (no API key)', () => {
  it('uses the English or Spanish template, and English (flagged) for other languages', async () => {
    const t = new TemplateStatementAnnotator();
    const es = await t.annotate(facts('es', 'Spanish'));
    expect(es).toMatchObject({ source: 'template', fallback: false, model: null });
    expect(es.notes[3]!.title).toBe('Un descuento, no un cobro');
    const en = await t.annotate(facts('en', 'English'));
    expect(en.notes[3]!.title).toBe('A discount, not a bill');
    expect(en.fallback).toBe(false);
    const ht = await t.annotate(facts('ht', 'Haitian Creole'));
    expect(ht.fallback).toBe(true);
    expect(ht.notes[3]!.title).toBe('A discount, not a bill');
  });
});

describe('ClaudeStatementAnnotator', () => {
  it('keeps Spanish notes that pass the guard, and asks in the right language', async () => {
    const { a, calls } = annotator([SPANISH]);
    const result = await a.annotate(facts());
    expect(result).toMatchObject({ source: 'ai', fallback: false, model: 'claude-test' });
    expect(result.notes.map((n) => n.title)).toEqual(SPANISH.map((n) => n.title));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.content).toContain('in Spanish');
    expect(calls[0]!.content).toContain('printed line: CO45 −400.00');
    expect(calls[0]!.content).toContain('MEANING: A discount, not a bill.');
  });

  it('never lets an invented amount through: retry, then the template for that note', async () => {
    const invented = SPANISH.map((n) =>
      n.anchorId === 'discount' ? { ...n, body: 'Se descuentan $450. Usted nunca paga esto.' } : n,
    );
    const { a, calls } = annotator([invented, invented]);
    const result = await a.annotate(facts());
    expect(calls).toHaveLength(2);
    expect(calls[1]!.content).toContain('$450.00, which is not one of that line');
    expect(result.source).toBe('mixed');
    const discount = result.notes.find((n) => n.anchorId === 'discount')!;
    expect(discount.title).toBe('Un descuento, no un cobro');
    expect(JSON.stringify(result.notes)).not.toContain('$450');
    expect(result.diagnostics.join(' ')).toMatch(/rejected/);
  });

  it('accepts the retry when it fixes the problem', async () => {
    const invented = SPANISH.map((n) =>
      n.anchorId === 'messages' ? { ...n, body: 'Pague en 3 pagos de $85.' } : n,
    );
    const { a, calls } = annotator([invented, SPANISH]);
    const result = await a.annotate(facts());
    expect(calls).toHaveLength(2);
    expect(result.source).toBe('ai');
  });

  it('fills a missing note from the template', async () => {
    const { a } = annotator([SPANISH.slice(0, 5)]);
    const result = await a.annotate(facts());
    expect(result.notes.map((n) => n.anchorId)).toEqual([
      'amount_due',
      'charges',
      'insurance_payment',
      'discount',
      'patient_responsibility',
      'messages',
    ]);
    expect(result.notes[5]!.title).toBe('Tiene opciones');
    expect(result.notes[5]!.body).toContain('3 pagos de $80 sin cargos');
    expect(result.source).toBe('mixed');
  });

  it('falls back to the template on a refusal or an API error', async () => {
    const refused = await annotator(['refusal']).a.annotate(facts());
    expect(refused).toMatchObject({ source: 'template', model: null });
    expect(refused.notes[0]!.title).toBe('Esto es lo que debe');
    const down = await annotator([new Error('socket hang up')]).a.annotate(facts());
    expect(down.source).toBe('template');
    expect(down.diagnostics[0]).toMatch(/AI unavailable/);
  });

  it('uses English (flagged) for a failed note in a language without a template', async () => {
    const creole: NoteDraft[] = SPANISH.map((n) => ({ ...n, title: 'Nòt', body: 'Ou dwe $240.' }));
    creole[2] = { anchorId: 'insurance_payment', title: 'Asirans', body: 'Asirans peye $999.' };
    const result = await annotator([creole, creole]).a.annotate(facts('ht', 'Haitian Creole'));
    expect(result.source).toBe('mixed');
    expect(result.fallback).toBe(true);
    expect(result.notes[2]!.title).toBe('Your insurance paid $210');
    expect(result.notes[0]!.body).toBe('Ou dwe $240.');
  });
});
