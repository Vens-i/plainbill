/**
 * Load the seed world into a database. Nothing is inserted as pre-computed JSON: 835s and CSVs go
 * through the real parsers, EOB PDFs through the recorded Claude extractions and `eobToClaims`,
 * and everything is stored by the same ingest / intake / invoice / payment services the API uses.
 *
 * Scenarios:
 *   full         all 13 visits; the Intake demo files are staged and approved like an upload, so
 *                Priya's and Tomás's review reasons come from real AI flags
 *   intake-demo  the 5 visits in the Intake demo files are left out, to be uploaded live
 */
import { eobToClaims, RecordedEobExtractor, type EobExtractor } from '@plainbill/ai';
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
  addFileToBatch,
  approveItem,
  batchView,
  closeBatch,
  getBalanceRows,
  getOrCreateOpenBatch,
  ingestClaim,
  markInvoiceSent,
  newPayToken,
  recordPayment,
  resetDatabase,
  schema,
  type Db,
} from '@plainbill/api';
import { allSeedFileNames, readSeedFile, RECORDINGS_DIR } from './files';
import { INTAKE_DEMO_FILES, PRACTICE, SEED_TODAY, VISITS, type SeedVisit } from './spec';

export type SeedScenario = 'full' | 'intake-demo';

export interface SeedSummaryRow {
  id: number;
  patient: string;
  status: BalanceStatus;
  owes: string;
  source: string;
}

/** The input file a visit arrives in. */
export function sourceFileOf(visit: SeedVisit): string {
  if (visit.insurance?.era) return `${visit.insurance.era}.835`;
  if (visit.insurance?.eob) return `${visit.insurance.eob.file}.pdf`;
  return `${visit.selfPay!.csv}.csv`;
}

/** Every claim in the seed files, read with the real parsers (EOBs via recorded extractions). */
export async function readSeedClaims(
  extractor: EobExtractor = new RecordedEobExtractor(RECORDINGS_DIR),
): Promise<NormalizedClaim[]> {
  const claims: NormalizedClaim[] = [];
  for (const { fileName, kind } of allSeedFileNames()) {
    const bytes = readSeedFile(fileName);
    if (kind === '835') claims.push(...claimsFrom835(bytes.toString('utf8'), { fileName }));
    else if (kind === 'self-pay-csv')
      claims.push(...parseSelfPayCsv(bytes.toString('utf8'), { fileName }));
    else {
      const { extraction } = await extractor.extract(bytes, fileName);
      for (const r of eobToClaims(extraction, { fileName })) {
        if (!r.claim) throw new Error(`${fileName}: ${r.error}`);
        claims.push(r.claim);
      }
    }
  }
  return claims;
}

export interface LoadSeedOptions {
  now?: string;
  scenario?: SeedScenario;
  extractor?: EobExtractor;
}

export async function loadSeed(db: Db, options: LoadSeedOptions = {}): Promise<SeedSummaryRow[]> {
  const now = options.now ?? new Date().toISOString();
  const scenario = options.scenario ?? 'full';
  const extractor = options.extractor ?? new RecordedEobExtractor(RECORDINGS_DIR);
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
      hours: PRACTICE.hours,
      npi: PRACTICE.npi,
      paperBaselineDays: PRACTICE.paperBaselineDays,
      staffName: PRACTICE.user.name,
      staffFirstName: PRACTICE.user.firstName,
      staffInitials: PRACTICE.user.initials,
    })
    .returning({ id: schema.practices.id })
    .get().id;

  // The practice already knows its patients (names with accents, DOB, email) — remittances
  // arrive for people in its registry.
  for (const v of VISITS) {
    db.insert(schema.patients)
      .values({
        practiceId,
        firstName: v.patient.firstName,
        lastName: v.patient.lastName,
        dob: v.patient.dob,
        email: v.patient.email,
        memberId: v.patient.memberId ?? null,
      })
      .run();
  }

  // Full scenario: the Intake demo files arrive like an upload and are approved.
  let batchId: number | null = null;
  if (scenario === 'full') {
    batchId = getOrCreateOpenBatch(db, practiceId);
    for (const fileName of INTAKE_DEMO_FILES) {
      await addFileToBatch(
        db,
        extractor,
        batchId,
        practiceId,
        { fileName, bytes: readSeedFile(fileName) },
        now,
      );
    }
  }

  const directClaims = (await readSeedClaims(extractor)).filter(
    (c) => !INTAKE_DEMO_FILES.includes(c.source.fileName ?? ''),
  );
  const seeded: SeedVisit[] = [];

  for (const visit of VISITS) {
    const fromIntake = INTAKE_DEMO_FILES.includes(sourceFileOf(visit));
    if (fromIntake && scenario === 'intake-demo') continue;
    const patient = {
      firstName: visit.patient.firstName,
      lastName: visit.patient.lastName,
      dob: visit.patient.dob,
      email: visit.patient.email,
      ...(visit.patient.memberId ? { memberId: visit.patient.memberId } : {}),
    };

    let balanceId: number;
    if (fromIntake) {
      const item = batchView(db, practiceId, batchId!).items.find(
        (i) => i.claimId === visit.claimId,
      );
      if (!item) throw new Error(`No intake item for ${visit.claimId} (${visit.key}).`);
      balanceId = approveItem(db, item.id, {
        practiceId,
        now,
        patient,
        aiSuggestion: visit.aiSuggestion,
        reviewReason: visit.reviewReason ?? null,
      }).balanceId;
    } else {
      const claim = directClaims.find((c) => c.patientControlNumber === visit.claimId);
      if (!claim) throw new Error(`No claim ${visit.claimId} (${visit.key}) in the seed files.`);
      balanceId = ingestClaim(db, {
        practiceId,
        claim,
        patient,
        needsReview: Boolean(visit.reviewReason),
        reviewReason: visit.reviewReason ?? null,
        aiSuggestion: visit.aiSuggestion,
        now,
      }).balanceId;
    }

    if (visit.invoice) {
      markInvoiceSent(db, balanceId, {
        sentOn: visit.invoice.sentOn,
        openCount: visit.invoice.openCount,
        // Seeded invoices predate PayPal; their patients pay on the Plainbill page.
        payToken: newPayToken(),
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
    seeded.push(visit);
  }

  if (batchId !== null) closeBatch(db, batchId, 'approved', now);

  const rows = getBalanceRows(db, SEED_TODAY);
  rows.forEach((row, i) => {
    const expected = seeded[i]!.status;
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
