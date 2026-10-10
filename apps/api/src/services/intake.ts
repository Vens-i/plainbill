/**
 * Intake: uploaded 835s, EOB PDFs and self-pay CSVs are staged here, previewed with their AI
 * flags, and only become balances when staff approve them.
 *
 * 835 and CSV files are parsed by code (no flags). EOB PDFs go through an EobExtractor and
 * `eobToClaims`, which flags uncertain fields and checks each reading against the core math.
 * Approving an item with open flags lands it as "Needs review"; everything else lands "Ready".
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  displayFieldValue,
  eobToClaims,
  reviewSummary,
  sha256,
  withFieldValue,
  type EobExtraction,
  type EobExtractor,
  type ExtractionFlag,
} from '@plainbill/ai';
import {
  claimsFrom835,
  computePatientBalance,
  normalizePayer,
  parseSelfPayCsv,
  planOption,
  titleCase,
  X12ParseError,
  SelfPayCsvError,
  type NormalizedClaim,
} from '@plainbill/core';
import type { IntakeBatchView, IntakeFileView, IntakeItemView, IntakeKind } from '../contract';
import type { Db, DbLike } from '../db/client';
import {
  intakeBatches,
  intakeFiles,
  intakeItems,
  patients,
  visits,
  type IntakeResolution,
} from '../db/schema';
import { ingestClaim, type PatientRecord } from './ingest';

export class IntakeError extends Error {
  override name = 'IntakeError';
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function detectKind(fileName: string, bytes: Uint8Array): IntakeKind {
  const lower = fileName.toLowerCase();
  const head = Buffer.from(bytes.subarray(0, 8)).toString('latin1');
  if (head.startsWith('%PDF')) return 'eob';
  if (
    head
      .replace(/^\uFEFF/, '')
      .trimStart()
      .startsWith('ISA')
  )
    return '835';
  if (lower.endsWith('.csv')) return 'self-pay-csv';
  if (lower.endsWith('.pdf')) return 'eob';
  if (/\.(835|edi|txt|x12)$/.test(lower)) return '835';
  throw new IntakeError(
    `Can't tell what kind of file ${fileName} is. Upload an 835 (.835/.txt), an EOB (.pdf) or a self-pay summary (.csv).`,
  );
}

export function getOpenBatch(db: DbLike, practiceId: number) {
  return db
    .select()
    .from(intakeBatches)
    .where(and(eq(intakeBatches.practiceId, practiceId), eq(intakeBatches.status, 'open')))
    .orderBy(asc(intakeBatches.id))
    .get();
}

export function getOrCreateOpenBatch(db: DbLike, practiceId: number): number {
  const open = getOpenBatch(db, practiceId);
  if (open) return open.id;
  return db
    .insert(intakeBatches)
    .values({ practiceId, status: 'open' })
    .returning({ id: intakeBatches.id })
    .get().id;
}

function isDuplicate(db: DbLike, practiceId: number, claim: NormalizedClaim): boolean {
  const payerId = normalizePayer(claim.payer.name).id;
  return !!db
    .select({ id: visits.id })
    .from(visits)
    .where(
      and(
        eq(visits.practiceId, practiceId),
        eq(visits.payerId, payerId),
        eq(visits.claimId, claim.patientControlNumber),
      ),
    )
    .get();
}

/** Single-claim view of a multi-claim extraction, so item paths are always "claims.0.…". */
function singleClaim(extraction: EobExtraction, index: number): EobExtraction {
  return { ...extraction, claims: [extraction.claims[index]!] };
}

export interface AddFileInput {
  fileName: string;
  bytes: Uint8Array;
}

/** Parse or extract one uploaded file into the batch. Re-adding the same file is a no-op. */
export async function addFileToBatch(
  db: Db,
  extractor: EobExtractor,
  batchId: number,
  practiceId: number,
  input: AddFileInput,
  now = new Date().toISOString(),
): Promise<void> {
  const digest = sha256(input.bytes);
  const existing = db
    .select()
    .from(intakeFiles)
    .where(and(eq(intakeFiles.batchId, batchId), eq(intakeFiles.sha256, digest)))
    .get();
  if (existing) return;

  const kind = detectKind(input.fileName, input.bytes);
  let claims: NormalizedClaim[] = [];
  let extraction: EobExtraction | null = null;
  let error: string | null = null;
  let reader: string | null = null;
  try {
    if (kind === '835') {
      claims = claimsFrom835(Buffer.from(input.bytes).toString('utf8'), {
        fileName: input.fileName,
      });
    } else if (kind === 'self-pay-csv') {
      claims = parseSelfPayCsv(Buffer.from(input.bytes).toString('utf8'), {
        fileName: input.fileName,
      });
    } else {
      const result = await extractor.extract(input.bytes, input.fileName);
      reader = result.reader;
      extraction = result.extraction;
      if (extraction.document_kind === 'not_an_eob')
        error = "This PDF doesn't look like an Explanation of Benefits.";
      else if (extraction.claims.length === 0) error = 'No claims found on this EOB.';
    }
  } catch (err) {
    if (
      err instanceof X12ParseError ||
      err instanceof SelfPayCsvError ||
      (err as Error).name === 'AiExtractionError'
    ) {
      error = (err as Error).message;
    } else {
      throw err;
    }
  }

  db.transaction((tx) => {
    const fileId = tx
      .insert(intakeFiles)
      .values({
        batchId,
        fileName: input.fileName,
        kind,
        sha256: digest,
        sizeBytes: input.bytes.length,
        status: error ? 'error' : 'parsed',
        error,
        reader,
      })
      .returning({ id: intakeFiles.id })
      .get().id;
    if (error) return;

    const base = { batchId, fileId, kind, resolutions: [], updatedAt: now };
    if (extraction) {
      extraction.claims.forEach((_, i) => {
        const single = singleClaim(extraction, i);
        const [built] = eobToClaims(single, { fileName: input.fileName });
        const duplicate = built?.claim ? isDuplicate(tx, practiceId, built.claim) : false;
        tx.insert(intakeItems)
          .values({
            ...base,
            claim: null,
            extraction: single,
            status: duplicate ? 'duplicate' : 'pending',
          })
          .run();
      });
    } else {
      for (const claim of claims) {
        tx.insert(intakeItems)
          .values({
            ...base,
            claim,
            extraction: null,
            status: isDuplicate(tx, practiceId, claim) ? 'duplicate' : 'pending',
          })
          .run();
      }
    }
  });
}

type ItemRow = typeof intakeItems.$inferSelect;

interface BuiltItem {
  claim: NormalizedClaim | null;
  flags: ExtractionFlag[];
  error: string | null;
}

function buildItem(item: ItemRow, fileName: string): BuiltItem {
  if (item.extraction) {
    const [r] = eobToClaims(item.extraction, { fileName });
    return {
      claim: r?.claim ?? null,
      flags: r?.flags ?? [],
      error: r?.error ?? 'No claim in this extraction.',
    };
  }
  try {
    computePatientBalance(item.claim!);
    return { claim: item.claim, flags: [], error: null };
  } catch (err) {
    return { claim: null, flags: [], error: (err as Error).message };
  }
}

const SHORT_LABELS: Record<string, string> = {
  'CO-45': 'Insurance discount',
  'PR-1': 'Deductible',
  'PR-2': 'Coinsurance',
  'PR-3': 'Copay',
};

function summarizeAdjustments(claim: NormalizedClaim): string {
  if (claim.source.kind === 'self-pay-csv') {
    return claim.selfPay?.rateApplied ? 'Self-pay rate applied' : 'Self-pay rate not applied yet';
  }
  const balance = computePatientBalance(claim);
  const labels = balance.adjustments.map(
    (a) => SHORT_LABELS[a.code] ?? a.label.split(' — ')[0]!.replace(/ \(.*\)$/, ''),
  );
  return (claim.denied ? ['Denied', ...labels] : labels).join(' · ');
}

function displayName(
  db: DbLike,
  practiceId: number,
  claim: NormalizedClaim | null,
  extraction: EobExtraction | null,
): string {
  const first = claim?.patient.firstName ?? extraction?.claims[0]?.patient_first_name.value ?? '';
  const last = claim?.patient.lastName ?? extraction?.claims[0]?.patient_last_name.value ?? '';
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
  const match = db
    .select()
    .from(patients)
    .where(eq(patients.practiceId, practiceId))
    .all()
    .find((p) => fold(p.firstName) === fold(first) && fold(p.lastName) === fold(last));
  return match ? `${match.firstName} ${match.lastName}` : titleCase(`${first} ${last}`);
}

const SOURCE_PREFIX: Record<IntakeKind, string> = {
  '835': '835',
  eob: 'EOB',
  'self-pay-csv': 'Self-pay',
};

export function itemView(
  db: DbLike,
  practiceId: number,
  item: ItemRow,
  fileName: string,
): IntakeItemView {
  const built = buildItem(item, fileName);
  const claim = built.claim;
  const balance = claim ? computePatientBalance(claim) : null;
  const ex = item.extraction?.claims[0];
  const payerName = normalizePayer(
    claim?.payer.name ?? item.extraction?.payer_name.value ?? '',
  ).name;
  const selfPay = item.kind === 'self-pay-csv';
  return {
    id: item.id,
    fileId: item.fileId,
    fileName,
    kind: item.kind,
    sourceLabel: `${SOURCE_PREFIX[item.kind]} · ${fileName.replace(/\.[^.]+$/, '')}`,
    claimId: claim?.patientControlNumber ?? ex?.patient_account_number.value ?? '',
    patientName: displayName(db, practiceId, claim, item.extraction),
    visitDate: claim?.serviceDate ?? ex?.service_date.value ?? null,
    payerName,
    billedCents: balance?.billedCents ?? null,
    insurancePaidCents: selfPay ? null : (balance?.insurancePaidCents ?? null),
    owesCents: balance ? (balance.denied ? null : balance.patientOwesCents) : null,
    adjustmentsSummary: claim ? summarizeAdjustments(claim) : '',
    flags: built.flags,
    resolved: item.resolutions.map(({ path, label, from, to }) => ({ path, label, from, to })),
    reconciles: claim !== null,
    error: built.error,
    status: item.status,
    balanceId: item.balanceId,
  };
}

export function batchView(db: DbLike, practiceId: number, batchId: number): IntakeBatchView {
  const batch = db.select().from(intakeBatches).where(eq(intakeBatches.id, batchId)).get();
  if (!batch) throw new IntakeError('No such intake batch.', 404);
  const files = db
    .select()
    .from(intakeFiles)
    .where(eq(intakeFiles.batchId, batchId))
    .orderBy(asc(intakeFiles.id))
    .all();
  const items = db
    .select()
    .from(intakeItems)
    .where(eq(intakeItems.batchId, batchId))
    .orderBy(asc(intakeItems.id))
    .all();
  const fileName = new Map(files.map((f) => [f.id, f.fileName]));
  const views = items.map((i) => itemView(db, practiceId, i, fileName.get(i.fileId)!));
  const pending = views.filter((v) => v.status === 'pending');
  return {
    id: batch.id,
    status: batch.status,
    files: files.map((f): IntakeFileView => ({
      id: f.id,
      fileName: f.fileName,
      kind: f.kind,
      status: f.status,
      error: f.error,
      visitCount: items.filter((i) => i.fileId === f.id).length,
      reader: f.reader,
    })),
    items: views,
    openFlagCount: pending.reduce((n, v) => n + v.flags.length, 0),
    approvableCount: pending.filter((v) => v.reconciles).length,
  };
}

function loadItem(db: DbLike, itemId: number) {
  const item = db.select().from(intakeItems).where(eq(intakeItems.id, itemId)).get();
  if (!item) throw new IntakeError('No such intake item.', 404);
  const file = db.select().from(intakeFiles).where(eq(intakeFiles.id, item.fileId)).get()!;
  return { item, fileName: file.fileName };
}

/**
 * Staff confirm or change a flagged field. The value must be one of the readings on offer or a
 * value they typed; the claim is rebuilt and re-checked either way.
 */
export function resolveFlag(
  db: DbLike,
  itemId: number,
  path: string,
  value: string,
  now = new Date().toISOString(),
): ItemRow {
  const { item, fileName } = loadItem(db, itemId);
  if (!item.extraction) throw new IntakeError('Only EOB items have fields to confirm.');
  if (item.status === 'discarded') throw new IntakeError('This item was discarded.', 409);
  const flag = buildItem(item, fileName).flags.find((f) => f.path === path);
  // A field staff already resolved can be changed again (a mis-click shouldn't stick).
  const previous = [...item.resolutions].reverse().find((r) => r.path === path);
  if (!flag && !previous) throw new IntakeError(`Nothing to confirm at ${path}.`, 409);
  const extraction = withFieldValue(item.extraction, path, value.trim());
  const options = flag ? [flag.current, ...flag.alternatives] : [];
  const resolution: IntakeResolution = {
    path,
    label: flag?.label ?? previous!.label,
    from: flag?.current.display ?? previous!.to,
    to:
      options.find((o) => o.value === value.trim())?.display ??
      displayFieldValue(extraction, path, value.trim()),
    at: now,
  };
  db.update(intakeItems)
    .set({ extraction, resolutions: [...item.resolutions, resolution], updatedAt: now })
    .where(eq(intakeItems.id, itemId))
    .run();
  return db.select().from(intakeItems).where(eq(intakeItems.id, itemId)).get()!;
}

export interface ApproveItemOptions {
  practiceId: number;
  now?: string;
  /** Registry data for the patient (seed). Defaults to an existing patient or the claim's name. */
  patient?: PatientRecord;
  /** Used when the item has no open flags (e.g. the seed's static suggestions). */
  aiSuggestion?: string | null;
  reviewReason?: string | null;
}

/** Bills of this size or more get a payment plan suggested alongside the invoice. */
const PLAN_SUGGESTION_MIN_CENTS = 20000;

/**
 * Rule-based next step for a new balance with nothing to review (a placeholder until
 * packages/ai drafts suggestions).
 */
function suggestForReady(claim: NormalizedClaim): string | null {
  const balance = computePatientBalance(claim);
  if (balance.denied || balance.patientOwesCents === 0) return null;
  return balance.patientOwesCents >= PLAN_SUGGESTION_MIN_CENTS &&
    planOption(balance.patientOwesCents, 3).eligible
    ? 'Send invoice + 3-month plan'
    : 'Send invoice';
}

/** Turn one pending item into a balance: "Needs review" if flags are open, else "Ready". */
export function approveItem(db: Db, itemId: number, options: ApproveItemOptions) {
  const { item, fileName } = loadItem(db, itemId);
  if (item.status !== 'pending') throw new IntakeError(`This item is ${item.status}.`, 409);
  const built = buildItem(item, fileName);
  if (!built.claim) throw new IntakeError(built.error ?? "This claim doesn't add up yet.", 422);
  const summary = reviewSummary(built.flags);
  const result = ingestClaim(db, {
    practiceId: options.practiceId,
    claim: built.claim,
    ...(options.patient ? { patient: options.patient } : {}),
    needsReview: summary !== null || Boolean(options.reviewReason),
    reviewReason: summary?.reviewReason ?? options.reviewReason ?? null,
    aiSuggestion:
      summary?.aiSuggestion ??
      (options.aiSuggestion !== undefined ? options.aiSuggestion : suggestForReady(built.claim)),
    ...(options.now ? { now: options.now } : {}),
  });
  db.update(intakeItems)
    .set({
      status: 'approved',
      balanceId: result.balanceId,
      updatedAt: options.now ?? new Date().toISOString(),
    })
    .where(eq(intakeItems.id, itemId))
    .run();
  return result;
}

/** Approve every pending item that adds up; report the rest. Closes the batch when nothing is left. */
export function approveBatch(
  db: Db,
  batchId: number,
  practiceId: number,
  now = new Date().toISOString(),
) {
  const pending = db
    .select()
    .from(intakeItems)
    .where(and(eq(intakeItems.batchId, batchId), eq(intakeItems.status, 'pending')))
    .orderBy(asc(intakeItems.id))
    .all();
  const approved: Array<{
    itemId: number;
    balanceId: number;
    status: ReturnType<typeof approveItem>['status'];
  }> = [];
  const skipped: Array<{ itemId: number; reason: string }> = [];
  for (const item of pending) {
    try {
      const r = approveItem(db, item.id, { practiceId, now });
      approved.push({ itemId: item.id, balanceId: r.balanceId, status: r.status });
    } catch (err) {
      if (err instanceof IntakeError) skipped.push({ itemId: item.id, reason: err.message });
      else throw err;
    }
  }
  if (skipped.length === 0) closeBatch(db, batchId, 'approved', now);
  return { approved, skipped };
}

export function closeBatch(
  db: DbLike,
  batchId: number,
  status: 'approved' | 'discarded',
  now = new Date().toISOString(),
): void {
  db.update(intakeBatches)
    .set({ status, closedAt: now })
    .where(eq(intakeBatches.id, batchId))
    .run();
}

export function discardBatch(db: Db, batchId: number, now = new Date().toISOString()): void {
  db.transaction((tx) => {
    tx.update(intakeItems)
      .set({ status: 'discarded', updatedAt: now })
      .where(
        and(
          eq(intakeItems.batchId, batchId),
          inArray(intakeItems.status, ['pending', 'duplicate']),
        ),
      )
      .run();
    tx.update(intakeBatches)
      .set({ status: 'discarded', closedAt: now })
      .where(eq(intakeBatches.id, batchId))
      .run();
  });
}

/** The intake item a balance came from, if any (for resolving its flags from the dashboard). */
export function itemForBalance(db: DbLike, balanceId: number) {
  const item = db.select().from(intakeItems).where(eq(intakeItems.balanceId, balanceId)).get();
  if (!item) return null;
  const file = db.select().from(intakeFiles).where(eq(intakeFiles.id, item.fileId)).get()!;
  return { item, fileName: file.fileName, built: buildItem(item, file.fileName) };
}
