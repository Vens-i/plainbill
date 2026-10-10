/**
 * The seed table (13 fictional visits), copied verbatim as data (dollars; null = "–" in the table).
 * Deliberately independent of spec.ts: the reconciliation test parses the generated files and
 * checks the results against these literals, so a typo in either place fails the build.
 */
export interface ExpectedRow {
  patient: string;
  payer: 'BCBS' | 'Aetna' | 'UHC' | 'Self-pay';
  visit: string;
  billed: number;
  discount: number | null;
  insurancePaid: number | null;
  owes: number | null;
  /** "600 left" for the partially paid row. */
  remaining?: number;
  status: 'ready' | 'review' | 'denied' | 'sent' | 'partial' | 'paid';
}

export const EXPECTED_TABLE: ExpectedRow[] = [
  {
    patient: 'Maria Delgado',
    payer: 'BCBS',
    visit: '10/3/26',
    billed: 850,
    discount: 400,
    insurancePaid: 210,
    owes: 240,
    status: 'ready',
  },
  {
    patient: 'Kevin Lam',
    payer: 'Self-pay',
    visit: '9/29/26',
    billed: 275,
    discount: null,
    insurancePaid: null,
    owes: 275,
    status: 'ready',
  },
  {
    patient: 'Priya Raman',
    payer: 'Aetna',
    visit: '10/1/26',
    billed: 520,
    discount: 100,
    insurancePaid: 260,
    owes: 160,
    status: 'review',
  },
  {
    patient: 'Tomás Herrera',
    payer: 'UHC',
    visit: '9/12/26',
    billed: 1480,
    discount: 300,
    insurancePaid: 812,
    owes: 368,
    status: 'review',
  },
  {
    patient: 'Ellen Brooks',
    payer: 'Self-pay',
    visit: '9/30/26',
    billed: 310,
    discount: null,
    insurancePaid: null,
    owes: 310,
    status: 'review',
  },
  {
    patient: 'Marcus Reid',
    payer: 'Aetna',
    visit: '8/25/26',
    billed: 900,
    discount: 140,
    insurancePaid: 520,
    owes: 240,
    status: 'review',
  },
  {
    patient: 'James Whitfield',
    payer: 'BCBS',
    visit: '9/18/26',
    billed: 2400,
    discount: null,
    insurancePaid: 0,
    owes: null,
    status: 'denied',
  },
  {
    patient: 'Denise Okafor',
    payer: 'UHC',
    visit: '8/14/26',
    billed: 610,
    discount: null,
    insurancePaid: 0,
    owes: null,
    status: 'denied',
  },
  {
    patient: 'Grace Whitaker',
    payer: 'Aetna',
    visit: '8/2/26',
    billed: 1040,
    discount: 100,
    insurancePaid: 690,
    owes: 250,
    status: 'sent',
  },
  {
    patient: 'Robert Chen',
    payer: 'UHC',
    visit: '9/5/26',
    billed: 600,
    discount: 70,
    insurancePaid: 380,
    owes: 150,
    status: 'sent',
  },
  {
    patient: 'Aisha Bello',
    payer: 'Self-pay',
    visit: '6/20/26',
    billed: 1200,
    discount: null,
    insurancePaid: null,
    owes: 1200,
    remaining: 600,
    status: 'partial',
  },
  {
    patient: 'Samuel Ortiz',
    payer: 'BCBS',
    visit: '9/22/26',
    billed: 450,
    discount: 70,
    insurancePaid: 300,
    owes: 80,
    status: 'paid',
  },
  {
    patient: 'Linda Park',
    payer: 'Aetna',
    visit: '9/10/26',
    billed: 560,
    discount: 50,
    insurancePaid: 410,
    owes: 100,
    status: 'paid',
  },
];
