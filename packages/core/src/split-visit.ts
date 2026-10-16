/**
 * The "split visit": a preventive checkup where a new problem was also discussed. The payer
 * covers the checkup in full, but the problem is billed as its own office visit (the E/M line
 * carries modifier 25), and that part goes to the deductible, coinsurance or copay. Patients
 * expect a free checkup and get a bill, so Plainbill explains it.
 *
 * Detection is code, from the adjudicated 835 lines only; the model never decides whether a
 * visit is split. When the claim is ambiguous (two problem visits, two checkups, no line-level
 * adjudication) we return null and say nothing rather than explain the wrong thing.
 */
import { sumCents, type Cents } from './money';
import type { NormalizedClaim, ServiceLine } from './types';

/** 99381–99387 (new patient) and 99391–99397 (established): preventive medicine E/M. */
export function isPreventiveVisitCode(code: string): boolean {
  const n = Number(code);
  return /^\d{5}$/.test(code) && ((n >= 99381 && n <= 99387) || (n >= 99391 && n <= 99397));
}

/** 99202–99205 and 99211–99215: problem-oriented office visits. */
export function isProblemVisitCode(code: string): boolean {
  const n = Number(code);
  return /^\d{5}$/.test(code) && ((n >= 99202 && n <= 99205) || (n >= 99211 && n <= 99215));
}

export interface SplitVisitShare {
  deductibleCents: Cents;
  coinsuranceCents: Cents;
  copayCents: Cents;
  otherCents: Cents;
  totalCents: Cents;
}

export interface SplitVisit {
  preventive: { lineNumber: number; code: string; chargeCents: Cents; paidCents: Cents };
  problem: {
    lineNumber: number;
    code: string;
    chargeCents: Cents;
    paidCents: Cents;
    /** What the patient owes for the problem visit, by type (PR adjustments on that line). */
    patientShare: SplitVisitShare;
  };
}

function patientShareOf(line: ServiceLine): SplitVisitShare {
  const pr = line.adjustments.filter((a) => a.group === 'PR');
  const by = (reason: string) =>
    sumCents(pr.filter((a) => a.reason === reason).map((a) => a.amountCents));
  const totalCents = sumCents(pr.map((a) => a.amountCents));
  const deductibleCents = by('1');
  const coinsuranceCents = by('2');
  const copayCents = by('3');
  return {
    deductibleCents,
    coinsuranceCents,
    copayCents,
    otherCents: totalCents - deductibleCents - coinsuranceCents - copayCents,
    totalCents,
  };
}

export function detectSplitVisit(claim: NormalizedClaim): SplitVisit | null {
  // Only an 835 adjudicates each line; EOBs and self-pay visits can't show the split.
  if (claim.source.kind !== '835' || claim.denied) return null;

  const preventive = claim.lines.filter((l) => isPreventiveVisitCode(l.procedureCode));
  // Every office-visit line counts toward "exactly one", with or without modifier 25: with two,
  // we can't say which one the patient is asking about.
  const problem = claim.lines.filter((l) => isProblemVisitCode(l.procedureCode));
  if (preventive.length !== 1 || problem.length !== 1) return null;

  const checkup = preventive[0]!;
  const sick = problem[0]!;
  if (!sick.modifiers.includes('25')) return null;
  // "Covered in full" has to be literally true: the payer paid and the patient owes nothing.
  if (checkup.paidCents <= 0 || patientShareOf(checkup).totalCents !== 0) return null;
  const share = patientShareOf(sick);
  if (share.totalCents <= 0) return null;

  return {
    preventive: {
      lineNumber: checkup.lineNumber,
      code: checkup.procedureCode,
      chargeCents: checkup.chargeCents,
      paidCents: checkup.paidCents,
    },
    problem: {
      lineNumber: sick.lineNumber,
      code: sick.procedureCode,
      chargeCents: sick.chargeCents,
      paidCents: sick.paidCents,
      patientShare: share,
    },
  };
}
