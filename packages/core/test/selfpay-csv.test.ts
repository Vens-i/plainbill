import { describe, expect, it } from 'vitest';
import { parseCsv, parseSelfPayCsv, SelfPayCsvError } from '../src/selfpay-csv';

const CSV = `visit_id,patient_first,patient_last,dob,provider,visit_date,cpt,charge,self_pay_rate_applied
SP-0929-01,Kevin,Lam,1991-02-11,Dr. Kim,2026-09-29,99213,175.00,Y
SP-0929-01,Kevin,Lam,1991-02-11,Dr. Kim,2026-09-29,87880,100.00,Y
SP-0930-01,Ellen,Brooks,1978-07-30,"Patel, Anand",2026-09-30,99214,310,N
`;

describe('parseCsv', () => {
  it('handles quoted fields, escaped quotes, CRLF and a trailing newline', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
    ]);
  });

  it('rejects an unterminated quote', () => {
    expect(() => parseCsv('a,"b\n')).toThrow(/unterminated/);
  });
});

describe('parseSelfPayCsv', () => {
  const claims = parseSelfPayCsv(CSV, { fileName: 'selfpay_0929.csv' });

  it('groups line rows into one self-pay claim per visit', () => {
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({
      source: { kind: 'self-pay-csv', fileName: 'selfpay_0929.csv' },
      payer: { name: 'Self-pay' },
      patientControlNumber: 'SP-0929-01',
      claimStatusCode: 'SELF',
      denied: false,
      patient: { firstName: 'Kevin', lastName: 'Lam', dob: '1991-02-11' },
      renderingProvider: { lastName: 'Kim', firstName: '' },
      serviceDate: '2026-09-29',
      chargeCents: 27500,
      paidCents: 0,
      patientResponsibilityCents: 27500,
      selfPay: { rateApplied: true },
    });
    expect(claims[0]!.lines.map((l) => [l.procedureCode, l.chargeCents])).toEqual([
      ['99213', 17500],
      ['87880', 10000],
    ]);
  });

  it('reads provider names in either "Dr. Last" or "Last, First" form', () => {
    expect(claims[1]!.renderingProvider).toEqual({ lastName: 'Patel', firstName: 'Anand' });
    expect(claims[1]!.selfPay).toEqual({ rateApplied: false });
  });

  it('errors clearly on missing columns, bad money and inconsistent visit rows', () => {
    expect(() => parseSelfPayCsv('visit_id,patient_first\nA,B\n')).toThrow(
      /missing column "patient_last"/,
    );
    expect(() => parseSelfPayCsv(CSV.replace('175.00', '17.555'))).toThrow(SelfPayCsvError);
    expect(() => parseSelfPayCsv(CSV.replace('175.00', '17.555'))).toThrow(/Row 2.*charge/);
    expect(() => parseSelfPayCsv(CSV.replace('2026-09-29,87880', '2026-09-28,87880'))).toThrow(
      /SP-0929-01.*different visit_date/,
    );
    expect(() =>
      parseSelfPayCsv(
        CSV.replace('1991-02-11,Dr. Kim,2026-09-29,99213', '1991-02-31,Dr. Kim,2026-09-29,99213'),
      ),
    ).toThrow(/Row 2.*dob/);
  });
});
