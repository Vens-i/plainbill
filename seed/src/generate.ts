/**
 * Regenerate seed/data from spec.ts. The output is committed so the raw EDI is reviewable;
 * a test fails if the committed files drift from the spec.
 *
 *   pnpm seed:generate
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSeedFiles, DATA_DIR } from './files';

mkdirSync(DATA_DIR, { recursive: true });
for (const file of buildSeedFiles()) {
  writeFileSync(join(DATA_DIR, file.fileName), file.content);
  console.log(`wrote seed/data/${file.fileName}`);
}
