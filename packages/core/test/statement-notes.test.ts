import { describe, expect, it } from 'vitest';
import { findDollarAmounts } from '../src/money';
import { layoutStatement } from '../src/statement/layout';
import { buildStatementModel, type StatementInput } from '../src/statement/model';
import {
  allowedNoteAmounts,
  countWords,
  formatSpanishDate,
  NOTE_BODY_MAX_WORDS,
  NOTE_TITLE_MAX_WORDS,
  templateStatementNotes,
  type TemplateNoteLang,
} from '../src/statement/notes-template';
import {
  AISHA,
  KEVIN,
  LINDA,
  MARIA,
  MARIA_ON_PLAN,
  SAMUEL,
  SELF_PAY_DISCOUNT,
  THEO,
} from './fixtures/statements';

const ALL: Array<[string, StatementInput]> = [
  ['Maria', MARIA],
  ['Samuel', SAMUEL],
  ['Aisha', AISHA],
  ['Kevin', KEVIN],
  ['Linda', LINDA],
  ['self-pay discount', SELF_PAY_DISCOUNT],
  ['Maria on a plan', MARIA_ON_PLAN],
  ['Theo (split visit)', THEO],
];
const CASES = ALL.flatMap(([name, input]) =>
  (['en', 'es'] as const).map((lang) => [name, lang, input] as const),
);

function notesFor(input: StatementInput, lang: TemplateNoteLang) {
  const model = buildStatementModel(input);
  const layout = layoutStatement(model);
  return { model, layout, notes: templateStatementNotes(model, layout, lang) };
}

const byId = (input: StatementInput, lang: TemplateNoteLang) =>
  Object.fromEntries(notesFor(input, lang).notes.map((n) => [n.anchorId, n]));

describe('templateStatementNotes', () => {
  it("writes Maria's six notes in English", () => {
    expect(notesFor(MARIA, 'en').notes).toEqual([
      {
        anchorId: 'amount_due',
        title: 'This is what you owe',
        body: "$240.00, and that's the whole amount. The bigger numbers further down are the full price before insurance.",
      },
      {
        anchorId: 'charges',
        title: 'What you had done',
        body: 'Your Oct 3 visit with Dr. Patel: office visit, blood work (metabolic panel) and heart rhythm test (ECG). Full price before insurance: $850.',
      },
      {
        anchorId: 'insurance_payment',
        title: 'Your insurance paid $210',
        body: 'BlueCross sent the clinic $210 on Oct 8. Nothing for you to do on this line.',
      },
      {
        anchorId: 'discount',
        title: 'A discount, not a bill',
        body: '$400 comes off because Dr. Patel is in your insurance network. You never pay this part.',
      },
      {
        anchorId: 'patient_responsibility',
        title: "Why there's still $240",
        body: '$200 goes toward your yearly deductible, the amount you pay before insurance pays more. $40 is your coinsurance, your share of the cost after the deductible.',
      },
      {
        anchorId: 'messages',
        title: 'You have options',
        body: 'Pay it all now, or split it into 3 payments of $80 with no fees. Questions? Call (555) 014-2290.',
      },
    ]);
  });

  it('writes the same notes in Spanish, without guessing the provider’s gender', () => {
    const es = byId(MARIA, 'es');
    expect(es.patient_responsibility).toEqual({
      anchorId: 'patient_responsibility',
      title: '¿Por qué todavía debe $240?',
      body: '$200 van a su deducible del año: lo que usted paga antes de que su seguro pague más. $40 es su coseguro: su parte del costo después del deducible.',
    });
    expect(es.discount!.body).toBe(
      'Se descuentan $400 porque su proveedor (Dr. Patel) está en la red de su seguro. Usted nunca paga esta parte.',
    );
    expect(es.charges!.body).toBe(
      'Su visita del 3 de octubre (Dr. Patel): consulta, análisis de sangre (panel metabólico) y prueba del ritmo cardíaco (ECG). Precio completo antes del seguro: $850.',
    );
    expect(es.messages!.title).toBe('Tiene opciones');
    expect(formatSpanishDate('2026-07-15')).toBe('15 de julio');
  });

  it('explains a copay', () => {
    expect(byId(SAMUEL, 'en').patient_responsibility!.body).toBe(
      '$80 is your copay, the set amount your plan charges for a visit.',
    );
  });

  it('thanks Aisha for each payment and offers her plan', () => {
    const en = byId(AISHA, 'en');
    expect(Object.keys(en)).toEqual([
      'amount_due',
      'charges',
      'payment-1',
      'payment-2',
      'messages',
    ]);
    expect(en['payment-1']!.body).toBe(
      "You paid $300 on Jul 15. Thank you! It's already taken off your balance.",
    );
    expect(en.amount_due!.body).toBe(
      "$600.00 is what's left after your payments. Thank you for what you've paid so far.",
    );
    expect(en.messages!.body).toContain('6 payments of $100');
  });

  it('calls a self-pay discount the self-pay rate, and Kevin has none', () => {
    expect(byId(SELF_PAY_DISCOUNT, 'en').discount).toEqual({
      anchorId: 'discount',
      title: 'Your self-pay discount',
      body: "$60 comes off the $310 full price because you're paying without insurance. You never pay this part.",
    });
    expect(byId(KEVIN, 'en').discount).toBeUndefined();
    expect(byId(KEVIN, 'en').charges!.body).toBe(
      'Your Sep 29 visit with Dr. Kim: office visit and rapid strep test. Full price: $275.',
    );
  });

  it('follows an active plan and a paid bill', () => {
    expect(byId(MARIA_ON_PLAN, 'en').messages!.body).toBe(
      "You're on a 3-month plan: 1 of 3 paid. Next $80 on Nov 10. Questions? Call (555) 014-2290.",
    );
    const paid = byId(LINDA, 'en');
    expect(paid.amount_due!.title).toBe("You're all paid up");
    expect(paid.patient_responsibility!.title).toBe('Your share: $100');
    expect(paid.messages!.title).toBe('All set');
  });

  it.each(CASES)('%s (%s): one note per anchor, in order', (_, lang, input) => {
    const { layout, notes } = notesFor(input, lang);
    expect(notes.map((n) => n.anchorId)).toEqual(layout.anchors.map((a) => a.id));
  });

  it.each(CASES)('%s (%s): short, and only figures from the anchor', (_, lang, input) => {
    const { layout, notes, model } = notesFor(input, lang);
    for (const note of notes) {
      const anchor = layout.anchors.find((a) => a.id === note.anchorId)!;
      const allowed = allowedNoteAmounts(anchor, model.totals.remainingCents);
      for (const amount of findDollarAmounts(`${note.title} ${note.body}`)) {
        expect(allowed, `${note.anchorId}: ${amount}`).toContain(amount);
      }
      expect(countWords(note.title)).toBeLessThanOrEqual(NOTE_TITLE_MAX_WORDS);
      expect(countWords(note.body), note.body).toBeLessThanOrEqual(NOTE_BODY_MAX_WORDS);
      expect(`${note.title} ${note.body}`).not.toMatch(/\b\d{5}\b/);
    }
  });

  it('says when a bill is past due, and points to a plan through the office', () => {
    const late: StatementInput = { ...AISHA, planOffer: null, dueDate: '2026-07-20' };
    expect(byId(late, 'en').messages).toEqual({
      anchorId: 'messages',
      title: 'Past its due date',
      body: 'This was due Jul 20. Please pay $600 soon, or call (555) 014-2290 to set up a payment plan.',
    });
    expect(byId(late, 'es').messages!.title).toBe('Ya pasó la fecha');
    expect(byId({ ...KEVIN, dueDate: '2026-11-02' }, 'en').messages!.body).toBe(
      'Please pay $275 by Nov 2. Need to pay over time? Call (555) 014-2290 to set up a payment plan.',
    );
  });

  it('keeps a long patient share under the word limit', () => {
    const input: StatementInput = {
      ...MARIA,
      contractualCents: 30000,
      insurancePaidCents: 21000,
      patientShare: {
        deductibleCents: 20000,
        coinsuranceCents: 4000,
        copayCents: 5000,
        otherCents: 5000,
        selfPayCents: 0,
      },
      remainingCents: 34000,
      aging: { ...MARIA.aging, current: 34000 },
    };
    const note = byId(input, 'en').patient_responsibility!;
    expect(countWords(note.body)).toBeLessThanOrEqual(NOTE_BODY_MAX_WORDS);
    expect(note.body).toBe(
      'Your share is $200 deductible, $40 coinsurance, $50 copay and $50 not covered by your plan. Questions? Call (555) 014-2290.',
    );
  });
});

describe('the split-visit note', () => {
  const share = (over: Partial<NonNullable<StatementInput['splitVisit']>['problemShare']>) => ({
    deductibleCents: 0,
    coinsuranceCents: 0,
    copayCents: 0,
    otherCents: 0,
    totalCents: 15000,
    ...over,
  });
  const note = (input: StatementInput, lang: TemplateNoteLang) =>
    notesFor(input, lang).notes.find((n) => n.anchorId === 'split_visit')!;

  it('explains the covered checkup and the separate visit, in English and Spanish', () => {
    expect(note(THEO, 'en')).toEqual({
      anchorId: 'split_visit',
      title: "Why your checkup wasn't free",
      body: 'Your yearly checkup was covered in full. You also talked with Dr. Patel about another concern, which is billed as a regular office visit. That $150 goes toward your deductible.',
    });
    expect(note(THEO, 'es')).toEqual({
      anchorId: 'split_visit',
      title: '¿Por qué no fue gratis?',
      body: 'Su chequeo anual fue cubierto por completo. También habló de otra preocupación con su proveedor (Dr. Patel), y esa parte se cobra como una consulta regular. Esos $150 van a su deducible.',
    });
  });

  it('names the kind of share, or just the amount when it is mixed', () => {
    const withShare = (s: ReturnType<typeof share>) => ({
      ...THEO,
      splitVisit: { ...THEO.splitVisit!, problemShare: s },
      patientShare: {
        ...THEO.patientShare,
        deductibleCents: s.deductibleCents,
        coinsuranceCents: s.coinsuranceCents,
        copayCents: s.copayCents,
      },
    });
    expect(note(withShare(share({ coinsuranceCents: 15000 })), 'en').body).toMatch(
      /Your share of that part is \$150 \(coinsurance\)\.$/,
    );
    expect(note(withShare(share({ copayCents: 15000 })), 'es').body).toMatch(
      /Esa parte tiene un copago de \$150\.$/,
    );
    expect(note(withShare(share({ deductibleCents: 10000, copayCents: 5000 })), 'en').body).toMatch(
      /Your share of that part is \$150\.$/,
    );
  });

  it('says "your provider" when no provider is on the claim', () => {
    const input = { ...THEO, visit: { ...THEO.visit, providerName: null } };
    expect(note(input, 'en').body).toContain('You also talked with your provider about');
  });

  it('never names a diagnosis or a code', () => {
    for (const lang of ['en', 'es'] as const) {
      expect(note(THEO, lang).body).not.toMatch(/\b\d{5}\b|\b(CO|PR)-?\d/);
    }
  });
});
