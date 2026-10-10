import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERAS, SELF_PAY_CSV, VISITS } from './spec';
import { write835, writeSelfPayCsv } from './x12-writer';

export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

export interface SeedFile {
  fileName: string;
  kind: '835' | 'self-pay-csv';
  content: string;
}

/** Every synthetic input file, generated from spec.ts. */
export function buildSeedFiles(): SeedFile[] {
  const eraFiles = Object.entries(ERAS).map(([fileKey, era]) => {
    const visits = VISITS.filter((v) => v.insurance?.era === fileKey);
    if (visits.length === 0) throw new Error(`ERA ${fileKey} has no claims`);
    if (visits.some((v) => v.insurance!.payer !== era.payer))
      throw new Error(`ERA ${fileKey} mixes payers`);
    return {
      fileName: `${fileKey}.835`,
      kind: '835' as const,
      content: write835({ fileKey, ...era, visits }),
    };
  });
  const csv: SeedFile = {
    fileName: SELF_PAY_CSV,
    kind: 'self-pay-csv',
    content: writeSelfPayCsv(VISITS.filter((v) => v.selfPay)),
  };
  return [...eraFiles, csv];
}
