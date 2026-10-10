/**
 * Balance math. Every amount a patient sees is computed here, from a NormalizedClaim, with
 * integer cents. The core invariant, enforced on every claim:
 *
 *     billed − contractual − insurancePaid = patientOwes
 *
 * where "contractual" is every adjustment the patient is not responsible for (CAS groups CO,
 * OA, PI, CR; for a denial that is the whole write-off) and patientOwes is the sum of the PR
 * adjustments. If the source data does not reconcile we throw instead of guessing.
 */
import { describeAdjustment, type Responsibility } from './codes';
import { formatMoney, sumCents, type Cents } from './money';
import type { Adjustment, GroupCode, NormalizedClaim } from './types';

export interface ReconciliationFigures {
  billedCents: Cents;
  contractualCents: Cents;
  insurancePaidCents: Cents;
  patientOwesCents: Cents;
}

export class ReconciliationError extends Error {
  override name = 'ReconciliationError';
  constructor(
    message: string,
    readonly claimId?: string,
  ) {
    super(message);
  }
}

export interface SummarizedAdjustment {
  code: string;
  group: GroupCode;
  reason: string;
  amountCents: Cents;
  responsibility: Responsibility;
  label: string;
}

export interface PatientShare {
  deductibleCents: Cents;
  coinsuranceCents: Cents;
  copayCents: Cents;
  otherCents: Cents;
  selfPayCents: Cents;
}

export interface PatientBalance extends ReconciliationFigures {
  denied: boolean;
  patientShare: PatientShare;
  /** Claim- and line-level adjustments rolled up by code: write-offs first, then patient share. */
  adjustments: SummarizedAdjustment[];
}

const fm = (cents: Cents) => formatMoney(cents);

/** Throws ReconciliationError unless billed − contractual − insurancePaid = patientOwes ≥ 0. */
export function assertReconciles(
  f: ReconciliationFigures,
  context = 'Balance',
  claimId?: string,
): void {
  const derived = f.billedCents - f.contractualCents - f.insurancePaidCents;
  if (derived !== f.patientOwesCents) {
    throw new ReconciliationError(
      `${context} does not reconcile: billed ${fm(f.billedCents)} − contractual ${fm(f.contractualCents)} − ` +
        `insurance paid ${fm(f.insurancePaidCents)} = ${fm(derived)}, not ${fm(f.patientOwesCents)}.`,
      claimId,
    );
  }
  if (f.patientOwesCents < 0) {
    throw new ReconciliationError(
      `${context} has a negative patient balance (${fm(f.patientOwesCents)}).`,
      claimId,
    );
  }
}

function summarize(adjustments: readonly Adjustment[]): SummarizedAdjustment[] {
  const byCode = new Map<string, SummarizedAdjustment>();
  for (const adj of adjustments) {
    const d = describeAdjustment(adj.group, adj.reason);
    const existing = byCode.get(d.code);
    if (existing) {
      existing.amountCents += adj.amountCents;
    } else {
      byCode.set(d.code, {
        code: d.code,
        group: adj.group,
        reason: adj.reason,
        amountCents: adj.amountCents,
        responsibility: d.responsibility,
        label: d.label,
      });
    }
  }
  const all = [...byCode.values()];
  return [
    ...all.filter((a) => a.responsibility === 'payer'),
    ...all.filter((a) => a.responsibility === 'patient'),
  ];
}

export function computePatientBalance(claim: NormalizedClaim): PatientBalance {
  const id = claim.patientControlNumber;
  const ctx = `Claim ${id}`;
  const selfPay = claim.source.kind === 'self-pay-csv';
  // Only 835s adjudicate each service line. EOBs report the outcome at claim level (their lines
  // are just the services and charges), and a self-pay line is simply owed by the patient.
  const lineAdjudicated = claim.source.kind === '835';

  // X12 line balancing: charge − paid = line adjustments.
  for (const line of lineAdjudicated ? claim.lines : []) {
    const adjusted = sumCents(line.adjustments.map((a) => a.amountCents));
    if (line.chargeCents - line.paidCents !== adjusted) {
      throw new ReconciliationError(
        `${ctx}, line ${line.lineNumber} (${line.procedureCode}): ${fm(line.chargeCents)} charged − ` +
          `${fm(line.paidCents)} paid ≠ ${fm(adjusted)} adjusted.`,
        id,
      );
    }
  }
  if (claim.lines.length > 0) {
    const lineCharges = sumCents(claim.lines.map((l) => l.chargeCents));
    if (lineCharges !== claim.chargeCents) {
      throw new ReconciliationError(
        `${ctx}: service lines add up to ${fm(lineCharges)} but the claim says ${fm(claim.chargeCents)}.`,
        id,
      );
    }
    const linePaid = sumCents(claim.lines.map((l) => l.paidCents));
    if (lineAdjudicated && linePaid !== claim.paidCents) {
      throw new ReconciliationError(
        `${ctx}: line payments add up to ${fm(linePaid)} but the claim says ${fm(claim.paidCents)}.`,
        id,
      );
    }
  }

  const all = [...claim.claimAdjustments, ...claim.lines.flatMap((l) => l.adjustments)];
  const patientAdjustments = all.filter((a) => a.group === 'PR');
  const contractualCents = sumCents(all.filter((a) => a.group !== 'PR').map((a) => a.amountCents));
  const prTotal = sumCents(patientAdjustments.map((a) => a.amountCents));
  const byReason = (reason: string) =>
    sumCents(patientAdjustments.filter((a) => a.reason === reason).map((a) => a.amountCents));

  let patientOwesCents: Cents;
  if (selfPay) {
    // No insurance: the patient owes what's left after any self-pay discount.
    patientOwesCents = claim.patientResponsibilityCents;
    assertReconciles(
      {
        billedCents: claim.chargeCents,
        contractualCents,
        insurancePaidCents: claim.paidCents,
        patientOwesCents,
      },
      ctx,
      id,
    );
  } else {
    patientOwesCents = prTotal;
    assertReconciles(
      {
        billedCents: claim.chargeCents,
        contractualCents,
        insurancePaidCents: claim.paidCents,
        patientOwesCents,
      },
      ctx,
      id,
    );
    if (claim.patientResponsibilityCents !== prTotal) {
      throw new ReconciliationError(
        `${ctx} reports patient responsibility ${fm(claim.patientResponsibilityCents)} (CLP05) but its PR ` +
          `adjustments total ${fm(prTotal)}.`,
        id,
      );
    }
  }

  const deductibleCents = byReason('1');
  const coinsuranceCents = byReason('2');
  const copayCents = byReason('3');
  const otherCents = prTotal - deductibleCents - coinsuranceCents - copayCents;

  return {
    billedCents: claim.chargeCents,
    contractualCents,
    insurancePaidCents: claim.paidCents,
    patientOwesCents,
    denied: claim.denied,
    patientShare: {
      deductibleCents,
      coinsuranceCents,
      copayCents,
      otherCents,
      selfPayCents: patientOwesCents - prTotal,
    },
    adjustments: summarize(all),
  };
}
