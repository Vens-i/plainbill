/**
 * Every seed row, end to end: committed 835/CSV files → real parsers, scanned EOB PDFs → recorded
 * Claude extractions → eobToClaims, then balance math — checked against the literal seed
 * table (expected.ts), with the invariant asserted on each row.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { eobToClaims, RecordedEobExtractor } from '@plainbill/ai';
import {
  computePatientBalance,
  detectSplitVisit,
  dollars,
  formatShortDate,
  parse835,
  type NormalizedClaim,
} from '@plainbill/core';
import { EXPECTED_TABLE } from '../src/expected';
import { buildSeedFiles, DATA_DIR, eobFileNames, readSeedFile, RECORDINGS_DIR } from '../src/files';
import { readSeedClaims } from '../src/load';
import { VISITS } from '../src/spec';

const files = buildSeedFiles();
const recorded = new RecordedEobExtractor(RECORDINGS_DIR);

describe('seed files', () => {
  it.each(files.map((f) => [f.fileName, f] as const))(
    '%s is up to date with spec.ts',
    (_name, file) => {
      const committed = readFileSync(join(DATA_DIR, file.fileName), 'utf8').replaceAll(
        '\r\n',
        '\n',
      );
      expect(committed, 'run `pnpm seed:generate`').toBe(file.content);
    },
  );

  it('835 files are well-formed and their BPR totals match the claims', () => {
    for (const f of files.filter((x) => x.kind === '835')) {
      const remit = parse835(f.content);
      const tx = remit.transactions[0]!;
      const paid = tx.claims.reduce((sum, c) => sum + c.paidCents, 0);
      expect(tx.payment.amountCents, f.fileName).toBe(paid);
      expect(remit.functionalGroup.version).toBe('005010X221A1');
    }
  });
});

describe('scanned EOBs', () => {
  it.each(eobFileNames().map((f) => [f]))(
    '%s has a recorded extraction for this exact PDF',
    (fileName) => {
      expect(recorded.has(readSeedFile(fileName)), 'run `pnpm ai:record`').toBe(true);
    },
  );

  it('flag the smudged spots, and only the true reading adds up for the paid amount', async () => {
    const priya = eobToClaims(
      (await recorded.extract(readSeedFile('aetna_eob_raman.pdf'), 'aetna_eob_raman.pdf'))
        .extraction,
      {
        fileName: 'aetna_eob_raman.pdf',
      },
    )[0]!;
    const paid = priya.flags.find((f) => f.path === 'claims.0.insurance_paid')!;
    expect(paid.current).toMatchObject({ value: '260.00', reconciles: true });
    expect(paid.alternatives.length).toBeGreaterThan(0);
    expect(paid.alternatives.every((a) => !a.reconciles)).toBe(true);

    const tomas = eobToClaims(
      (await recorded.extract(readSeedFile('uhc_eob_sept.pdf'), 'uhc_eob_sept.pdf')).extraction,
      {
        fileName: 'uhc_eob_sept.pdf',
      },
    )[0]!;
    const code = tomas.flags.find((f) => /adjustments\.\d+\.reason_code$/.test(f.path))!;
    expect(code.current.display).toBe('PR-3 → Copay');
    expect(code.alternatives.map((a) => a.display.split(' ')[0])).toContain('PR-2');
    expect([code.current, ...code.alternatives].every((o) => o.reconciles)).toBe(true);
  });
});

describe('seed rows reconcile', () => {
  let claims: NormalizedClaim[] = [];
  const byName = new Map<
    string,
    { visit: (typeof VISITS)[number]; claim: NormalizedClaim | undefined }
  >();
  beforeAll(async () => {
    claims = await readSeedClaims(recorded);
    for (const v of VISITS) {
      byName.set(`${v.patient.firstName} ${v.patient.lastName}`, {
        visit: v,
        claim: claims.find((c) => c.patientControlNumber === v.claimId),
      });
    }
  });

  it('produces exactly one claim per table row', () => {
    expect(claims).toHaveLength(EXPECTED_TABLE.length);
    expect(new Set(claims.map((c) => c.patientControlNumber)).size).toBe(EXPECTED_TABLE.length);
    expect([...byName.keys()]).toEqual(EXPECTED_TABLE.map((r) => r.patient));
  });

  it.each(EXPECTED_TABLE.map((row) => [row.patient, row] as const))('%s', (patient, row) => {
    const { visit, claim } = byName.get(patient)!;
    expect(claim, `no parsed claim for ${patient}`).toBeDefined();
    const b = computePatientBalance(claim!); // throws ReconciliationError if it doesn't reconcile

    // The invariant, stated explicitly for every row.
    expect(b.billedCents - b.contractualCents - b.insurancePaidCents).toBe(b.patientOwesCents);

    expect(formatShortDate(claim!.serviceDate)).toBe(row.visit);
    expect(b.billedCents).toBe(dollars(row.billed));
    expect(b.insurancePaidCents).toBe(dollars(row.insurancePaid ?? 0));
    expect(visit.status).toBe(
      row.status === 'paid' && visit.key === 'samuel' ? 'sent' : row.status,
    );

    if (row.status === 'denied') {
      // Table shows "–" for discount and owes: the denial is a full CO write-off.
      expect(claim!.denied).toBe(true);
      expect(b.patientOwesCents).toBe(0);
      expect(b.contractualCents).toBe(b.billedCents);
      expect(b.adjustments.some((a) => a.code === 'CO-45')).toBe(false);
    } else {
      expect(b.contractualCents).toBe(dollars(row.discount ?? 0));
      expect(b.patientOwesCents).toBe(dollars(row.owes!));
    }

    const paidByPatient = (visit.payments ?? []).reduce((s, p) => s + dollars(p.amount), 0);
    const remaining = b.patientOwesCents - paidByPatient;
    if (row.remaining !== undefined) expect(remaining).toBe(dollars(row.remaining));
    if (row.status === 'paid' && visit.key !== 'samuel') expect(remaining).toBe(0);
  });

  it('finds the split visit on Theo Lambert, and on no one else', () => {
    const split = [...byName].filter(([, { claim }]) => claim && detectSplitVisit(claim));
    expect(split.map(([name]) => name)).toEqual(['Theo Lambert']);
    const visit = detectSplitVisit(byName.get('Theo Lambert')!.claim!)!;
    expect(visit.preventive).toMatchObject({ code: '99396', paidCents: 28000 });
    expect(visit.problem).toMatchObject({
      code: '99213',
      chargeCents: 22000,
      patientShare: { deductibleCents: 15000, totalCents: 15000 },
    });
  });

  it('keeps the hero row exactly as designed', () => {
    const { claim } = byName.get('Maria Delgado')!;
    const b = computePatientBalance(claim!);
    expect(claim!.lines.map((l) => [l.procedureCode, l.chargeCents])).toEqual([
      ['99214', 35000],
      ['80053', 18000],
      ['93000', 32000],
    ]);
    expect(b.patientShare).toMatchObject({ deductibleCents: 20000, coinsuranceCents: 4000 });
    expect(b.adjustments.map((a) => [a.code, a.amountCents])).toEqual([
      ['CO-45', 40000],
      ['PR-1', 20000],
      ['PR-2', 4000],
    ]);
  });
});
