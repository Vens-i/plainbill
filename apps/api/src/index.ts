/** Public surface used by the seed script and tests. */
export { buildApp, type AppOptions } from './app';
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
export type * from './contract';
