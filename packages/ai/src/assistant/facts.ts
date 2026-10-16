/**
 * The patient's bill helper answers from BillFacts only: this one bill, computed by
 * @plainbill/core. It's richer than MessageFacts (the patient has verified, so services are
 * listed by plain-language name), but still has no codes or insurance IDs.
 */
import { formatLongDate, formatMoneyShort, formatMonthDay } from '@plainbill/core';
import { findAmounts } from '../message/guard';

export interface BillFacts {
  patientFirstName: string;
  practice: { name: string; phone: string; hours: string | null };
  /** ISO date. */
  visitDate: string;
  /** "Dr. Patel" */
  provider: string | null;
  selfPay: boolean;
  /** "BlueCross"; null for self-pay. */
  payerShortName: string | null;
  billedCents: number;
  /** Contract discount (insurance) or self-pay discount. */
  discountCents: number;
  allowedCents: number;
  insurancePaidCents: number;
  deductibleCents: number;
  coinsuranceCents: number;
  copayCents: number;
  otherPatientCents: number;
  /** What the patient was responsible for, before any of their payments. */
  patientShareCents: number;
  paidCents: number;
  remainingCents: number;
  /** ISO date. */
  dueDate: string;
  services: Array<{ name: string; chargeCents: number }>;
  /**
   * A covered checkup with another concern billed as its own office visit (detected by
   * @plainbill/core). The amounts are the office visit's; what the concern was is never known.
   */
  splitVisit?: {
    checkupChargeCents: number;
    visitChargeCents: number;
    shareCents: number;
    deductibleCents: number;
    coinsuranceCents: number;
    copayCents: number;
  } | null;
  options: {
    payInFull: boolean;
    partialMinimumCents: number | null;
    plans: Array<{ months: 3 | 6; firstCents: number; regularCents: number }>;
  };
  activePlan: {
    months: number;
    paidCount: number;
    schedule: Array<{ dueDate: string; amountCents: number; paid: boolean }>;
  } | null;
}

export type AssistantActionKind = 'pay_in_full' | 'payment_plan' | 'partial_payment' | 'phone_call';

/** A confirmation card the page shows under the answer. Built by code, never by the model. */
export interface ProposalCard {
  /** Server id to confirm with; null for cards with nothing to confirm (a phone number). */
  id: string | null;
  kind: AssistantActionKind;
  title: string;
  detail: string[];
  amountCents: number | null;
  confirmLabel: string | null;
}

/** Every dollar figure an answer may mention. */
export function assistantAmounts(f: BillFacts): Set<number> {
  const amounts = [
    f.billedCents,
    f.discountCents,
    f.allowedCents,
    f.insurancePaidCents,
    f.deductibleCents,
    f.coinsuranceCents,
    f.copayCents,
    f.otherPatientCents,
    f.patientShareCents,
    f.paidCents,
    f.remainingCents,
    f.options.partialMinimumCents,
    ...f.services.map((s) => s.chargeCents),
    ...(f.splitVisit
      ? [
          f.splitVisit.checkupChargeCents,
          f.splitVisit.visitChargeCents,
          f.splitVisit.shareCents,
          f.splitVisit.deductibleCents,
          f.splitVisit.coinsuranceCents,
          f.splitVisit.copayCents,
        ]
      : []),
    ...f.options.plans.flatMap((p) => [p.firstCents, p.regularCents]),
    ...(f.activePlan?.schedule.map((s) => s.amountCents) ?? []),
  ];
  return new Set(amounts.filter((a): a is number => typeof a === 'number' && a > 0));
}

/** "Based on BlueCross's statement for your Oct 3 visit" (artboard 1f). */
export function sourceLine(f: BillFacts): string {
  const visit = formatMonthDay(f.visitDate);
  return f.selfPay
    ? `Based on ${shortName(f.practice.name)}'s self-pay rate for your ${visit} visit`
    : `Based on ${f.payerShortName}'s statement for your ${visit} visit`;
}

export const shortName = (practiceName: string) => practiceName.split(' ')[0]!;

const $ = formatMoneyShort;

/**
 * Why a "free" checkup came with a bill: the checkup was covered, and another concern discussed
 * during it was billed as its own office visit. Deterministic, never names the concern.
 */
export function explainSplitVisit(f: BillFacts): string | null {
  const s = f.splitVisit;
  if (!s) return null;
  const who = f.provider ?? 'your provider';
  const kinds = [
    s.deductibleCents > 0 && 'deductible',
    s.coinsuranceCents > 0 && 'coinsurance',
    s.copayCents > 0 && 'copay',
  ].filter(Boolean);
  const owed =
    kinds.length === 1 && kinds[0] === 'deductible'
      ? `${$(s.shareCents)} of it went toward your yearly deductible, so that part is yours to pay.`
      : kinds.length === 1 && kinds[0] === 'coinsurance'
        ? `Your share of it is ${$(s.shareCents)} (coinsurance).`
        : kinds.length === 1 && kinds[0] === 'copay'
          ? `It has a ${$(s.shareCents)} copay.`
          : `Your share of it is ${$(s.shareCents)}.`;
  return (
    `Your yearly checkup was covered in full. During it you also talked with ${who} about another concern, ` +
    `and that part is billed as a regular office visit (${$(s.visitChargeCents)}), which your plan treats like any sick visit. ${owed}`
  );
}

/**
 * Why the patient owes what they owe, in the design's words ("Your plan put $200 toward your
 * yearly deductible… $200 + $40 = $240."). Deterministic: used by the offline helper and as
 * the safe answer when the model's reply fails the guard.
 */
export function explainOwes(f: BillFacts): string {
  const out: string[] = [];
  const split = explainSplitVisit(f);
  if (split) out.push(split);
  if (split && f.splitVisit!.shareCents === f.patientShareCents) {
    // The office visit is the whole share; the split explanation already says how.
  } else if (f.selfPay) {
    out.push(
      f.discountCents > 0
        ? `Your visit came to ${$(f.billedCents)}. ${shortName(f.practice.name)}'s self-pay rate took off ${$(f.discountCents)}, so your price is ${$(f.patientShareCents)}.`
        : `Your visit came to ${$(f.billedCents)} at ${shortName(f.practice.name)}'s self-pay price.`,
    );
  } else {
    const parts: Array<[string, number]> = [];
    if (f.deductibleCents > 0) {
      out.push(
        `Your plan put ${$(f.deductibleCents)} toward your yearly deductible — the amount you pay before insurance starts sharing costs.`,
      );
      parts.push(['deductible', f.deductibleCents]);
    }
    if (f.coinsuranceCents > 0) {
      out.push(
        `${parts.length ? 'After that, your' : 'Your'} share was ${$(f.coinsuranceCents)} (coinsurance).`,
      );
      parts.push(['coinsurance', f.coinsuranceCents]);
    }
    if (f.copayCents > 0) {
      out.push(`${$(f.copayCents)} is your copay — the set amount your plan charges for a visit.`);
      parts.push(['copay', f.copayCents]);
    }
    if (f.otherPatientCents > 0) {
      out.push(`${$(f.otherPatientCents)} wasn't covered by your plan.`);
      parts.push(['other', f.otherPatientCents]);
    }
    if (parts.length > 1) {
      out.push(`${parts.map(([, c]) => $(c)).join(' + ')} = ${$(f.patientShareCents)}.`);
    } else if (!parts.length) {
      out.push(
        `After ${f.payerShortName} paid ${$(f.insurancePaidCents)}, your share is ${$(f.patientShareCents)}.`,
      );
    }
  }
  if (f.paidCents > 0) {
    out.push(`You've paid ${$(f.paidCents)} so far, so ${$(f.remainingCents)} is left.`);
  }
  return out.join(' ');
}

export function factsBlock(f: BillFacts): string {
  const lines = [
    `Patient first name: ${f.patientFirstName}`,
    `Practice: ${f.practice.name}, phone ${f.practice.phone}${f.practice.hours ? `, ${f.practice.hours}` : ''}`,
    `Visit date: ${formatLongDate(f.visitDate)}${f.provider ? ` with ${f.provider}` : ''}`,
    f.selfPay ? 'Insurance: none (self-pay rate)' : `Insurance plan: ${f.payerShortName}`,
    `Services (billed): ${f.services.map((s) => `${s.name} ${$(s.chargeCents)}`).join('; ')}`,
    `Total billed: ${$(f.billedCents)}`,
  ];
  if (f.selfPay) {
    if (f.discountCents) lines.push(`Self-pay discount: ${$(f.discountCents)}`);
  } else {
    lines.push(
      `Insurance discount (contract rate, the patient never pays it): ${$(f.discountCents)}`,
      `Allowed amount (price the plan agreed to): ${$(f.allowedCents)}`,
      `Insurance paid: ${$(f.insurancePaidCents)}`,
    );
    if (f.deductibleCents) lines.push(`Toward the yearly deductible: ${$(f.deductibleCents)}`);
    if (f.coinsuranceCents) lines.push(`Coinsurance (patient's share): ${$(f.coinsuranceCents)}`);
    if (f.copayCents) lines.push(`Copay: ${$(f.copayCents)}`);
    if (f.otherPatientCents) lines.push(`Not covered by the plan: ${$(f.otherPatientCents)}`);
  }
  if (f.splitVisit) {
    lines.push(
      `Split visit: the yearly checkup (${$(f.splitVisit.checkupChargeCents)}) was covered in full. Another concern was discussed during it and billed as a separate office visit (${$(f.splitVisit.visitChargeCents)}); the patient's share of that office visit is ${$(f.splitVisit.shareCents)}. What the concern was is not on the bill.`,
    );
  }
  lines.push(`Patient's share: ${$(f.patientShareCents)}`);
  if (f.paidCents) lines.push(`Already paid by the patient: ${$(f.paidCents)}`);
  lines.push(`Left to pay: ${$(f.remainingCents)}, due ${formatLongDate(f.dueDate)}`);
  if (f.activePlan) {
    lines.push(
      `Payment plan in place: ${f.activePlan.paidCount} of ${f.activePlan.months} paid; schedule ${f.activePlan.schedule
        .map((s) => `${formatMonthDay(s.dueDate)} ${$(s.amountCents)}${s.paid ? ' (paid)' : ''}`)
        .join(', ')}`,
    );
  }
  const ways = [
    f.options.payInFull && f.remainingCents > 0 ? `pay ${$(f.remainingCents)} in full` : null,
    ...f.options.plans.map((p) =>
      p.firstCents === p.regularCents
        ? `${p.months} monthly payments of ${$(p.regularCents)} (no interest or fees)`
        : `${p.months} monthly payments: ${$(p.firstCents)} first, then ${$(p.regularCents)} (no interest or fees)`,
    ),
    f.options.partialMinimumCents
      ? `pay part now (minimum ${$(f.options.partialMinimumCents)})`
      : null,
  ].filter(Boolean);
  lines.push(`Ways to pay: ${ways.length ? ways.join('; ') : 'nothing is owed'}`);
  return lines.join('\n');
}

export interface AnswerIssue {
  kind: 'unknown-amount' | 'medical-code' | 'too-long' | 'empty';
  detail: string;
}

const CODE_RES = [/\b\d{5}\b/, /\b[A-TV-Z]\d{2}\.\d{1,4}\b/, /\b(?:CO|PR|OA|PI)-\d{1,3}\b/];
const MAX_WORDS = 120;

/** An answer may only mention this bill's figures (plus any amount the patient proposed). */
export function checkAnswer(text: string, facts: BillFacts, extra: number[] = []): AnswerIssue[] {
  const trimmed = text.trim();
  if (!trimmed) return [{ kind: 'empty', detail: 'The answer is empty.' }];
  const allowed = assistantAmounts(facts);
  for (const e of extra) allowed.add(e);
  const issues: AnswerIssue[] = [];
  for (const amount of new Set(findAmounts(trimmed))) {
    if (!allowed.has(amount)) {
      issues.push({
        kind: 'unknown-amount',
        detail: `${$(amount)} is not one of this bill's figures.`,
      });
    }
  }
  for (const re of CODE_RES) {
    const match = re.exec(trimmed);
    if (match) {
      issues.push({ kind: 'medical-code', detail: `"${match[0]}" looks like a billing code.` });
    }
  }
  const words = trimmed.split(/\s+/).length;
  if (words > MAX_WORDS) {
    issues.push({ kind: 'too-long', detail: `${words} words (keep it under ${MAX_WORDS}).` });
  }
  return issues;
}
