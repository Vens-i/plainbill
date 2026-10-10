/**
 * Self-pay visit summary CSV → NormalizedClaim. One row per service line; rows sharing a
 * visit_id form one visit. Columns:
 *
 *   visit_id, patient_first, patient_last, dob, provider, visit_date, cpt, charge, self_pay_rate_applied
 *
 * `provider` may be "Dr. Kim" or "Patel, Anand". `self_pay_rate_applied` is Y/N: whether the
 * charge already reflects the practice's self-pay rate (if not, the visit needs review).
 */
import { isIsoDate } from './dates';
import { parseDecimalToCents } from './money';
import type { NormalizedClaim, Person } from './types';

export class SelfPayCsvError extends Error {
  override name = 'SelfPayCsvError';
}

const COLUMNS = [
  'visit_id',
  'patient_first',
  'patient_last',
  'dob',
  'provider',
  'visit_date',
  'cpt',
  'charge',
  'self_pay_rate_applied',
] as const;

type Column = (typeof COLUMNS)[number];

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const src = text.replace(/^\uFEFF/, '');
  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += ch;
      }
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (ch === '\r' && src[i + 1] === '\n') i++;
    } else {
      field += ch;
    }
    i++;
  }
  if (quoted) throw new SelfPayCsvError('CSV has an unterminated quoted field.');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function parseProvider(raw: string): Person | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  if (text.includes(',')) {
    const [last = '', first = ''] = text.split(',').map((s) => s.trim());
    return { lastName: last, firstName: first };
  }
  const withoutTitle = text.replace(/^dr\.?\s+/i, '');
  const parts = withoutTitle.split(/\s+/);
  const lastName = parts.pop() ?? '';
  return { lastName, firstName: parts.join(' ') };
}

export function parseSelfPayCsv(
  text: string,
  options: { fileName?: string } = {},
): NormalizedClaim[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new SelfPayCsvError('CSV is empty.');
  const index = new Map(header.map((h, i) => [h.trim().toLowerCase(), i]));
  for (const col of COLUMNS) {
    if (!index.has(col)) throw new SelfPayCsvError(`Self-pay CSV is missing column "${col}".`);
  }

  const visits = new Map<string, { claim: NormalizedClaim; firstRow: Record<Column, string> }>();
  rows.forEach((cells, r) => {
    const rowNumber = r + 2; // header is row 1
    const get = (col: Column) => (cells[index.get(col)!] ?? '').trim();
    const record = Object.fromEntries(COLUMNS.map((c) => [c, get(c)])) as Record<Column, string>;
    const bad = (col: Column, why: string): never => {
      throw new SelfPayCsvError(
        `Row ${rowNumber}: ${col} ${why} (${JSON.stringify(record[col])}).`,
      );
    };

    for (const col of [
      'visit_id',
      'patient_first',
      'patient_last',
      'visit_date',
      'cpt',
      'charge',
    ] as const) {
      if (!record[col]) bad(col, 'is required');
    }
    if (!isIsoDate(record.visit_date)) bad('visit_date', 'must be a YYYY-MM-DD date');
    if (record.dob && !isIsoDate(record.dob)) bad('dob', 'must be a YYYY-MM-DD date');
    if (!/^[YN]$/i.test(record.self_pay_rate_applied))
      bad('self_pay_rate_applied', 'must be Y or N');
    let chargeCents: number;
    try {
      chargeCents = parseDecimalToCents(record.charge);
    } catch {
      return bad('charge', 'is not a valid amount');
    }
    if (chargeCents < 0) bad('charge', 'cannot be negative');

    const existing = visits.get(record.visit_id);
    if (existing) {
      for (const col of [
        'patient_first',
        'patient_last',
        'dob',
        'provider',
        'visit_date',
        'self_pay_rate_applied',
      ] as const) {
        if (existing.firstRow[col] !== record[col]) {
          throw new SelfPayCsvError(
            `Row ${rowNumber}: visit ${record.visit_id} has a different ${col} than its first row.`,
          );
        }
      }
    }
    const entry =
      existing ??
      (() => {
        const provider = parseProvider(record.provider);
        const claim: NormalizedClaim = {
          source: {
            kind: 'self-pay-csv',
            ...(options.fileName ? { fileName: options.fileName } : {}),
          },
          payer: { name: 'Self-pay' },
          patientControlNumber: record.visit_id,
          claimStatusCode: 'SELF',
          denied: false,
          patient: {
            firstName: record.patient_first,
            lastName: record.patient_last,
            ...(record.dob ? { dob: record.dob } : {}),
          },
          ...(provider ? { renderingProvider: provider } : {}),
          serviceDate: record.visit_date,
          chargeCents: 0,
          paidCents: 0,
          patientResponsibilityCents: 0,
          claimAdjustments: [],
          lines: [],
          remarks: [],
          selfPay: { rateApplied: record.self_pay_rate_applied.toUpperCase() === 'Y' },
        };
        const created = { claim, firstRow: record };
        visits.set(record.visit_id, created);
        return created;
      })();

    const claim = entry.claim;
    claim.lines.push({
      lineNumber: claim.lines.length + 1,
      codeQualifier: 'HC',
      procedureCode: record.cpt,
      modifiers: [],
      chargeCents,
      paidCents: 0,
      serviceDate: record.visit_date,
      adjustments: [],
      remarks: [],
    });
    claim.chargeCents += chargeCents;
    claim.patientResponsibilityCents += chargeCents;
  });

  return [...visits.values()].map((v) => v.claim);
}
