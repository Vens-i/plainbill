/**
 * Statement inputs for the seed patients (fictional), matching seed/src/spec.ts. Amounts are
 * integer cents.
 */
import { statementAging } from '../../src/aging';
import type { PatientShare } from '../../src/balance';
import type { StatementInput } from '../../src/statement/model';

const PRACTICE: StatementInput['practice'] = {
  name: 'Harborview Family Medicine',
  addressLine1: '220 Harbor St',
  addressLine2: 'Suite 4',
  city: 'Harborview',
  state: 'CA',
  zip: '94000',
  phone: '(555) 014-2290',
  hours: 'Mon–Fri 8–5',
  payUrlHost: 'pay.harborviewfm.example',
};

const share = (s: Partial<PatientShare> = {}): PatientShare => ({
  deductibleCents: 0,
  coinsuranceCents: 0,
  copayCents: 0,
  otherCents: 0,
  selfPayCents: 0,
  ...s,
});

function base(
  over: Partial<StatementInput> & Pick<StatementInput, 'lines' | 'remainingCents'>,
): StatementInput {
  return {
    practice: PRACTICE,
    patient: { firstName: 'Maria', lastName: 'Delgado', addressLines: [] },
    accountNumber: '000001',
    statementId: 'S0000001',
    statementDate: '2026-10-10',
    dueDate: '2026-11-09',
    payUrl: 'https://pay.harborviewfm.example/pay/abc',
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
    contractualCents: 0,
    contractualCode: 'CO45',
    insurancePaidCents: 0,
    patientShare: share(),
    payments: [],
    aging: statementAging(over.remainingCents, 7),
    planOffer: null,
    planActive: null,
    ...over,
  };
}

/** The hero: $850 − $400 − $210 = $240 (deductible $200 + coinsurance $40), 3-month plan offered. */
export const MARIA = base({
  patient: {
    firstName: 'Maria',
    lastName: 'Delgado',
    addressLines: ['418 Seacliff Ave Apt 2B', 'Harborview CA 94000'],
  },
  accountNumber: '000001',
  statementId: 'S0000014',
  lines: [
    { code: '99214', chargeCents: 35000 },
    { code: '80053', chargeCents: 18000 },
    { code: '93000', chargeCents: 32000 },
  ],
  contractualCents: 40000,
  insurancePaidCents: 21000,
  patientShare: share({ deductibleCents: 20000, coinsuranceCents: 4000 }),
  remainingCents: 24000,
  planOffer: { months: 3, firstCents: 8000, regularCents: 8000 },
});

/** Copay only: $450 − $70 − $300 = $80 copay. */
export const SAMUEL = base({
  patient: {
    firstName: 'Samuel',
    lastName: 'Ortiz',
    addressLines: ['9 Pier Rd', 'Harborview CA 94000'],
  },
  visit: { ...MARIA.visit, date: '2026-09-22', providerName: 'Dr. Okoye' },
  lines: [
    { code: '99213', chargeCents: 28000 },
    { code: '85025', chargeCents: 9000 },
    { code: '36415', chargeCents: 3000 },
    { code: '87880', chargeCents: 5000 },
  ],
  contractualCents: 7000,
  insurancePaidCents: 30000,
  patientShare: share({ copayCents: 8000 }),
  remainingCents: 8000,
  aging: statementAging(8000, 18),
});

const SELF_PAY_VISIT = {
  providerName: 'Dr. Kim',
  payerName: 'Self-pay',
  payerShortName: 'Self-pay',
  selfPay: true,
  claimFiledDate: null,
  paymentDate: null,
  traceNumber: null,
};

/** Self-pay, two $300 payments, $600 left, 112 days out. */
export const AISHA = base({
  patient: {
    firstName: 'Aisha',
    lastName: 'Bello',
    addressLines: ['77 Linden Ct', 'Harborview CA 94000'],
  },
  visit: { ...SELF_PAY_VISIT, date: '2026-06-20' },
  lines: [
    { code: '99204', chargeCents: 42000 },
    { code: '20610', chargeCents: 38000 },
    { code: '73562', chargeCents: 40000 },
  ],
  insurancePaidCents: null,
  patientShare: share({ selfPayCents: 120000 }),
  payments: [
    { date: '2026-07-15', amountCents: 30000 },
    { date: '2026-10-02', amountCents: 30000 },
  ],
  remainingCents: 60000,
  aging: statementAging(60000, 112),
  planOffer: { months: 6, firstCents: 10000, regularCents: 10000 },
});

/** Self-pay at the self-pay rate already, no discount line. */
export const KEVIN = base({
  patient: {
    firstName: 'Kevin',
    lastName: 'Lam',
    addressLines: ['31 Gull St', 'Harborview CA 94000'],
  },
  visit: { ...SELF_PAY_VISIT, date: '2026-09-29' },
  lines: [
    { code: '99213', chargeCents: 17500 },
    { code: '87880', chargeCents: 10000 },
  ],
  insurancePaidCents: null,
  patientShare: share({ selfPayCents: 27500 }),
  remainingCents: 27500,
  aging: statementAging(27500, 11),
});

/** Self-pay with a $60 self-pay discount (hypothetical; no seed patient has one). */
export const SELF_PAY_DISCOUNT = base({
  patient: { firstName: 'Ellen', lastName: 'Brooks', addressLines: [] },
  visit: { ...SELF_PAY_VISIT, providerName: 'Dr. Patel', date: '2026-09-30' },
  lines: [{ code: '99214', chargeCents: 31000 }],
  contractualCents: 6000,
  insurancePaidCents: null,
  patientShare: share({ selfPayCents: 25000 }),
  remainingCents: 25000,
});

/** Paid in full: $560 − $50 − $410 = $100 coinsurance, paid Sep 16. */
export const LINDA = base({
  patient: { firstName: 'Linda', lastName: 'Park', addressLines: [] },
  visit: {
    ...MARIA.visit,
    date: '2026-09-10',
    payerName: 'Aetna',
    payerShortName: 'Aetna',
    paymentDate: '2026-09-14',
    traceNumber: 'AE0914553872',
  },
  lines: [
    { code: '99213', chargeCents: 26000 },
    { code: '80053', chargeCents: 21000 },
    { code: '85025', chargeCents: 9000 },
  ],
  contractualCents: 5000,
  insurancePaidCents: 41000,
  patientShare: share({ coinsuranceCents: 10000 }),
  payments: [{ date: '2026-09-16', amountCents: 10000 }],
  remainingCents: 0,
  aging: statementAging(0, 30),
});

/** Maria on a 3-month plan with the first $80 paid. */
export const MARIA_ON_PLAN = {
  ...MARIA,
  payments: [{ date: '2026-10-10', amountCents: 8000 }],
  remainingCents: 16000,
  aging: statementAging(16000, 7),
  planOffer: null,
  planActive: { months: 3, paidCount: 1, nextDate: '2026-11-10', nextCents: 8000 },
} satisfies StatementInput;

/**
 * The split visit: checkup $380 (paid in full), problem visit 99213-25 $220 (deductible $150),
 * cholesterol panel $150. $750 − $210 − $390 = $150.
 */
export const THEO = base({
  patient: {
    firstName: 'Theo',
    lastName: 'Lambert',
    addressLines: ['31 Seawall Ave', 'Harborview CA 94000'],
  },
  accountNumber: '000014',
  statementId: 'S0000021',
  visit: {
    date: '2026-09-16',
    providerName: 'Dr. Patel',
    payerName: 'BlueCross BlueShield',
    payerShortName: 'BlueCross',
    selfPay: false,
    claimFiledDate: null,
    paymentDate: '2026-09-30',
    traceNumber: 'BC0930118842',
  },
  lines: [
    { code: '99396', chargeCents: 38000 },
    { code: '99213', chargeCents: 22000 },
    { code: '80061', chargeCents: 15000 },
  ],
  contractualCents: 21000,
  insurancePaidCents: 39000,
  patientShare: share({ deductibleCents: 15000 }),
  remainingCents: 15000,
  aging: statementAging(15000, 24),
  splitVisit: {
    preventiveLineIndex: 0,
    problemLineIndex: 1,
    problemShare: {
      deductibleCents: 15000,
      coinsuranceCents: 0,
      copayCents: 0,
      otherCents: 0,
      totalCents: 15000,
    },
  },
});
