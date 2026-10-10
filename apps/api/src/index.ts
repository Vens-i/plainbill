/** Public surface used by the seed script and tests. */
export {
  buildApp,
  offlineAi,
  DEFAULT_RECORDINGS_DIR,
  DEFAULT_SAMPLE_DIR,
  type AppOptions,
} from './app';
export { openDatabase, resetDatabase, type Db, type DbLike } from './db/client';
export * as schema from './db/schema';
export { loadConfig, REPO_ROOT, type Config } from './env';
export { EventBus } from './events';
export { getBalanceRows } from './queries/rows';
export {
  ingestClaim,
  DuplicateClaimError,
  type IngestOptions,
  type PatientRecord,
} from './services/ingest';
export { markInvoiceSent, recordPayment, PaymentError } from './services/payments';
export {
  addFileToBatch,
  approveBatch,
  approveItem,
  batchView,
  closeBatch,
  getOrCreateOpenBatch,
  IntakeError,
} from './services/intake';
export type { AiServices } from './routes/context';
export type * from './contract';
