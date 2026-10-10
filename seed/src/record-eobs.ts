/**
 * Read the synthetic EOB PDFs with Claude, save the extractions as recordings (keyed by the PDF's
 * SHA-256), and check them against the ground truth in spec.ts. Uses ANTHROPIC_API_KEY and
 * ANTHROPIC_MODEL from .env; costs a few cents per run.
 *
 *   pnpm ai:record              record (overwrites existing recordings)
 *   pnpm ai:record --dry-run    extract and check only
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '@plainbill/api';
import {
  ClaudeEobExtractor,
  createClaudeClient,
  eobToClaims,
  resolveModel,
  sha256,
  type EobRecording,
} from '@plainbill/ai';
import { computePatientBalance, dollars, formatMoney } from '@plainbill/core';
import { readSeedFile, RECORDINGS_DIR } from './files';
import { EOBS, VISITS } from './spec';

loadConfig(); // loads the repo-root .env
const dryRun = process.argv.includes('--dry-run');
const model = resolveModel(process.env);
const extractor = new ClaudeEobExtractor({ client: createClaudeClient(), model });
mkdirSync(RECORDINGS_DIR, { recursive: true });

let problems = 0;
for (const fileKey of Object.keys(EOBS)) {
  const fileName = `${fileKey}.pdf`;
  const visit = VISITS.find((v) => v.insurance?.eob?.file === fileKey)!;
  const pdf = readSeedFile(fileName);
  const started = Date.now();
  const { extraction, raw } = await extractor.extract(pdf, fileName);
  console.log(`\n${fileName} — ${model}, ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const [result] = eobToClaims(extraction, { fileName });
  for (const f of result?.flags ?? []) {
    const alts = f.alternatives.map((a) => `${a.display}${a.reconciles ? ' ✓' : ' ✗'}`).join(', ');
    console.log(
      `  flag ${f.path}: ${f.current.display}${f.current.reconciles ? ' ✓' : ' ✗'}` +
        `${alts ? ` | alternatives ${alts}` : ''} | confidence ${f.confidence} | ${f.note ?? ''}`,
    );
  }

  const expectedFlag =
    visit.insurance!.eob!.obscure === 'insurance_paid'
      ? /\.insurance_paid$/
      : /\.adjustments\.\d+\.(reason|group)_code$/;
  if (!result?.flags.some((f) => expectedFlag.test(f.path))) {
    problems++;
    console.log(`  ✗ expected a flag on ${visit.insurance!.eob!.obscure}, got none`);
  }
  if (!result?.claim) {
    problems++;
    console.log(`  ✗ the model's best reading does not reconcile: ${result?.error}`);
  } else {
    const b = computePatientBalance(result.claim);
    const want = {
      billed: visit.lines.reduce((s, l) => s + dollars(l.charge), 0),
      paid: dollars(visit.insurance!.paid),
    };
    const ok =
      b.billedCents === want.billed &&
      b.insurancePaidCents === want.paid &&
      result.claim.patientControlNumber === visit.claimId;
    if (!ok) problems++;
    console.log(
      `  ${ok ? '✓' : '✗'} ${result.claim.patientControlNumber}: billed ${formatMoney(b.billedCents)}, paid ${formatMoney(b.insurancePaidCents)}, owes ${formatMoney(b.patientOwesCents)}`,
    );
  }

  if (!dryRun) {
    const recording: EobRecording = {
      fileName,
      sha256: sha256(pdf),
      model,
      recordedAt: new Date().toISOString(),
      output: raw,
    };
    writeFileSync(
      join(RECORDINGS_DIR, `${recording.sha256}.json`),
      JSON.stringify(recording, null, 2) + '\n',
    );
    console.log(`  recorded seed/data/eob-recordings/${recording.sha256.slice(0, 12)}….json`);
  }
}

console.log(
  problems
    ? `\n${problems} problem(s) — see above.`
    : '\nAll EOB extractions match the ground truth and raise the expected flags.',
);
process.exit(problems ? 1 : 0);
