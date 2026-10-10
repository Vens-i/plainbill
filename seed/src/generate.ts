/**
 * Regenerate seed/data from spec.ts: 835 ERAs, self-pay CSVs and scanned EOB PDFs. The output is
 * committed so the raw inputs are reviewable; a test fails if the text files drift from the spec.
 *
 *   pnpm seed:generate           text files only (fast, no canvas)
 *   pnpm seed:generate --pdfs    also re-render the EOB PDFs (then run `pnpm ai:record`)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSeedFiles, DATA_DIR } from './files';
import { EOBS, VISITS } from './spec';

mkdirSync(DATA_DIR, { recursive: true });
for (const file of buildSeedFiles()) {
  writeFileSync(join(DATA_DIR, file.fileName), file.content);
  console.log(`wrote seed/data/${file.fileName}`);
}

if (process.argv.includes('--pdfs')) {
  const { renderEobPdf } = await import('./eob-pdf');
  for (const [fileKey, eob] of Object.entries(EOBS)) {
    const visit = VISITS.find((v) => v.insurance?.eob?.file === fileKey);
    if (!visit) throw new Error(`No visit uses EOB ${fileKey}`);
    const bytes = await renderEobPdf({ fileKey, visit, statementDate: eob.date });
    writeFileSync(join(DATA_DIR, `${fileKey}.pdf`), bytes);
    console.log(`wrote seed/data/${fileKey}.pdf (${Math.round(bytes.length / 1024)} KB)`);
  }
  console.log('EOB PDFs changed: run `pnpm ai:record` to refresh the recorded extractions.');
}
