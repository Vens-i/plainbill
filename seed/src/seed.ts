/**
 *   pnpm seed
 *
 * Resets the SQLite database (rows only, so a running API keeps working) and loads the
 * Harborview seed world through the real 835/CSV parsers.
 */
import { loadConfig, openDatabase } from '@plainbill/api';
import { formatSummary, loadSeed } from './load';
import { DEMO_PAYMENT_KEY, SEED_TODAY, VISITS } from './spec';

const config = loadConfig();
const { db, close } = openDatabase(config.databasePath);
try {
  const rows = loadSeed(db);
  const demo = rows[VISITS.findIndex((v) => v.key === DEMO_PAYMENT_KEY)]!;
  console.log(`Seeded ${rows.length} balances into ${config.databasePath}\n`);
  console.log(formatSummary(rows));
  console.log(
    `\nSeed "today" is ${SEED_TODAY}; the API uses ${config.demoToday ?? 'the real date'} (DEMO_TODAY).`,
  );
  if (config.demoToday !== SEED_TODAY) {
    console.log(
      `Tip: set DEMO_TODAY=${SEED_TODAY} in .env so days-out and aging match the design.`,
    );
  }
  console.log(
    `Rehearse the live payment: pnpm simulate:payment "${demo.patient}"   (balance ${demo.id})`,
  );
} finally {
  close();
}
