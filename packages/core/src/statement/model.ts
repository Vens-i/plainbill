/**
 * The practice's itemized patient statement, as data: the activity table (charges, insurance
 * payment, write-off, patient responsibility, patient payments) with a running balance, the
 * totals and the MESSAGES text. Every figure is copied from the computed balance; the only
 * arithmetic here is the running balance, and it must land exactly on what the patient owes.
 */
import { ReconciliationError, type PatientShare } from '../balance';
import type { StatementAgingKey } from '../aging';
import type { IsoDate } from '../dates';
import { assertCents, formatMoney, sumCents, type Cents } from '../money';
import { describeProcedure } from '../procedures';

/** What a highlight on the statement points at. */
export type AnchorKind =
  | 'amount_due'
  | 'charges'
  | 'insurance_payment'
  | 'discount'
  | 'patient_responsibility'
  | 'patient_payment'
  | 'messages';

export interface StatementInput {
  practice: {
    name: string;
    addressLine1: string;
    addressLine2: string | null;
    city: string;
    state: string;
    zip: string;
    phone: string;
    hours: string | null;
    /** "pay.harborviewfm.example", printed on the coupon. */
    payUrlHost: string;
  };
  patient: { firstName: string; lastName: string; addressLines: string[] };
  /** "000001" */
  accountNumber: string;
  /** "S0000012" */
  statementId: string;
  statementDate: IsoDate;
  dueDate: IsoDate;
  payUrl: string;
  visit: {
    date: IsoDate;
    /** "Dr. Patel" */
    providerName: string | null;
    /** "BlueCross BlueShield" */
    payerName: string;
    /** "BlueCross" */
    payerShortName: string;
    selfPay: boolean;
    /** When the claim went to the payer; the visit date when unknown. */
    claimFiledDate: IsoDate | null;
    /** The payer's payment (835 BPR16), and its EFT trace number. */
    paymentDate: IsoDate | null;
    traceNumber: string | null;
  };
  lines: Array<{ code: string; chargeCents: Cents }>;
  /** Insurance write-off (CO total) or the self-pay discount. */
  contractualCents: Cents;
  /** "CO45": the main write-off code, printed in the CODE column. */
  contractualCode: string;
  /** Null for self-pay. */
  insurancePaidCents: Cents | null;
  patientShare: PatientShare;
  payments: Array<{ date: IsoDate; amountCents: Cents }>;
  remainingCents: Cents;
  aging: Record<StatementAgingKey, Cents>;
  /** An interest-free plan offered and not started yet. */
  planOffer: { months: 3 | 6; firstCents: Cents; regularCents: Cents } | null;
  /** A plan in progress (or finished). */
  planActive: {
    months: number;
    paidCount: number;
    nextDate: IsoDate | null;
    nextCents: Cents | null;
  } | null;
}

export interface ActivityRow {
  /** "line-1", "claim-filed", "insurance-payment", "contractual", "patient-responsibility", "payment-1" */
  id: string;
  date: IsoDate;
  /** Patient first name, upper-case. */
  patient: string;
  code: string;
  description: string;
  chargeCents: Cents | null;
  creditCents: Cents | null;
  /** Running balance after the row; null for rows that don't move it (claim filed). */
  balanceCents: Cents | null;
  anchor: AnchorKind | null;
}

export interface StatementTotals {
  billedCents: Cents;
  contractualCents: Cents;
  insurancePaidCents: Cents;
  /** Deductible + coinsurance + copay + other (insurance) or the self-pay price. */
  patientShareCents: Cents;
  patientPaidCents: Cents;
  remainingCents: Cents;
}

export interface StatementModel {
  input: StatementInput;
  rows: ActivityRow[];
  totals: StatementTotals;
  /** The MESSAGES box, upper-case like the rest of the paper. */
  message: string;
}

/** "2026-10-03" → "10/03/26" (activity rows) or "10/03/2026" (header boxes). */
export function statementDate(date: IsoDate, longYear = false): string {
  const [y, m, d] = date.split('-');
  return `${m}/${d}/${longYear ? y : y!.slice(2)}`;
}

/** 120000 → "1,200.00"; credits print as "-210.00" with an ASCII hyphen (WinAnsi-safe). */
export function statementAmount(cents: Cents): string {
  const text = formatMoney(Math.abs(cents)).slice(1);
  return cents < 0 ? `-${text}` : text;
}

const upper = (s: string) => s.toUpperCase();

function shareParts(s: PatientShare): Array<{ code: string; label: string; cents: Cents }> {
  return [
    { code: 'PR1', label: 'DED', cents: s.deductibleCents },
    { code: 'PR2', label: 'COINS', cents: s.coinsuranceCents },
    { code: 'PR3', label: 'COPAY', cents: s.copayCents },
    { code: 'PR', label: 'OTHER', cents: s.otherCents },
  ].filter((p) => p.cents > 0);
}

function messageText(input: StatementInput, totals: StatementTotals): string {
  const name = upper(input.practice.name);
  const due = statementDate(input.dueDate, true);
  const remaining = `$${statementAmount(totals.remainingCents)}`;
  if (totals.remainingCents === 0) {
    return `YOUR ACCOUNT IS PAID IN FULL. THANK YOU FOR YOUR PAYMENT AND FOR CHOOSING ${name}.`;
  }
  const parts: string[] = [];
  if (input.visit.selfPay) {
    parts.push('THIS VISIT WAS BILLED AT OUR SELF-PAY RATE.');
  } else {
    parts.push('YOUR INSURANCE HAS PROCESSED THIS CLAIM.');
  }
  if (totals.patientPaidCents > 0) {
    parts.push(
      `THANK YOU FOR YOUR PAYMENTS. THE REMAINING BALANCE OF ${remaining} IS DUE BY ${due}.`,
    );
  } else {
    parts.push(`THE REMAINING BALANCE IS YOUR RESPONSIBILITY AND IS DUE BY ${due}.`);
  }
  const active = input.planActive;
  if (active && active.paidCount < active.months) {
    parts.push(
      `YOU ARE ON A ${active.months}-MONTH PAYMENT PLAN: ${active.paidCount} OF ${active.months} PAID.` +
        (active.nextDate && active.nextCents
          ? ` NEXT PAYMENT $${statementAmount(active.nextCents)} ON ${statementDate(active.nextDate, true)}.`
          : ''),
    );
  } else if (input.planOffer) {
    const p = input.planOffer;
    parts.push(
      p.firstCents === p.regularCents
        ? `YOU CAN ALSO PAY IN ${p.months} MONTHLY PAYMENTS OF $${statementAmount(p.regularCents)} WITH NO INTEREST OR FEES.`
        : `YOU CAN ALSO PAY IN ${p.months} MONTHLY PAYMENTS ($${statementAmount(p.firstCents)} FIRST, THEN $${statementAmount(p.regularCents)}) WITH NO INTEREST OR FEES.`,
    );
  }
  parts.push(
    `IF YOU HAVE QUESTIONS ABOUT YOUR BALANCE OR WISH TO MAKE PAYMENT ARRANGEMENTS, PLEASE CALL OUR BILLING OFFICE. THANK YOU FOR CHOOSING ${name}.`,
  );
  return parts.join(' ');
}

export function buildStatementModel(input: StatementInput): StatementModel {
  const { visit } = input;
  const amounts = [
    input.contractualCents,
    input.insurancePaidCents ?? 0,
    input.remainingCents,
    ...input.lines.map((l) => l.chargeCents),
    ...input.payments.map((p) => p.amountCents),
  ];
  for (const a of amounts) {
    assertCents(a);
    if (a < 0) throw new RangeError(`statement amounts must not be negative, got ${a}`);
  }

  const billed = sumCents(input.lines.map((l) => l.chargeCents));
  const insurancePaid = input.insurancePaidCents ?? 0;
  const patientPaid = sumCents(input.payments.map((p) => p.amountCents));
  const shareCents = billed - input.contractualCents - insurancePaid;
  const derived = shareCents - patientPaid;
  if (derived !== input.remainingCents) {
    throw new ReconciliationError(
      `Statement ${input.statementId} does not reconcile: billed ${formatMoney(billed)} − ` +
        `discount ${formatMoney(input.contractualCents)} − insurance ${formatMoney(insurancePaid)} − ` +
        `paid ${formatMoney(patientPaid)} = ${formatMoney(derived)}, not ${formatMoney(input.remainingCents)}.`,
    );
  }

  const patient = upper(input.patient.firstName);
  const rows: ActivityRow[] = [];
  let balance = 0;
  const row = (r: Omit<ActivityRow, 'patient'>) => rows.push({ ...r, patient });

  input.lines.forEach((l, i) => {
    balance += l.chargeCents;
    row({
      id: `line-${i + 1}`,
      date: visit.date,
      code: l.code,
      description: upper(describeProcedure(l.code).label),
      chargeCents: l.chargeCents,
      creditCents: null,
      balanceCents: balance,
      anchor: 'charges',
    });
  });

  if (!visit.selfPay) {
    const adjudicated = visit.paymentDate ?? visit.claimFiledDate ?? visit.date;
    const payer = upper(visit.payerShortName);
    row({
      id: 'claim-filed',
      date: visit.claimFiledDate ?? visit.date,
      code: '',
      description: `CLAIM FILED TO ${upper(visit.payerName)}`,
      chargeCents: null,
      creditCents: null,
      balanceCents: null,
      anchor: null,
    });
    if (insurancePaid > 0) {
      balance -= insurancePaid;
      row({
        id: 'insurance-payment',
        date: adjudicated,
        code: 'INSPMT',
        description: `INS PMT ${payer}${visit.traceNumber ? ` EFT ${upper(visit.traceNumber)}` : ''}`,
        chargeCents: null,
        creditCents: insurancePaid,
        balanceCents: balance,
        anchor: 'insurance_payment',
      });
    }
    if (input.contractualCents > 0) {
      balance -= input.contractualCents;
      row({
        id: 'contractual',
        date: adjudicated,
        code: input.contractualCode,
        description: `CONTRACTUAL ADJ - ${payer}`,
        chargeCents: null,
        creditCents: input.contractualCents,
        balanceCents: balance,
        anchor: 'discount',
      });
    }
    const parts = shareParts(input.patientShare);
    if (parts.length) {
      row({
        id: 'patient-responsibility',
        date: adjudicated,
        code: parts.map((p) => p.code).join(' '),
        description: `PT RESP: ${parts.map((p) => `${p.label} ${statementAmount(p.cents)}`).join(' ')}`,
        chargeCents: null,
        creditCents: null,
        balanceCents: balance,
        anchor: 'patient_responsibility',
      });
    }
  } else if (input.contractualCents > 0) {
    balance -= input.contractualCents;
    row({
      id: 'contractual',
      date: visit.date,
      code: 'SELF',
      description: 'SELF-PAY RATE',
      chargeCents: null,
      creditCents: input.contractualCents,
      balanceCents: balance,
      anchor: 'discount',
    });
  }

  input.payments.forEach((p, i) => {
    balance -= p.amountCents;
    row({
      id: `payment-${i + 1}`,
      date: p.date,
      code: 'PTPMT',
      description: 'PATIENT PAYMENT - THANK YOU',
      chargeCents: null,
      creditCents: p.amountCents,
      balanceCents: balance,
      anchor: 'patient_payment',
    });
  });

  if (balance !== input.remainingCents) {
    throw new ReconciliationError(
      `Statement ${input.statementId}: running balance ends at ${formatMoney(balance)}, not ${formatMoney(input.remainingCents)}.`,
    );
  }

  const totals: StatementTotals = {
    billedCents: billed,
    contractualCents: input.contractualCents,
    insurancePaidCents: insurancePaid,
    patientShareCents: shareCents,
    patientPaidCents: patientPaid,
    remainingCents: input.remainingCents,
  };
  return { input, rows, totals, message: messageText(input, totals) };
}
