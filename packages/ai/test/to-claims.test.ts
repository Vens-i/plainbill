import { describe, expect, it } from 'vitest';
import { computePatientBalance } from '@plainbill/core';
import { eobToClaims, reviewSummary, withFieldValue } from '../src/eob/to-claims';
import { priyaExtraction, sure, tomasExtraction } from './fixtures';

describe('eobToClaims', () => {
  it('builds a claim that core reconciles, and flags the blurry paid amount', () => {
    const [result] = eobToClaims(priyaExtraction(), { fileName: 'aetna_eob_raman.pdf' });
    expect(result!.reconciles).toBe(true);
    expect(result!.error).toBeNull();
    expect(result!.claim).toMatchObject({
      source: { kind: 'eob', fileName: 'aetna_eob_raman.pdf' },
      patientControlNumber: 'HFM1003',
      serviceDate: '2026-10-01',
      chargeCents: 52000,
      paidCents: 26000,
      renderingProvider: { firstName: 'ANAND', lastName: 'PATEL' },
    });
    expect(computePatientBalance(result!.claim!)).toMatchObject({
      contractualCents: 10000,
      patientOwesCents: 16000,
    });

    expect(result!.flags).toEqual([
      {
        path: 'claims.0.insurance_paid',
        kind: 'money',
        label: 'Insurance paid',
        column: 'insurancePaid',
        current: { value: '260.00', display: '$260.00', reconciles: true },
        alternatives: [{ value: '280.00', display: '$280.00', reconciles: false }],
        confidence: 0.55,
        note: 'Second digit is blurred',
      },
    ]);
  });

  it('flags an uncertain adjustment code; both readings add up because only the category changes', () => {
    const [result] = eobToClaims(tomasExtraction(), { fileName: 'uhc_eob_sept.pdf' });
    expect(result!.flags).toHaveLength(1);
    expect(result!.flags[0]).toMatchObject({
      path: 'claims.0.adjustments.1.reason_code',
      kind: 'code',
      column: 'adjustments',
      current: { display: 'PR-3 → Copay', reconciles: true },
      alternatives: [
        { value: '2', display: "PR-2 → Coinsurance — patient's share", reconciles: true },
      ],
    });
    expect(computePatientBalance(result!.claim!).patientShare).toMatchObject({
      copayCents: 36800,
      coinsuranceCents: 0,
    });
  });

  it('reports figures that do not add up instead of guessing', () => {
    const e = withFieldValue(priyaExtraction(), 'claims.0.insurance_paid', '280.00');
    const [result] = eobToClaims(e, { fileName: 'x.pdf' });
    expect(result!.reconciles).toBe(false);
    expect(result!.claim).toBeNull();
    expect(result!.error).toMatch(/does not reconcile.*\$140\.00, not \$160\.00/);
    // A human set the value, so it is no longer flagged.
    expect(result!.flags).toEqual([]);
  });

  it('flags unreadable money even when the model was confident', () => {
    const e = priyaExtraction();
    e.claims[0]!.billed_total = sure('52O.00');
    const [result] = eobToClaims(e, { fileName: 'x.pdf' });
    expect(result!.flags.map((f) => [f.path, f.problem])).toContainEqual([
      'claims.0.billed_total',
      '"52O.00" is not a readable amount',
    ]);
    expect(result!.error).toMatch(/Billed total "52O.00" is not an amount/);
  });

  it('withFieldValue marks a field as human-confirmed without touching the original', () => {
    const original = priyaExtraction();
    const changed = withFieldValue(original, 'claims.0.insurance_paid', '260.00');
    expect(changed.claims[0]!.insurance_paid).toEqual({
      value: '260.00',
      confidence: 1,
      note: null,
      alternatives: [],
    });
    expect(original.claims[0]!.insurance_paid.confidence).toBe(0.55);
    expect(() => withFieldValue(original, 'claims.0.nope', '1')).toThrow(/No extracted field/);
  });
});

describe('reviewSummary', () => {
  it('describes the paid-amount question the way the dashboard shows it', () => {
    const [r] = eobToClaims(priyaExtraction(), { fileName: 'x.pdf' });
    expect(reviewSummary(r!.flags)).toEqual({
      reviewReason: 'EOB scan unclear: insurance paid $260.00 or $280.00?',
      aiSuggestion: 'Confirm insurance paid amount',
    });
  });

  it('describes the copay-vs-coinsurance question', () => {
    const [r] = eobToClaims(tomasExtraction(), { fileName: 'x.pdf' });
    expect(reviewSummary(r!.flags)).toEqual({
      reviewReason: 'Code read as PR-3 (copay), may be PR-2 (coinsurance)',
      aiSuggestion: 'Check copay vs. coinsurance',
    });
  });

  it('returns null when nothing is flagged', () => {
    expect(reviewSummary([])).toBeNull();
  });
});
