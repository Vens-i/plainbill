/**
 *   pnpm seed                          all 13 visits
 *   pnpm seed --scenario=intake-demo   leave out the Intake demo files' 5 visits (upload them live)
 *   pnpm seed --if-empty               only when the database has no data yet (hosted demo start)
 *
 * Resets the SQLite database (rows only, so a running API keeps working) and loads the
 * Harborview seed world through the real parsers.
 */
import { loadConfig, openDatabase, schema } from '@plainbill/api';
import { formatSummary, loadSeed, type SeedScenario } from './load';
import { DEMO_PAYMENT_KEY, INTAKE_DEMO_FILES, SEED_TODAY, VISITS } from './spec';

const arg = process.argv.find((a) => a.startsWith('--scenario='))?.split('=')[1];
if (arg && arg !== 'full' && arg !== 'intake-demo') {
  console.error(`Unknown scenario "${arg}". Use --scenario=full or --scenario=intake-demo.`);
  process.exit(1);
}
const scenario: SeedScenario = arg === 'intake-demo' ? 'intake-demo' : 'full';

const config = loadConfig();
const { db, close } = openDatabase(config.databasePath);
if (process.argv.includes('--if-empty') && db.select().from(schema.practices).get()) {
  console.log(`Database already has data (${config.databasePath}); not seeding.`);
  close();
  process.exit(0);
}
try {
  const rows = await loadSeed(db, { scenario });
  console.log(`Seeded ${rows.length} balances (${scenario}) into ${config.databasePath}\n`);
  console.log(formatSummary(rows));
  console.log(
    `\nSeed "today" is ${SEED_TODAY}; the API uses ${config.demoToday ?? 'the real date'} (DEMO_TODAY).`,
  );
  if (config.demoToday !== SEED_TODAY) {
    console.log(
      `Tip: set DEMO_TODAY=${SEED_TODAY} in .env so days-out and aging match the design.`,
    );
  }
  if (scenario === 'intake-demo') {
    console.log(
      `\nIntake demo: upload ${INTAKE_DEMO_FILES.join(', ')} from seed/data on the Intake page.`,
    );
  } else {
    const demoName = `${VISITS.find((v) => v.key === DEMO_PAYMENT_KEY)!.patient.firstName} ${VISITS.find((v) => v.key === DEMO_PAYMENT_KEY)!.patient.lastName}`;
    const demo = rows.find((r) => r.patient === demoName)!;
    console.log(
      `Rehearse the live payment: pnpm simulate:payment "${demo.patient}"   (balance ${demo.id})`,
    );
  }
} finally {
  close();
}
