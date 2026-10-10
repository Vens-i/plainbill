import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema>;
/** A database handle or an open transaction: services accept either. */
export type DbLike = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');

/** Open (and migrate) a database. Pass ':memory:' for tests. */
export function openDatabase(path: string): { db: Db; close: () => void } {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS });
  return { db, close: () => sqlite.close() };
}

/** Delete every row (children first) so ids restart at 1. Used by the seed script. */
export function resetDatabase(db: Db): void {
  db.transaction((tx) => {
    for (const table of [
      schema.events,
      schema.webhookEvents,
      schema.emails,
      schema.payments,
      schema.paypalOrders,
      schema.paymentPlans,
      schema.invoices,
      schema.intakeItems,
      schema.intakeFiles,
      schema.intakeBatches,
      schema.balances,
      schema.adjustments,
      schema.claimLines,
      schema.visits,
      schema.patients,
      schema.practices,
    ]) {
      tx.delete(table).run();
    }
  });
}
