import { describe, expect, it } from 'vitest';
import { assertReconciles, computePatientBalance, ReconciliationError } from '../src/balance';
import type { NormalizedClaim } from '../src/types';
import { parse835 } from '../src/x12/parse835';
import { HAND_WRITTEN_835 } from './fixtures/remit';

/** Maria Delgado, the hero row: $850 billed − $400 contract discount − $210 paid = $240. */
function mariaClaim(overrides: Partial<NormalizedClaim> = {}): NormalizedClaim {
  return {
    source: { kind: '835', fileName: 'bcbs_era_1008.835' },
    payer: { name: 'BLUECROSS BLUESHIELD' },
    patientControlNumber: 'HFM-1001',
    claimStatusCode: '1',
    denied: false,
    patient: { firstName: 'MARIA', lastName: 'DELGADO' },
    serviceDate: '2026-10-03',
    chargeCents: 85000,
    paidCents: 21000,
    patientResponsibilityCents: 24000,
    claimAdjustments: [],
    remarks: [],
    lines: [
      line(1, '99214', 35000, 8650, [
        ['CO', '45', 16470],
        ['PR', '1', 8235],
        ['PR', '2', 1645],
      ]),
      line(2, '80053', 18000, 4447, [
        ['CO', '45', 8470],
        ['PR', '1', 4235],
        ['PR', '2', 848],
      ]),
      line(3, '93000', 32000, 7903, [
        ['CO', '45', 15060],
        ['PR', '1', 7530],
        ['PR', '2', 1507],
      ]),
    ],
    ...overrides,
  };
}

function line(
  lineNumber: number,
  procedureCode: string,
  chargeCents: number,
  paidCents: number,
  adjustments: Array<['CO' | 'PR' | 'OA' | 'PI', string, number]>,
): NormalizedClaim['lines'][number] {
  return {
    lineNumber,
    codeQualifier: 'HC',
    procedureCode,
    modifiers: [],
    chargeCents,
    paidCents,
    adjustments: adjustments.map(([group, reason, amountCents]) => ({
      group,
      reason,
      amountCents,
    })),
    remarks: [],
  };
}

describe('computePatientBalance', () => {
  it('computes the hero balance and its patient-share breakdown', () => {
    const balance = computePatientBalance(mariaClaim());
    expect(balance).toMatchObject({
      billedCents: 85000,
      contractualCents: 40000,
      insurancePaidCents: 21000,
      patientOwesCents: 24000,
      denied: false,
      patientShare: {
        deductibleCents: 20000,
        coinsuranceCents: 4000,
        copayCents: 0,
        otherCents: 0,
        selfPayCents: 0,
      },
    });
  });

  it('rolls line and claim adjustments up by code, with plain-English labels, in a stable order', () => {
    const { adjustments } = computePatientBalance(mariaClaim());
    expect(adjustments).toEqual([
      {
        code: 'CO-45',
        group: 'CO',
        reason: '45',
        amountCents: 40000,
        responsibility: 'payer',
        label: 'Insurance discount (contract rate)',
      },
      {
        code: 'PR-1',
        group: 'PR',
        reason: '1',
        amountCents: 20000,
        responsibility: 'patient',
        label: 'Deductible — patient pays',
      },
      {
        code: 'PR-2',
        group: 'PR',
        reason: '2',
        amountCents: 4000,
        responsibility: 'patient',
        label: "Coinsurance — patient's share",
      },
    ]);
  });

  it('handles every claim in the hand-written 835', () => {
    const claims = parse835(HAND_WRITTEN_835).transactions[0]!.claims;
    const [processed, denied, secondary] = claims.map(computePatientBalance);

    expect(processed).toMatchObject({
      billedCents: 22500,
      contractualCents: 9000,
      insurancePaidCents: 6200,
      patientOwesCents: 7300,
      patientShare: { deductibleCents: 5000, coinsuranceCents: 2300 },
    });
    // A denial is a full write-off under CO: the patient owes nothing.
    expect(denied).toMatchObject({
      billedCents: 180000,
      contractualCents: 180000,
      insurancePaidCents: 0,
      patientOwesCents: 0,
      denied: true,
    });
    expect(denied!.adjustments[0]).toMatchObject({
      code: 'CO-197',
      label: 'Prior authorization missing',
    });
    // OA-23 (prior payer's adjudication) is not the patient's responsibility.
    expect(secondary).toMatchObject({
      contractualCents: 16000,
      insurancePaidCents: 10000,
      patientOwesCents: 4000,
    });
  });

  it('treats a self-pay visit as fully patient-owed', () => {
    const balance = computePatientBalance({
      ...mariaClaim(),
      source: { kind: 'self-pay-csv', fileName: 'selfpay_0929.csv' },
      payer: { name: 'Self-pay' },
      claimStatusCode: 'SELF',
      chargeCents: 27500,
      paidCents: 0,
      patientResponsibilityCents: 27500,
      lines: [line(1, '99213', 27500, 0, [])],
    });
    expect(balance).toMatchObject({
      billedCents: 27500,
      contractualCents: 0,
      insurancePaidCents: 0,
      patientOwesCents: 27500,
      patientShare: { selfPayCents: 27500, deductibleCents: 0 },
    });
  });
});

describe('computePatientBalance — refuses data that does not reconcile', () => {
  const catchError = (fn: () => unknown): ReconciliationError => {
    try {
      fn();
    } catch (err) {
      if (err instanceof ReconciliationError) return err;
      throw err;
    }
    throw new Error('expected a ReconciliationError');
  };

  it('throws when patient-responsibility adjustments disagree with billed − contractual − paid', () => {
    // The design artboard's original Tomás figures: $1,180 billed, $300 discount, $812 paid,
    // $368 owed. They cannot reconcile; the seed table corrected billed to $1,480.
    const claim = mariaClaim({
      patientControlNumber: 'HFM-1004',
      chargeCents: 118000,
      paidCents: 81200,
      patientResponsibilityCents: 36800,
      lines: [],
      claimAdjustments: [
        { group: 'CO', reason: '45', amountCents: 30000 },
        { group: 'PR', reason: '3', amountCents: 36800 },
      ],
    });
    const err = catchError(() => computePatientBalance(claim));
    expect(err.message).toContain('Claim HFM-1004 does not reconcile');
    expect(err.message).toContain(
      'billed $1,180.00 − contractual $300.00 − insurance paid $812.00 = $68.00, not $368.00',
    );
    expect(err.claimId).toBe('HFM-1004');
  });

  it('throws when CLP05 (reported patient responsibility) disagrees with the PR adjustments', () => {
    const err = catchError(() =>
      computePatientBalance(mariaClaim({ patientResponsibilityCents: 28000 })),
    );
    expect(err.message).toMatch(
      /reports patient responsibility \$280\.00.*PR adjustments total \$240\.00/,
    );
  });

  it('throws when a service line does not balance', () => {
    const claim = mariaClaim();
    claim.lines[1]!.adjustments[0]!.amountCents += 100;
    claim.lines[2]!.adjustments[0]!.amountCents -= 100;
    const err = catchError(() => computePatientBalance(claim));
    expect(err.message).toMatch(
      /line 2 \(80053\).*\$180\.00 charged − \$44\.47 paid ≠ \$136\.53 adjusted/,
    );
  });

  it('throws when service lines do not add up to the claim charge', () => {
    const err = catchError(() => computePatientBalance(mariaClaim({ chargeCents: 86000 })));
    expect(err.message).toMatch(/lines add up to \$850\.00 but the claim says \$860\.00/);
  });

  it('throws when line payments do not add up to the claim payment', () => {
    const claim = mariaClaim();
    claim.lines[0]!.paidCents -= 1;
    claim.lines[0]!.adjustments[0]!.amountCents += 1;
    const err = catchError(() => computePatientBalance(claim));
    expect(err.message).toMatch(/line payments add up to \$209\.99 but the claim says \$210\.00/);
  });

  it('throws on a negative patient balance', () => {
    expect(() =>
      assertReconciles({
        billedCents: 100,
        contractualCents: 50,
        insurancePaidCents: 80,
        patientOwesCents: -30,
      }),
    ).toThrow(ReconciliationError);
  });
});

describe('assertReconciles', () => {
  it('accepts every corrected seed-table row shape', () => {
    expect(() =>
      assertReconciles({
        billedCents: 148000,
        contractualCents: 30000,
        insurancePaidCents: 81200,
        patientOwesCents: 36800,
      }),
    ).not.toThrow();
  });

  it('rejects the original (uncorrected) design figures', () => {
    // Design artboard showed Tomás at $1,180 billed with $812 paid and $368 owed, which cannot
    // reconcile with a $300 discount. The seed table corrected billed to $1,480.
    expect(() =>
      assertReconciles({
        billedCents: 118000,
        contractualCents: 30000,
        insurancePaidCents: 81200,
        patientOwesCents: 36800,
      }),
    ).toThrow(
      /billed \$1,180\.00 − contractual \$300\.00 − insurance paid \$812\.00 = \$68\.00, not \$368\.00/,
    );
  });
});
