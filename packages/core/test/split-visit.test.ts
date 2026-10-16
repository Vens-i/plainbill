import { describe, expect, it } from 'vitest';
import { computePatientBalance } from '../src/balance';
import { detectSplitVisit, isPreventiveVisitCode, isProblemVisitCode } from '../src/split-visit';
import type { GroupCode, NormalizedClaim, ServiceLine } from '../src/types';
import { parse835 } from '../src/x12/parse835';
import { HAND_WRITTEN_835 } from './fixtures/remit';

type Adj = [GroupCode, string, number];

function line(
  n: number,
  code: string,
  charge: number,
  paid: number,
  adjs: Adj[],
  modifiers: string[] = [],
): ServiceLine {
  return {
    lineNumber: n,
    codeQualifier: 'HC',
    procedureCode: code,
    modifiers,
    chargeCents: charge,
    paidCents: paid,
    adjustments: adjs.map(([group, reason, amountCents]) => ({ group, reason, amountCents })),
    remarks: [],
  };
}

/** Checkup paid in full + cholesterol panel paid + a problem visit (-25) to the deductible. */
function splitClaim(overrides: Partial<NormalizedClaim> = {}): NormalizedClaim {
  return {
    source: { kind: '835', fileName: 'bcbs_era_0930.835' },
    payer: { name: 'BLUECROSS BLUESHIELD' },
    patientControlNumber: 'HFM1014',
    claimStatusCode: '1',
    denied: false,
    patient: { firstName: 'THEO', lastName: 'LAMBERT' },
    serviceDate: '2026-09-16',
    chargeCents: 75000,
    paidCents: 39000,
    patientResponsibilityCents: 15000,
    claimAdjustments: [],
    remarks: [],
    lines: [
      line(1, '99396', 38000, 28000, [['CO', '45', 10000]]),
      line(
        2,
        '99213',
        22000,
        0,
        [
          ['CO', '45', 7000],
          ['PR', '1', 15000],
        ],
        ['25'],
      ),
      line(3, '80061', 15000, 11000, [['CO', '45', 4000]]),
    ],
    ...overrides,
  };
}

describe('visit code ranges', () => {
  it('knows preventive and problem-oriented E/M codes', () => {
    expect(['99381', '99387', '99391', '99396', '99397'].every(isPreventiveVisitCode)).toBe(true);
    expect(['99380', '99388', '99390', '99398', '99213', '9939'].some(isPreventiveVisitCode)).toBe(
      false,
    );
    expect(['99202', '99205', '99211', '99213', '99215'].every(isProblemVisitCode)).toBe(true);
    expect(['99201', '99206', '99210', '99216', '99396'].some(isProblemVisitCode)).toBe(false);
  });
});

describe('detectSplitVisit', () => {
  it('finds a covered checkup plus a problem visit billed to the deductible', () => {
    const claim = splitClaim();
    // The claim itself still satisfies the invariant: 750 − 210 − 390 = 150.
    expect(computePatientBalance(claim).patientOwesCents).toBe(15000);
    expect(detectSplitVisit(claim)).toEqual({
      preventive: { lineNumber: 1, code: '99396', chargeCents: 38000, paidCents: 28000 },
      problem: {
        lineNumber: 2,
        code: '99213',
        chargeCents: 22000,
        paidCents: 0,
        patientShare: {
          deductibleCents: 15000,
          coinsuranceCents: 0,
          copayCents: 0,
          otherCents: 0,
          totalCents: 15000,
        },
      },
    });
  });

  it('splits a mixed patient share by type', () => {
    const claim = splitClaim({
      paidCents: 43000,
      patientResponsibilityCents: 11000,
      lines: [
        line(1, '99396', 38000, 28000, [['CO', '45', 10000]]),
        line(
          2,
          '99214',
          22000,
          4000,
          [
            ['CO', '45', 7000],
            ['PR', '1', 8000],
            ['PR', '3', 3000],
          ],
          ['25'],
        ),
        line(3, '80061', 15000, 11000, [['CO', '45', 4000]]),
      ],
    });
    expect(detectSplitVisit(claim)!.problem.patientShare).toEqual({
      deductibleCents: 8000,
      coinsuranceCents: 0,
      copayCents: 3000,
      otherCents: 0,
      totalCents: 11000,
    });
  });

  it('needs modifier 25 on the problem visit', () => {
    const claim = splitClaim();
    claim.lines[1]!.modifiers = [];
    expect(detectSplitVisit(claim)).toBeNull();
  });

  it('stays quiet when the checkup itself has a patient share', () => {
    const claim = splitClaim({
      paidCents: 34000,
      patientResponsibilityCents: 20000,
      lines: [
        line(1, '99396', 38000, 23000, [
          ['CO', '45', 10000],
          ['PR', '1', 5000],
        ]),
        line(
          2,
          '99213',
          22000,
          0,
          [
            ['CO', '45', 7000],
            ['PR', '1', 15000],
          ],
          ['25'],
        ),
        line(3, '80061', 15000, 11000, [['CO', '45', 4000]]),
      ],
    });
    expect(detectSplitVisit(claim)).toBeNull();
  });

  it('stays quiet when the problem visit costs the patient nothing', () => {
    const claim = splitClaim({
      paidCents: 54000,
      patientResponsibilityCents: 0,
      lines: [
        line(1, '99396', 38000, 28000, [['CO', '45', 10000]]),
        line(2, '99213', 22000, 15000, [['CO', '45', 7000]], ['25']),
        line(3, '80061', 15000, 11000, [['CO', '45', 4000]]),
      ],
    });
    expect(detectSplitVisit(claim)).toBeNull();
  });

  it('stays quiet when it is ambiguous: two problem visits', () => {
    const claim = splitClaim({
      chargeCents: 97000,
      patientResponsibilityCents: 30000,
      lines: [
        ...splitClaim().lines,
        line(
          4,
          '99212',
          22000,
          0,
          [
            ['CO', '45', 7000],
            ['PR', '1', 15000],
          ],
          ['25'],
        ),
      ],
    });
    expect(detectSplitVisit(claim)).toBeNull();
  });

  it('stays quiet when a second problem visit has no modifier 25 (still ambiguous)', () => {
    const claim = splitClaim({
      chargeCents: 97000,
      patientResponsibilityCents: 30000,
      lines: [
        ...splitClaim().lines,
        line(4, '99212', 22000, 0, [
          ['CO', '45', 7000],
          ['PR', '1', 15000],
        ]),
      ],
    });
    expect(detectSplitVisit(claim)).toBeNull();
  });

  it('ignores self-pay, EOB and denied claims', () => {
    expect(detectSplitVisit(splitClaim({ source: { kind: 'self-pay-csv' } }))).toBeNull();
    expect(detectSplitVisit(splitClaim({ source: { kind: 'eob' } }))).toBeNull();
    expect(detectSplitVisit(splitClaim({ denied: true, claimStatusCode: '4' }))).toBeNull();
  });

  it('is not fooled by a checkup alone', () => {
    const claim = splitClaim({
      chargeCents: 53000,
      patientResponsibilityCents: 0,
      lines: [splitClaim().lines[0]!, splitClaim().lines[2]!],
    });
    expect(detectSplitVisit(claim)).toBeNull();
  });

  it('reads modifier 25 straight from an 835 SVC composite', () => {
    const remit = HAND_WRITTEN_835.replace('SVC*HC:99213*200*50**1~', 'SVC*HC:99213:25*200*50**1~');
    const [claim] = parse835(remit).transactions[0]!.claims;
    expect(claim!.lines[0]!.modifiers).toEqual(['25']);
  });
});
