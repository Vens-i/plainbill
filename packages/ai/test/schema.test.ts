import { describe, expect, it } from 'vitest';
import { CLEAN_READ_CONFIDENCE, toExtraction, type EobModelOutput } from '../src/eob/schema';
import { eobToClaims, parseMoneyText } from '../src/eob/to-claims';

function output(
  overrides: Partial<EobModelOutput['claims'][number]> = {},
  uncertain: EobModelOutput['uncertain_fields'] = [],
): EobModelOutput {
  return {
    document_kind: 'eob',
    payer_name: 'UNITEDHEALTHCARE',
    claims: [
      {
        patient_first_name: 'TOMAS',
        patient_last_name: 'HERRERA',
        patient_account_number: 'HFM1004',
        member_id: '921447803',
        payer_claim_number: 'UH0921A55120',
        provider_name: 'HELEN KIM',
        service_date: '2026-09-12',
        claim_status: 'processed',
        services: [{ procedure_code: '99215', billed: '1,480.00' }],
        billed_total: '1,480.00',
        adjustments: [
          {
            group_code: 'CO',
            reason_code: '45',
            amount: '-300.00',
            printed_label: 'Contractual adjustment',
          },
          {
            group_code: 'PR',
            reason_code: '',
            amount: '368.00',
            printed_label: 'Member responsibility',
          },
        ],
        insurance_paid: '812.00',
        patient_responsibility_total: '368.00',
        remark_codes: [],
        ...overrides,
      },
    ],
    uncertain_fields: uncertain,
  };
}

describe('toExtraction', () => {
  it('gives unlisted fields clean-read confidence and applies the uncertainty list', () => {
    const e = toExtraction(
      output({}, [
        {
          path: 'claims.0.adjustments.1.reason_code',
          confidence: 0.3,
          note: 'smudged',
          alternatives: ['3', '2', '1'],
        },
      ]),
    );
    expect(e.claims[0]!.insurance_paid.confidence).toBe(CLEAN_READ_CONFIDENCE);
    // Unreadable with candidates: the most likely candidate becomes the provisional value.
    expect(e.claims[0]!.adjustments[1]!.reason_code).toEqual({
      value: '3',
      confidence: 0.3,
      note: 'smudged',
      alternatives: ['2', '1'],
    });
  });

  it('ignores uncertainty entries for paths that do not exist and invalid enum alternatives', () => {
    const e = toExtraction(
      output(
        {
          adjustments: [
            { group_code: 'PR', reason_code: '3', amount: '368.00', printed_label: '' },
          ],
        },
        [
          { path: 'claims.0.nope', confidence: 0.1, note: 'x', alternatives: [] },
          {
            path: 'claims.0.adjustments.0.group_code',
            confidence: 0.5,
            note: 'faint',
            alternatives: ['CO', 'ZZ'],
          },
        ],
      ),
    );
    expect(e.claims[0]!.adjustments[0]!.group_code.alternatives).toEqual(['CO']);
  });

  it('feeds a claim that reconciles once printed formatting is stripped', () => {
    const e = toExtraction(
      output({}, [
        {
          path: 'claims.0.adjustments.1.reason_code',
          confidence: 0.3,
          note: 'smudged',
          alternatives: ['3', '2'],
        },
      ]),
    );
    const [r] = eobToClaims(e, { fileName: 'uhc_eob_sept.pdf' });
    expect(r!.reconciles).toBe(true);
    expect(r!.claim).toMatchObject({ chargeCents: 148000, renderingProvider: { lastName: 'KIM' } });
    expect(
      r!.flags.map((f) => [f.path, f.current.display, f.alternatives.map((a) => a.display)]),
    ).toEqual([
      [
        'claims.0.adjustments.1.reason_code',
        'PR-3 → Copay',
        ["PR-2 → Coinsurance — patient's share"],
      ],
    ]);
  });
});

describe('parseMoneyText', () => {
  it.each([
    ['1,480.00', 148000],
    ['$260.00', 26000],
    ['-100.00', -10000],
    ['(100.00)', -10000],
    [' 90 ', 9000],
  ])('%s → %i', (input, cents) => {
    expect(parseMoneyText(input)).toBe(cents);
  });

  it('still rejects things that are not amounts', () => {
    expect(() => parseMoneyText('26O.00')).toThrow();
  });
});
