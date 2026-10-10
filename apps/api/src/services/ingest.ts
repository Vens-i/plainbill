/**
 * Persist a NormalizedClaim (from the 835 parser, the self-pay CSV, or later EOB extraction)
 * as patient + visit + lines + adjustments + balance. The balance figures always come from
 * @plainbill/core's computePatientBalance, which throws if the claim doesn't reconcile.
 */
import { and, eq, sql } from 'drizzle-orm';
import {
  computePatientBalance,
  initialStatus,
  normalizePayer,
  titleCase,
  type BalanceStatus,
  type NormalizedClaim,
} from '@plainbill/core';
import type { Db, DbLike } from '../db/client';
import { adjustments, balances, claimLines, patients, visits } from '../db/schema';

export interface PatientRecord {
  firstName: string;
  lastName: string;
  dob?: string;
  email?: string;
  memberId?: string;
}

export interface IngestOptions {
  practiceId: number;
  claim: NormalizedClaim;
  /** Registry data for the patient (proper casing, DOB, email). Defaults to the claim's NM1 name. */
  patient?: PatientRecord;
  needsReview?: boolean;
  reviewReason?: string | null;
  aiSuggestion?: string | null;
  now?: string;
}

export interface IngestResult {
  balanceId: number;
  visitId: number;
  patientId: number;
  status: BalanceStatus;
  patientOwesCents: number;
}

export class DuplicateClaimError extends Error {
  override name = 'DuplicateClaimError';
  constructor(readonly claimId: string) {
    super(`Claim ${claimId} from this payer is already on file.`);
  }
}

/** Accent- and case-insensitive name key ("Tomás" ≡ "TOMAS"). */
function nameKey(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

function findOrCreatePatient(db: DbLike, practiceId: number, record: PatientRecord): number {
  const candidates = db
    .select()
    .from(patients)
    .where(eq(patients.practiceId, practiceId))
    .all()
    .filter(
      (p) =>
        nameKey(p.lastName) === nameKey(record.lastName) &&
        nameKey(p.firstName) === nameKey(record.firstName) &&
        (!record.dob || !p.dob || p.dob === record.dob) &&
        (!record.memberId || !p.memberId || p.memberId === record.memberId),
    );
  const match = candidates[0];
  if (match) {
    const patch: Partial<typeof patients.$inferInsert> = {};
    if (!match.dob && record.dob) patch.dob = record.dob;
    if (!match.email && record.email) patch.email = record.email;
    if (!match.memberId && record.memberId) patch.memberId = record.memberId;
    if (Object.keys(patch).length)
      db.update(patients).set(patch).where(eq(patients.id, match.id)).run();
    return match.id;
  }
  return db
    .insert(patients)
    .values({
      practiceId,
      firstName: record.firstName,
      lastName: record.lastName,
      dob: record.dob ?? null,
      email: record.email ?? null,
      memberId: record.memberId ?? null,
    })
    .returning({ id: patients.id })
    .get().id;
}

export function ingestClaim(db: DbLike, options: IngestOptions): IngestResult {
  const { claim, practiceId } = options;
  const balance = computePatientBalance(claim);
  const payer = normalizePayer(claim.payer.name);
  const now = options.now ?? new Date().toISOString();

  return db.transaction((tx) => {
    const existing = tx
      .select({ id: visits.id })
      .from(visits)
      .where(
        and(
          eq(visits.practiceId, practiceId),
          eq(visits.payerId, payer.id),
          eq(visits.claimId, claim.patientControlNumber),
        ),
      )
      .get();
    if (existing) throw new DuplicateClaimError(claim.patientControlNumber);

    const record: PatientRecord = options.patient ?? {
      firstName: titleCase(claim.patient.firstName),
      lastName: titleCase(claim.patient.lastName),
      ...(claim.patient.dob ? { dob: claim.patient.dob } : {}),
      ...(claim.patient.id ? { memberId: claim.patient.id } : {}),
    };
    const patientId = findOrCreatePatient(tx, practiceId, record);

    const provider = claim.renderingProvider;
    const visitId = tx
      .insert(visits)
      .values({
        practiceId,
        patientId,
        serviceDate: claim.serviceDate,
        providerFirstName: provider ? titleCase(provider.firstName) || null : null,
        providerLastName: provider ? titleCase(provider.lastName) : null,
        providerNpi: provider?.idQualifier === 'XX' ? (provider.id ?? null) : null,
        payerId: payer.id,
        payerName: payer.name,
        payerShortName: payer.shortName,
        payerKind: payer.kind,
        sourceKind: claim.source.kind,
        sourceFile: claim.source.fileName ?? null,
        claimId: claim.patientControlNumber,
        payerClaimNumber: claim.payerClaimControlNumber ?? null,
        claimStatusCode: claim.claimStatusCode,
        denied: claim.denied,
        remarks: claim.remarks,
        traceNumber: claim.source.traceNumber ?? null,
        paymentDate: claim.source.paymentDate ?? null,
        receivedDate: claim.receivedDate ?? null,
        billedCents: claim.chargeCents,
        insurancePaidCents: claim.paidCents,
        reportedPatientResponsibilityCents: claim.patientResponsibilityCents,
        selfPayRateApplied: claim.selfPay ? claim.selfPay.rateApplied : null,
      })
      .returning({ id: visits.id })
      .get().id;

    insertClaimDetail(tx, visitId, claim);

    const status = initialStatus({
      denied: balance.denied,
      patientOwesCents: balance.patientOwesCents,
      needsReview: options.needsReview ?? false,
    });
    const balanceId = tx
      .insert(balances)
      .values({
        visitId,
        status,
        billedCents: balance.billedCents,
        contractualCents: balance.contractualCents,
        insurancePaidCents: balance.insurancePaidCents,
        patientResponsibilityCents: balance.patientOwesCents,
        deductibleCents: balance.patientShare.deductibleCents,
        coinsuranceCents: balance.patientShare.coinsuranceCents,
        copayCents: balance.patientShare.copayCents,
        otherPatientCents: balance.patientShare.otherCents,
        selfPayCents: balance.patientShare.selfPayCents,
        patientPaidCents: 0,
        reviewReason: options.reviewReason ?? null,
        aiSuggestion: options.aiSuggestion ?? null,
        paidOn: status === 'paid' ? (claim.source.paymentDate ?? claim.serviceDate) : null,
        updatedAt: now,
      })
      .returning({ id: balances.id })
      .get().id;

    return { balanceId, visitId, patientId, status, patientOwesCents: balance.patientOwesCents };
  });
}

/** Lines and adjustments (claim- and line-level) for a visit. */
function insertClaimDetail(tx: DbLike, visitId: number, claim: NormalizedClaim): void {
  for (const adj of claim.claimAdjustments) {
    tx.insert(adjustments)
      .values({
        visitId,
        claimLineId: null,
        groupCode: adj.group,
        reasonCode: adj.reason,
        amountCents: adj.amountCents,
        quantity: adj.quantity ?? null,
      })
      .run();
  }
  for (const line of claim.lines) {
    const lineId = tx
      .insert(claimLines)
      .values({
        visitId,
        lineNumber: line.lineNumber,
        codeQualifier: line.codeQualifier,
        procedureCode: line.procedureCode,
        modifiers: line.modifiers,
        chargeCents: line.chargeCents,
        paidCents: line.paidCents,
        allowedCents: line.allowedCents ?? null,
        units: line.units ?? null,
        serviceDate: line.serviceDate ?? null,
        remarks: line.remarks,
      })
      .returning({ id: claimLines.id })
      .get().id;
    for (const adj of line.adjustments) {
      tx.insert(adjustments)
        .values({
          visitId,
          claimLineId: lineId,
          groupCode: adj.group,
          reasonCode: adj.reason,
          amountCents: adj.amountCents,
          quantity: adj.quantity ?? null,
        })
        .run();
    }
  }
}

/**
 * Replace a balance's claim figures after staff corrected an extracted field. Only allowed
 * before any patient payment; the new claim is reconciled by core first.
 */
export function replaceVisitClaim(
  db: Db,
  balanceId: number,
  claim: NormalizedClaim,
  now = new Date().toISOString(),
): void {
  const balance = computePatientBalance(claim);
  db.transaction((tx) => {
    const current = tx.select().from(balances).where(eq(balances.id, balanceId)).get();
    if (!current) throw new Error(`Balance ${balanceId} does not exist.`);
    if (current.patientPaidCents > 0)
      throw new Error('A balance with patient payments cannot be re-adjudicated.');
    tx.delete(adjustments).where(eq(adjustments.visitId, current.visitId)).run();
    tx.delete(claimLines).where(eq(claimLines.visitId, current.visitId)).run();
    insertClaimDetail(tx, current.visitId, claim);
    tx.update(visits)
      .set({
        serviceDate: claim.serviceDate,
        claimStatusCode: claim.claimStatusCode,
        denied: claim.denied,
        remarks: claim.remarks,
        billedCents: claim.chargeCents,
        insurancePaidCents: claim.paidCents,
        reportedPatientResponsibilityCents: claim.patientResponsibilityCents,
      })
      .where(eq(visits.id, current.visitId))
      .run();
    tx.update(balances)
      .set({
        billedCents: balance.billedCents,
        contractualCents: balance.contractualCents,
        insurancePaidCents: balance.insurancePaidCents,
        patientResponsibilityCents: balance.patientOwesCents,
        deductibleCents: balance.patientShare.deductibleCents,
        coinsuranceCents: balance.patientShare.coinsuranceCents,
        copayCents: balance.patientShare.copayCents,
        otherPatientCents: balance.patientShare.otherCents,
        selfPayCents: balance.patientShare.selfPayCents,
        updatedAt: now,
      })
      .where(eq(balances.id, balanceId))
      .run();
  });
}

/** Count of balances, for health checks and the seed summary. */
export function countBalances(db: Db): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(balances)
      .get()?.n ?? 0
  );
}
