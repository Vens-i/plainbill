/**
 * Every seed row, end to end: committed 835/CSV files → real parsers → balance math, checked
 * against the literal CLAUDE.md table, with the invariant asserted on each row.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  claimsFrom835,
  computePatientBalance,
  dollars,
  formatShortDate,
  parse835,
  parseSelfPayCsv,
  type NormalizedClaim,
} from '@plainbill/core';
import { EXPECTED_TABLE } from '../src/expected';
import { buildSeedFiles, DATA_DIR } from '../src/files';
import { VISITS } from '../src/spec';

const files = buildSeedFiles();

function parseCommittedFiles(): NormalizedClaim[] {
  return files.flatMap((f) => {
    const text = readFileSync(join(DATA_DIR, f.fileName), 'utf8');
    return f.kind === '835'
      ? claimsFrom835(text, { fileName: f.fileName })
      : parseSelfPayCsv(text, { fileName: f.fileName });
  });
}

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

describe('seed rows reconcile', () => {
  const claims = parseCommittedFiles();
  const byName = new Map(
    VISITS.map((v) => [
      `${v.patient.firstName} ${v.patient.lastName}`,
      { visit: v, claim: claims.find((c) => c.patientControlNumber === v.claimId) },
    ]),
  );

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
