import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EOBS, ERAS, SELF_PAY_CSVS, VISITS } from './spec';
import { write835, writeSelfPayCsv } from './x12-writer';

export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
export const RECORDINGS_DIR = join(DATA_DIR, 'eob-recordings');

export type SeedFileKind = '835' | 'self-pay-csv' | 'eob';

export interface SeedFile {
  fileName: string;
  kind: SeedFileKind;
  content: string;
}

/** Every synthetic text input file (835s and CSVs), generated from spec.ts. */
export function buildSeedFiles(): SeedFile[] {
  const eraFiles = Object.entries(ERAS).map(([fileKey, era]) => {
    const visits = VISITS.filter((v) => v.insurance?.era === fileKey);
    if (visits.length === 0) throw new Error(`ERA ${fileKey} has no claims`);
    if (visits.some((v) => v.insurance!.payer !== era.payer)) {
      throw new Error(`ERA ${fileKey} mixes payers`);
    }
    return {
      fileName: `${fileKey}.835`,
      kind: '835' as const,
      content: write835({ fileKey, ...era, visits }),
    };
  });
  const csvFiles = SELF_PAY_CSVS.map((key) => {
    const visits = VISITS.filter((v) => v.selfPay?.csv === key);
    if (visits.length === 0) throw new Error(`CSV ${key} has no visits`);
    return {
      fileName: `${key}.csv`,
      kind: 'self-pay-csv' as const,
      content: writeSelfPayCsv(visits),
    };
  });
  return [...eraFiles, ...csvFiles];
}

/** Scanned EOB PDFs, one per entry in EOBS (rendered by `pnpm seed:generate`). */
export function eobFileNames(): string[] {
  return Object.keys(EOBS).map((key) => `${key}.pdf`);
}

/** Every input file the seed reads, in a stable order. */
export function allSeedFileNames(): Array<{ fileName: string; kind: SeedFileKind }> {
  return [
    ...buildSeedFiles().map((f) => ({ fileName: f.fileName, kind: f.kind })),
    ...eobFileNames().map((fileName) => ({ fileName, kind: 'eob' as const })),
  ];
}

export function readSeedFile(fileName: string): Buffer {
  return readFileSync(join(DATA_DIR, fileName));
}
