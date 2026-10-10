/**
 * Load the seed world into a database by running the committed 835 and CSV files through the
 * real parsers and the same ingest/invoice/payment services the API uses. Nothing is inserted
 * as pre-computed JSON: if the parser or the balance math breaks, seeding fails.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  claimsFrom835,
  dollars,
  formatMoney,
  parseSelfPayCsv,
  STATUS_META,
  type BalanceStatus,
  type NormalizedClaim,
} from '@plainbill/core';
import {
  getBalanceRows,
  ingestClaim,
  markInvoiceSent,
  recordPayment,
  resetDatabase,
  schema,
  type Db,
} from '@plainbill/api';
import { buildSeedFiles, DATA_DIR } from './files';
import { PRACTICE, SEED_TODAY, VISITS } from './spec';

export interface SeedSummaryRow {
  id: number;
  patient: string;
  status: BalanceStatus;
  owes: string;
  source: string;
}

export function readSeedClaims(): NormalizedClaim[] {
  return buildSeedFiles().flatMap((f) => {
    const text = readFileSync(join(DATA_DIR, f.fileName), 'utf8');
    return f.kind === '835'
      ? claimsFrom835(text, { fileName: f.fileName })
      : parseSelfPayCsv(text, { fileName: f.fileName });
  });
}

export function loadSeed(db: Db, options: { now?: string } = {}): SeedSummaryRow[] {
  const now = options.now ?? new Date().toISOString();
  resetDatabase(db);

  const practiceId = db
    .insert(schema.practices)
    .values({
      name: PRACTICE.name,
      addressLine1: PRACTICE.addressLine1,
      addressLine2: PRACTICE.addressLine2,
      city: PRACTICE.city,
      state: PRACTICE.state,
      zip: PRACTICE.zip,
      phone: PRACTICE.phone,
      npi: PRACTICE.npi,
      paperBaselineDays: PRACTICE.paperBaselineDays,
      staffName: PRACTICE.user.name,
      staffFirstName: PRACTICE.user.firstName,
      staffInitials: PRACTICE.user.initials,
    })
    .returning({ id: schema.practices.id })
    .get().id;

  const claims = readSeedClaims();
  if (claims.length !== VISITS.length) {
    throw new Error(
      `Seed files contain ${claims.length} claims but spec.ts lists ${VISITS.length} visits.`,
    );
  }

  for (const visit of VISITS) {
    const claim = claims.find((c) => c.patientControlNumber === visit.claimId);
    if (!claim) throw new Error(`No claim ${visit.claimId} (${visit.key}) in the seed files.`);
    const { balanceId } = ingestClaim(db, {
      practiceId,
      claim,
      patient: {
        firstName: visit.patient.firstName,
        lastName: visit.patient.lastName,
        dob: visit.patient.dob,
        email: visit.patient.email,
        ...(visit.patient.memberId ? { memberId: visit.patient.memberId } : {}),
      },
      needsReview: Boolean(visit.reviewReason),
      reviewReason: visit.reviewReason ?? null,
      aiSuggestion: visit.aiSuggestion,
      now,
    });
    if (visit.invoice) {
      markInvoiceSent(db, balanceId, {
        sentOn: visit.invoice.sentOn,
        openCount: visit.invoice.openCount,
        now,
      });
    }
    for (const p of visit.payments ?? []) {
      recordPayment(db, balanceId, {
        amountCents: dollars(p.amount),
        method: p.method,
        source: 'seed',
        postedOn: p.on,
        receivedAt: `${p.on}T17:00:00.000Z`,
      });
    }
  }

  const rows = getBalanceRows(db, SEED_TODAY);
  rows.forEach((row, i) => {
    const expected = VISITS[i]!.status;
    if (row.status !== expected) {
      throw new Error(
        `${row.patientName} ended up "${row.status}" but spec.ts expects "${expected}".`,
      );
    }
  });
  return rows.map((r) => ({
    id: r.id,
    patient: r.patientName,
    status: r.status,
    owes: r.owesCents == null ? '—' : formatMoney(r.owesCents),
    source: r.sourceFile ?? '',
  }));
}

export function formatSummary(rows: SeedSummaryRow[]): string {
  return rows
    .map(
      (r) =>
        `  ${String(r.id).padStart(2)}  ${r.patient.padEnd(16)} ${STATUS_META[r.status].label.padEnd(17)} ${r.owes.padStart(9)}  ${r.source}`,
    )
    .join('\n');
}
