/**
 * The seed world: Harborview Family Medicine on "today" = Oct 10, 2026. Every patient, payer
 * claim number, NPI and member ID here is fictional.
 *
 * Each visit lists its service lines and how the payer adjudicated it. `generate.ts` turns the
 * insurance visits into 835 files or scanned EOB PDFs and the self-pay visits into CSVs; `seed.ts`
 * then reads those files back through the real parsers (and, for EOBs, recorded Claude
 * extractions). Visits are listed in the order of the seed table
 * (expected.ts), which is also the order rows appear within each dashboard group.
 */
import type { BalanceStatus, GroupCode, IsoDate } from '@plainbill/core';

export const SEED_TODAY: IsoDate = '2026-10-10';

export const PRACTICE = {
  name: 'Harborview Family Medicine',
  addressLine1: '220 Harbor St',
  addressLine2: 'Suite 4',
  city: 'Harborview',
  state: 'CA',
  zip: '94000',
  phone: '(555) 014-2290',
  hours: 'Mon–Fri 8–5',
  npi: '1999999984',
  taxId: '999999999',
  /** Days-to-pay on paper statements before Plainbill (the KPI's comparison line). */
  paperBaselineDays: 34,
  user: { name: 'Rosa M.', firstName: 'Rosa', initials: 'RM' },
} as const;

export const PROVIDERS = {
  patel: { firstName: 'Anand', lastName: 'Patel', npi: '1999999992' },
  kim: { firstName: 'Helen', lastName: 'Kim', npi: '1999999976' },
  okoye: { firstName: 'Chidi', lastName: 'Okoye', npi: '1999999968' },
} as const;

export type ProviderKey = keyof typeof PROVIDERS;

export const PAYERS = {
  BCBS: { name: 'BLUECROSS BLUESHIELD', id: 'BCBS01', ein: '1999000001', isaId: 'BCBSCLEARING' },
  AETNA: { name: 'AETNA', id: 'AETNA60054', ein: '1999000002', isaId: 'AETNAERA' },
  UHC: { name: 'UNITEDHEALTHCARE', id: 'UHC87726', ein: '1999000003', isaId: 'UHCERA' },
} as const;

export type PayerKey = keyof typeof PAYERS;

export interface SeedAdjustment {
  group: GroupCode;
  reason: string;
  /** Whole or two-decimal dollars. */
  amount: number;
}

export interface SeedVisit {
  key: string;
  /** CLP01 / CSV visit_id — the practice's own claim number. */
  claimId: string;
  patient: { firstName: string; lastName: string; dob: IsoDate; memberId?: string; email: string };
  provider: ProviderKey;
  visitDate: IsoDate;
  lines: Array<{ cpt: string; charge: number }>;
  /** Insurance adjudication; absent for self-pay. */
  insurance?: {
    payer: PayerKey;
    /** The ERA (835) file this claim arrives in… */
    era?: string;
    /** …or the scanned EOB PDF, with the part of the scan that is hard to read. */
    eob?: { file: string; obscure: 'insurance_paid' | 'patient_share_code' };
    payerClaimNumber: string;
    denied?: boolean;
    paid: number;
    adjustments: SeedAdjustment[];
    remarks?: string[];
  };
  selfPay?: { rateApplied: boolean; csv: string };
  /** Where the row sits on the dashboard today. */
  status: BalanceStatus;
  reviewReason?: string;
  /** Static "AI suggests" text; for EOB visits it is derived from the extraction flags instead. */
  aiSuggestion: string | null;
  invoice?: { sentOn: IsoDate; openCount: number };
  payments?: Array<{ on: IsoDate; amount: number; method: 'paypal' | 'card' | 'cash' }>;
}

/** One 835 per payer payment (ERA), like a clearinghouse delivers them. */
export const ERAS: Record<
  string,
  { payer: PayerKey; date: IsoDate; controlNumber: number; trace: string }
> = {
  bcbs_era_0930: { payer: 'BCBS', date: '2026-09-30', controlNumber: 930, trace: 'BC0930118842' },
  bcbs_era_1008: { payer: 'BCBS', date: '2026-10-08', controlNumber: 1008, trace: 'BC1008120117' },
  aetna_era_0812: { payer: 'AETNA', date: '2026-08-12', controlNumber: 812, trace: 'AE0812553201' },
  aetna_era_0914: { payer: 'AETNA', date: '2026-09-14', controlNumber: 914, trace: 'AE0914553872' },
  uhc_era_0826: { payer: 'UHC', date: '2026-08-26', controlNumber: 826, trace: 'UH0826907714' },
  uhc_era_0921: { payer: 'UHC', date: '2026-09-21', controlNumber: 921, trace: 'UH0921908305' },
};

/** Scanned EOB PDFs (paper remittances), one claim each. */
export const EOBS: Record<string, { payer: PayerKey; date: IsoDate }> = {
  aetna_eob_raman: { payer: 'AETNA', date: '2026-10-08' },
  uhc_eob_sept: { payer: 'UHC', date: '2026-09-21' },
};

/** Self-pay visit summary CSVs. */
export const SELF_PAY_CSVS = ['selfpay_0929', 'selfpay_q3'] as const;

/**
 * The files the Intake demo uploads (artboard 1b). `pnpm seed --scenario=intake-demo` leaves
 * their visits out so they can be added live.
 */
export const INTAKE_DEMO_FILES = [
  'bcbs_era_1008.835',
  'aetna_eob_raman.pdf',
  'uhc_eob_sept.pdf',
  'selfpay_0929.csv',
];

export const VISITS: SeedVisit[] = [
  {
    key: 'maria',
    claimId: 'HFM1001',
    patient: {
      firstName: 'Maria',
      lastName: 'Delgado',
      dob: '1984-04-17',
      memberId: 'XBC884210377',
      email: 'maria.delgado@example.com',
    },
    provider: 'patel',
    visitDate: '2026-10-03',
    lines: [
      { cpt: '99214', charge: 350 },
      { cpt: '80053', charge: 180 },
      { cpt: '93000', charge: 320 },
    ],
    insurance: {
      payer: 'BCBS',
      era: 'bcbs_era_1008',
      payerClaimNumber: 'BC26100800417',
      paid: 210,
      adjustments: [
        { group: 'CO', reason: '45', amount: 400 },
        { group: 'PR', reason: '1', amount: 200 },
        { group: 'PR', reason: '2', amount: 40 },
      ],
    },
    status: 'ready',
    aiSuggestion: 'Send invoice + 3-month plan',
  },
  {
    key: 'kevin',
    claimId: 'SP-0929-01',
    patient: {
      firstName: 'Kevin',
      lastName: 'Lam',
      dob: '1991-02-11',
      email: 'kevin.lam@example.com',
    },
    provider: 'kim',
    visitDate: '2026-09-29',
    lines: [
      { cpt: '99213', charge: 175 },
      { cpt: '87880', charge: 100 },
    ],
    selfPay: { rateApplied: true, csv: 'selfpay_0929' },
    status: 'ready',
    aiSuggestion: 'Send invoice',
  },
  {
    key: 'priya',
    claimId: 'HFM1003',
    patient: {
      firstName: 'Priya',
      lastName: 'Raman',
      dob: '1990-11-02',
      memberId: 'W188420355',
      email: 'priya.raman@example.com',
    },
    provider: 'patel',
    visitDate: '2026-10-01',
    lines: [
      { cpt: '99214', charge: 320 },
      { cpt: '85025', charge: 90 },
      { cpt: '36415', charge: 30 },
      { cpt: '80061', charge: 80 },
    ],
    insurance: {
      payer: 'AETNA',
      eob: { file: 'aetna_eob_raman', obscure: 'insurance_paid' },
      payerClaimNumber: 'AE2610080091',
      paid: 260,
      adjustments: [
        { group: 'CO', reason: '45', amount: 100 },
        { group: 'PR', reason: '3', amount: 160 },
      ],
    },
    status: 'review', // from the EOB flags: "insurance paid $260 or $280?"
    aiSuggestion: null,
  },
  {
    key: 'tomas',
    claimId: 'HFM1004',
    patient: {
      firstName: 'Tomás',
      lastName: 'Herrera',
      dob: '1972-06-23',
      memberId: '921447803',
      email: 'tomas.herrera@example.com',
    },
    provider: 'kim',
    visitDate: '2026-09-12',
    lines: [
      { cpt: '99215', charge: 420 },
      { cpt: '73562', charge: 310 },
      { cpt: '20610', charge: 450 },
      { cpt: '85025', charge: 90 },
      { cpt: '80053', charge: 210 },
    ],
    insurance: {
      payer: 'UHC',
      eob: { file: 'uhc_eob_sept', obscure: 'patient_share_code' },
      payerClaimNumber: 'UH0921A55120',
      paid: 812,
      adjustments: [
        { group: 'CO', reason: '45', amount: 300 },
        { group: 'PR', reason: '3', amount: 368 },
      ],
    },
    status: 'review', // from the EOB flags: "PR-3 (copay), may be PR-2 (coinsurance)"
    aiSuggestion: null,
  },
  {
    key: 'ellen',
    claimId: 'SP-0930-01',
    patient: {
      firstName: 'Ellen',
      lastName: 'Brooks',
      dob: '1978-07-30',
      email: 'ellen.brooks@example.com',
    },
    provider: 'patel',
    visitDate: '2026-09-30',
    lines: [{ cpt: '99214', charge: 310 }],
    selfPay: { rateApplied: false, csv: 'selfpay_q3' },
    status: 'review',
    reviewReason: 'Self-pay rate not applied yet',
    aiSuggestion: 'Apply self-pay rate',
  },
  {
    key: 'marcus',
    claimId: 'HFM1006',
    patient: {
      firstName: 'Marcus',
      lastName: 'Reid',
      dob: '1965-01-19',
      memberId: 'W204115689',
      email: 'marcus.reid@example.com',
    },
    provider: 'okoye',
    visitDate: '2026-08-25',
    lines: [
      { cpt: '99204', charge: 400 },
      { cpt: '71046', charge: 220 },
      { cpt: '93000', charge: 280 },
    ],
    insurance: {
      payer: 'AETNA',
      era: 'aetna_era_0914',
      payerClaimNumber: 'AE2609140377',
      paid: 520,
      adjustments: [
        { group: 'CO', reason: '45', amount: 140 },
        { group: 'PR', reason: '1', amount: 150 },
        { group: 'PR', reason: '2', amount: 90 },
      ],
    },
    status: 'review',
    reviewReason: 'Possible duplicate of an earlier claim',
    aiSuggestion: 'Possible duplicate — compare',
  },
  {
    key: 'james',
    claimId: 'HFM1007',
    patient: {
      firstName: 'James',
      lastName: 'Whitfield',
      dob: '1958-09-04',
      memberId: 'XBC310588721',
      email: 'james.whitfield@example.com',
    },
    provider: 'okoye',
    visitDate: '2026-09-18',
    lines: [{ cpt: '72148', charge: 2400 }],
    insurance: {
      payer: 'BCBS',
      era: 'bcbs_era_0930',
      payerClaimNumber: 'BC26093000288',
      denied: true,
      paid: 0,
      adjustments: [{ group: 'CO', reason: '197', amount: 2400 }],
      remarks: ['M62'],
    },
    status: 'denied',
    aiSuggestion: 'Resubmit with auth number',
  },
  {
    key: 'denise',
    claimId: 'HFM1008',
    patient: {
      firstName: 'Denise',
      lastName: 'Okafor',
      dob: '1987-03-14',
      memberId: '933018455',
      email: 'denise.okafor@example.com',
    },
    provider: 'kim',
    visitDate: '2026-08-14',
    lines: [
      { cpt: '99204', charge: 380 },
      { cpt: '93000', charge: 230 },
    ],
    insurance: {
      payer: 'UHC',
      era: 'uhc_era_0826',
      payerClaimNumber: 'UH0826A40211',
      denied: true,
      paid: 0,
      adjustments: [{ group: 'CO', reason: '16', amount: 610 }],
      remarks: ['N286'],
    },
    status: 'denied',
    aiSuggestion: 'Add referral & resubmit',
  },
  {
    key: 'grace',
    claimId: 'HFM1009',
    patient: {
      firstName: 'Grace',
      lastName: 'Whitaker',
      dob: '1969-12-08',
      memberId: 'W177302946',
      email: 'grace.whitaker@example.com',
    },
    provider: 'okoye',
    visitDate: '2026-08-02',
    lines: [
      { cpt: '99396', charge: 380 },
      { cpt: '80053', charge: 210 },
      { cpt: '80061', charge: 150 },
      { cpt: '85025', charge: 90 },
      { cpt: '93000', charge: 210 },
    ],
    insurance: {
      payer: 'AETNA',
      era: 'aetna_era_0812',
      payerClaimNumber: 'AE2608120154',
      paid: 690,
      adjustments: [
        { group: 'CO', reason: '45', amount: 100 },
        { group: 'PR', reason: '1', amount: 250 },
      ],
    },
    status: 'sent',
    aiSuggestion: 'Send friendly reminder',
    invoice: { sentOn: '2026-08-14', openCount: 2 },
  },
  {
    key: 'robert',
    claimId: 'HFM1010',
    patient: {
      firstName: 'Robert',
      lastName: 'Chen',
      dob: '1981-05-27',
      memberId: '918662047',
      email: 'robert.chen@example.com',
    },
    provider: 'patel',
    visitDate: '2026-09-05',
    lines: [
      { cpt: '99214', charge: 330 },
      { cpt: '71046', charge: 270 },
    ],
    insurance: {
      payer: 'UHC',
      era: 'uhc_era_0921',
      payerClaimNumber: 'UH0921A55187',
      paid: 380,
      adjustments: [
        { group: 'CO', reason: '45', amount: 70 },
        { group: 'PR', reason: '2', amount: 150 },
      ],
    },
    status: 'sent',
    aiSuggestion: 'Offer 3-month plan',
    invoice: { sentOn: '2026-09-22', openCount: 0 },
  },
  {
    key: 'aisha',
    claimId: 'SP-0620-01',
    patient: {
      firstName: 'Aisha',
      lastName: 'Bello',
      dob: '1995-08-21',
      email: 'aisha.bello@example.com',
    },
    provider: 'kim',
    visitDate: '2026-06-20',
    lines: [
      { cpt: '99204', charge: 420 },
      { cpt: '20610', charge: 380 },
      { cpt: '73562', charge: 400 },
    ],
    selfPay: { rateApplied: true, csv: 'selfpay_q3' },
    status: 'partial',
    aiSuggestion: 'Offer 6-month plan · $100/mo',
    invoice: { sentOn: '2026-06-24', openCount: 3 },
    payments: [
      { on: '2026-07-15', amount: 300, method: 'paypal' },
      { on: '2026-10-02', amount: 300, method: 'paypal' },
    ],
  },
  {
    // Seeded as "sent" so the demo can pay it live: POST /api/dev/simulate-payment moves it to
    // Paid on Oct 10, which is 18 days after the visit — the "paid in 18 days" of the seed table.
    key: 'samuel',
    claimId: 'HFM1012',
    patient: {
      firstName: 'Samuel',
      lastName: 'Ortiz',
      dob: '1988-10-30',
      memberId: 'XBC552019846',
      email: 'samuel.ortiz@example.com',
    },
    provider: 'okoye',
    visitDate: '2026-09-22',
    lines: [
      { cpt: '99213', charge: 280 },
      { cpt: '85025', charge: 90 },
      { cpt: '36415', charge: 30 },
      { cpt: '87880', charge: 50 },
    ],
    insurance: {
      payer: 'BCBS',
      era: 'bcbs_era_1008',
      payerClaimNumber: 'BC26100800452',
      paid: 300,
      adjustments: [
        { group: 'CO', reason: '45', amount: 70 },
        { group: 'PR', reason: '3', amount: 80 },
      ],
    },
    status: 'sent',
    aiSuggestion: null,
    invoice: { sentOn: '2026-10-08', openCount: 1 },
  },
  {
    key: 'linda',
    claimId: 'HFM1013',
    patient: {
      firstName: 'Linda',
      lastName: 'Park',
      dob: '1976-02-03',
      memberId: 'W166045812',
      email: 'linda.park@example.com',
    },
    provider: 'patel',
    visitDate: '2026-09-10',
    lines: [
      { cpt: '99213', charge: 260 },
      { cpt: '80053', charge: 210 },
      { cpt: '85025', charge: 90 },
    ],
    insurance: {
      payer: 'AETNA',
      era: 'aetna_era_0914',
      payerClaimNumber: 'AE2609140342',
      paid: 410,
      adjustments: [
        { group: 'CO', reason: '45', amount: 50 },
        { group: 'PR', reason: '2', amount: 100 },
      ],
    },
    status: 'paid',
    aiSuggestion: null,
    invoice: { sentOn: '2026-09-14', openCount: 2 },
    payments: [{ on: '2026-09-16', amount: 100, method: 'paypal' }],
  },
];

/** The balance id the demo pays live (Samuel Ortiz). */
export const DEMO_PAYMENT_KEY = 'samuel';
