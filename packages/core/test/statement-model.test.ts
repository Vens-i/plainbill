import { describe, expect, it } from 'vitest';
import { statementAging, statementAgingKey, STATEMENT_AGING } from '../src/aging';
import { ReconciliationError } from '../src/balance';
import {
  buildStatementModel,
  statementAmount,
  statementDate,
  type StatementInput,
} from '../src/statement/model';
import {
  AISHA,
  KEVIN,
  LINDA,
  MARIA,
  MARIA_ON_PLAN,
  SAMUEL,
  SELF_PAY_DISCOUNT,
} from './fixtures/statements';

const ALL: Array<[string, StatementInput]> = [
  ['Maria', MARIA],
  ['Samuel', SAMUEL],
  ['Aisha', AISHA],
  ['Kevin', KEVIN],
  ['Linda', LINDA],
  ['self-pay discount', SELF_PAY_DISCOUNT],
  ['Maria on a plan', MARIA_ON_PLAN],
];

describe('statement aging', () => {
  it.each([
    [0, 'current'],
    [30, 'current'],
    [31, '31-60'],
    [90, '61-90'],
    [91, '91-120'],
    [112, '91-120'],
    [120, '91-120'],
    [121, '120+'],
  ])('%i days → %s', (days, key) => {
    expect(statementAgingKey(days)).toBe(key);
  });

  it('puts the whole open balance in one box', () => {
    expect(statementAging(60000, 112)).toEqual({
      current: 0,
      '31-60': 0,
      '61-90': 0,
      '91-120': 60000,
      '120+': 0,
    });
    expect(STATEMENT_AGING.map((b) => b.label)).toEqual([
      'CURRENT',
      '31–60 DAYS',
      '61–90 DAYS',
      '91–120 DAYS',
      'OVER 120 DAYS',
    ]);
  });
});

describe('statement formatting', () => {
  it('prints dates and amounts like the paper statement', () => {
    expect(statementDate('2026-10-03')).toBe('10/03/26');
    expect(statementDate('2026-10-10', true)).toBe('10/10/2026');
    expect(statementAmount(35000)).toBe('350.00');
    expect(statementAmount(120000)).toBe('1,200.00');
    expect(statementAmount(-21000)).toBe('-210.00');
  });
});

describe('buildStatementModel', () => {
  it("lays out Maria's activity like the sample statement", () => {
    const model = buildStatementModel(MARIA);
    expect(
      model.rows.map((r) => [
        statementDate(r.date),
        r.patient,
        r.code,
        r.description,
        r.chargeCents,
        r.creditCents,
        r.balanceCents,
        r.anchor,
      ]),
    ).toEqual([
      [
        '10/03/26',
        'MARIA',
        '99214',
        'OFFICE VISIT, ESTABLISHED PATIENT (30–39 MIN)',
        35000,
        null,
        35000,
        'charges',
      ],
      ['10/03/26', 'MARIA', '80053', 'BLOOD WORK — METABOLIC PANEL', 18000, null, 53000, 'charges'],
      ['10/03/26', 'MARIA', '93000', 'HEART RHYTHM TEST (ECG)', 32000, null, 85000, 'charges'],
      ['10/03/26', 'MARIA', '', 'CLAIM FILED TO BLUECROSS BLUESHIELD', null, null, null, null],
      [
        '10/08/26',
        'MARIA',
        'INSPMT',
        'INS PMT BLUECROSS EFT BC1008120117',
        null,
        21000,
        64000,
        'insurance_payment',
      ],
      ['10/08/26', 'MARIA', 'CO45', 'CONTRACTUAL ADJ - BLUECROSS', null, 40000, 24000, 'discount'],
      [
        '10/08/26',
        'MARIA',
        'PR1 PR2',
        'PT RESP: DED 200.00 COINS 40.00',
        null,
        null,
        24000,
        'patient_responsibility',
      ],
    ]);
    expect(model.totals).toEqual({
      billedCents: 85000,
      contractualCents: 40000,
      insurancePaidCents: 21000,
      patientShareCents: 24000,
      patientPaidCents: 0,
      remainingCents: 24000,
    });
  });

  it.each(ALL)('%s: the running balance ends on what is owed', (_, input) => {
    const model = buildStatementModel(input);
    const last = model.rows.filter((r) => r.balanceCents !== null).at(-1)!;
    expect(last.balanceCents).toBe(input.remainingCents);
    const t = model.totals;
    expect(t.billedCents - t.contractualCents - t.insurancePaidCents - t.patientPaidCents).toBe(
      t.remainingCents,
    );
  });

  it.each(ALL)('%s: every credit is a figure from the input', (_, input) => {
    const allowed = new Set([
      input.contractualCents,
      input.insurancePaidCents,
      ...input.payments.map((p) => p.amountCents),
    ]);
    for (const row of buildStatementModel(input).rows) {
      if (row.creditCents !== null) expect(allowed).toContain(row.creditCents);
      if (row.chargeCents !== null)
        expect(input.lines.map((l) => l.chargeCents)).toContain(row.chargeCents);
    }
  });

  it('shows a copay as PR3', () => {
    const rows = buildStatementModel(SAMUEL).rows;
    const resp = rows.find((r) => r.anchor === 'patient_responsibility')!;
    expect([resp.code, resp.description]).toEqual(['PR3', 'PT RESP: COPAY 80.00']);
  });

  it('has no insurance rows for self-pay, and one row per patient payment', () => {
    const rows = buildStatementModel(AISHA).rows;
    expect(rows.some((r) => r.anchor === 'insurance_payment')).toBe(false);
    expect(rows.some((r) => r.id === 'claim-filed')).toBe(false);
    expect(rows.some((r) => r.anchor === 'discount')).toBe(false);
    expect(
      rows
        .filter((r) => r.anchor === 'patient_payment')
        .map((r) => [r.id, statementDate(r.date), r.description, r.creditCents, r.balanceCents]),
    ).toEqual([
      ['payment-1', '07/15/26', 'PATIENT PAYMENT - THANK YOU', 30000, 90000],
      ['payment-2', '10/02/26', 'PATIENT PAYMENT - THANK YOU', 30000, 60000],
    ]);
  });

  it('shows the self-pay discount only when there is one', () => {
    expect(buildStatementModel(KEVIN).rows.map((r) => r.anchor)).toEqual(['charges', 'charges']);
    const discount = buildStatementModel(SELF_PAY_DISCOUNT).rows.find(
      (r) => r.anchor === 'discount',
    )!;
    expect([discount.code, discount.description, discount.creditCents]).toEqual([
      'SELF',
      'SELF-PAY RATE',
      6000,
    ]);
  });

  it('has no insurance payment row when insurance paid nothing', () => {
    const input: StatementInput = {
      ...MARIA,
      contractualCents: 61000,
      insurancePaidCents: 0,
      remainingCents: 24000,
    };
    const rows = buildStatementModel(input).rows;
    expect(rows.some((r) => r.anchor === 'insurance_payment')).toBe(false);
    expect(rows.some((r) => r.id === 'claim-filed')).toBe(true);
  });

  it('refuses inputs that do not reconcile', () => {
    expect(() => buildStatementModel({ ...MARIA, remainingCents: 25000 })).toThrow(
      ReconciliationError,
    );
    expect(() => buildStatementModel({ ...MARIA, insurancePaidCents: 21000.5 })).toThrow(TypeError);
  });

  it('says PAST DUE on a statement dated after its due date', () => {
    const late = { ...AISHA, dueDate: '2026-07-20' };
    expect(buildStatementModel(late).message).toContain(
      'THE REMAINING BALANCE OF $600.00 WAS DUE ON 07/20/2026 AND IS NOW PAST DUE.',
    );
    expect(buildStatementModel({ ...LINDA, dueDate: '2026-09-01' }).message).not.toContain(
      'PAST DUE',
    );
  });

  it('writes the MESSAGES box for each situation', () => {
    expect(buildStatementModel(MARIA).message).toBe(
      'YOUR INSURANCE HAS PROCESSED THIS CLAIM. THE REMAINING BALANCE IS YOUR RESPONSIBILITY AND IS DUE BY 11/09/2026. ' +
        'YOU CAN ALSO PAY IN 3 MONTHLY PAYMENTS OF $80.00 WITH NO INTEREST OR FEES. ' +
        'IF YOU HAVE QUESTIONS ABOUT YOUR BALANCE OR WISH TO MAKE PAYMENT ARRANGEMENTS, PLEASE CALL OUR BILLING OFFICE. ' +
        'THANK YOU FOR CHOOSING HARBORVIEW FAMILY MEDICINE.',
    );
    expect(buildStatementModel(AISHA).message).toMatch(
      /^THIS VISIT WAS BILLED AT OUR SELF-PAY RATE\. THANK YOU FOR YOUR PAYMENTS\. THE REMAINING BALANCE OF \$600\.00 IS DUE BY/,
    );
    expect(buildStatementModel(MARIA_ON_PLAN).message).toContain(
      'YOU ARE ON A 3-MONTH PAYMENT PLAN: 1 OF 3 PAID. NEXT PAYMENT $80.00 ON 11/10/2026.',
    );
    expect(buildStatementModel(LINDA).message).toBe(
      'YOUR ACCOUNT IS PAID IN FULL. THANK YOU FOR YOUR PAYMENT AND FOR CHOOSING HARBORVIEW FAMILY MEDICINE.',
    );
  });
});
