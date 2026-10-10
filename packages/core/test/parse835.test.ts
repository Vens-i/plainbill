import { describe, expect, it } from 'vitest';
import { parse835, X12ParseError } from '../src/x12/parse835';
import { HAND_WRITTEN_835, withAlternateDelimiters } from './fixtures/remit';

describe('parse835 — envelope and header', () => {
  const remit = parse835(HAND_WRITTEN_835, { fileName: 'acme_era_1008.835' });

  it('reads the ISA/GS envelope', () => {
    expect(remit.interchange).toEqual({
      senderId: 'ACMEHEALTH',
      receiverId: 'HARBORVIEWFM',
      controlNumber: '000000101',
      date: '2026-10-08',
      usage: 'T',
    });
    expect(remit.functionalGroup).toEqual({ controlNumber: '101', version: '005010X221A1' });
    expect(remit.transactions).toHaveLength(1);
  });

  it('reads BPR payment, TRN trace, production date, payer and payee', () => {
    const tx = remit.transactions[0]!;
    expect(tx.controlNumber).toBe('0001');
    expect(tx.payment).toEqual({
      handlingCode: 'C',
      amountCents: 16200,
      creditDebit: 'C',
      method: 'ACH',
      effectiveDate: '2026-10-08',
    });
    expect(tx.traceNumber).toBe('EFT0000101');
    expect(tx.productionDate).toBe('2026-10-08');
    expect(tx.payer).toEqual({ name: 'ACME HEALTH PLAN', id: 'ACME01' });
    expect(tx.payee).toEqual({ name: 'HARBORVIEW FAMILY MEDICINE', npi: '1999999984' });
    expect(tx.claims.map((c) => c.patientControlNumber)).toEqual([
      'TEST-001',
      'TEST-002',
      'TEST-003',
    ]);
  });
});

describe('parse835 — claims', () => {
  const [processed, denied, secondary] = parse835(HAND_WRITTEN_835, {
    fileName: 'acme_era_1008.835',
  }).transactions[0]!.claims;

  it('normalizes a processed claim with service lines and line-level CAS', () => {
    expect(processed).toMatchObject({
      source: {
        kind: '835',
        fileName: 'acme_era_1008.835',
        traceNumber: 'EFT0000101',
        paymentDate: '2026-10-08',
      },
      payer: { name: 'ACME HEALTH PLAN', id: 'ACME01' },
      patientControlNumber: 'TEST-001',
      payerClaimControlNumber: 'PAYERCLM0001',
      claimStatusCode: '1',
      denied: false,
      patient: { lastName: 'RIVERS', firstName: 'JORDAN', id: 'ACM100200300', idQualifier: 'MI' },
      renderingProvider: { lastName: 'PATEL', firstName: 'ANAND', id: '1999999992' },
      serviceDate: '2026-10-01',
      receivedDate: '2026-10-03',
      chargeCents: 22500,
      paidCents: 6200,
      patientResponsibilityCents: 7300,
      claimAdjustments: [],
    });
    expect(processed!.lines).toHaveLength(2);
    expect(processed!.lines[0]).toEqual({
      lineNumber: 1,
      codeQualifier: 'HC',
      procedureCode: '99213',
      modifiers: [],
      chargeCents: 20000,
      paidCents: 5000,
      allowedCents: 12000,
      units: 1,
      serviceDate: '2026-10-01',
      adjustments: [
        { group: 'CO', reason: '45', amountCents: 8000 },
        { group: 'PR', reason: '1', amountCents: 5000 },
        { group: 'PR', reason: '2', amountCents: 2000 },
      ],
      remarks: [],
    });
    expect(processed!.lines[1]!.adjustments).toEqual([
      { group: 'CO', reason: '45', amountCents: 1000 },
      { group: 'PR', reason: '2', amountCents: 300 },
    ]);
  });

  it('flags denied claims and keeps remark codes from MOA and LQ', () => {
    expect(denied).toMatchObject({
      claimStatusCode: '4',
      denied: true,
      chargeCents: 180000,
      paidCents: 0,
      patientResponsibilityCents: 0,
      remarks: ['M62'],
      serviceDate: '2026-09-18',
    });
    expect(denied!.renderingProvider).toBeUndefined();
    expect(denied!.lines[0]).toMatchObject({
      procedureCode: '72148',
      adjustments: [{ group: 'CO', reason: '197', amountCents: 180000 }],
      remarks: ['M62'],
    });
  });

  it('keeps claim-level CAS separate from line-level CAS', () => {
    expect(secondary).toMatchObject({
      claimStatusCode: '2',
      denied: false,
      lines: [],
      claimAdjustments: [
        { group: 'OA', reason: '23', amountCents: 16000 },
        { group: 'PR', reason: '2', amountCents: 4000 },
      ],
      serviceDate: '2026-09-20',
    });
  });
});

describe('parse835 — delimiters and whitespace', () => {
  it('reads separators from the ISA segment instead of assuming * : ~', () => {
    const remit = parse835(withAlternateDelimiters(HAND_WRITTEN_835));
    const claim = remit.transactions[0]!.claims[0]!;
    expect(claim.lines[0]!.procedureCode).toBe('99213');
    expect(claim.patientResponsibilityCents).toBe(7300);
  });

  it('tolerates a BOM, CRLF line breaks and a single-line file', () => {
    const crlf = '\uFEFF' + HAND_WRITTEN_835.replaceAll('\n', '\r\n');
    const singleLine = HAND_WRITTEN_835.replaceAll('\n', '');
    expect(parse835(crlf).transactions[0]!.claims).toHaveLength(3);
    expect(parse835(singleLine).transactions[0]!.claims).toHaveLength(3);
  });

  it('parses procedure modifiers from the SVC composite', () => {
    const edi = HAND_WRITTEN_835.replace('SVC*HC:36415*25', 'SVC*HC:36415:59:XU*25');
    const line = parse835(edi).transactions[0]!.claims[0]!.lines[1]!;
    expect(line.modifiers).toEqual(['59', 'XU']);
  });
});

describe('parse835 — clear errors on malformed input', () => {
  const expectParseError = (edi: string, message: RegExp) => {
    let caught: unknown;
    try {
      parse835(edi);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(X12ParseError);
    expect((caught as Error).message).toMatch(message);
  };

  it('rejects input that does not start with ISA', () => {
    expectParseError('GS*HP*X~', /must start with an ISA segment/);
  });

  it('rejects transactions that are not 835s', () => {
    expectParseError(HAND_WRITTEN_835.replace('ST*835*0001', 'ST*837*0001'), /not an 835/);
  });

  it('checks the SE segment count', () => {
    expectParseError(
      HAND_WRITTEN_835.replace('SE*44*0001', 'SE*40*0001'),
      /SE01 says 40 segments.*44/,
    );
  });

  it('checks control numbers between ST/SE, GS/GE and ISA/IEA', () => {
    expectParseError(HAND_WRITTEN_835.replace('SE*44*0001', 'SE*44*0002'), /SE02/);
    expectParseError(HAND_WRITTEN_835.replace('GE*1*101', 'GE*1*102'), /GE02/);
    expectParseError(HAND_WRITTEN_835.replace('IEA*1*000000101', 'IEA*1*000000999'), /IEA02/);
  });

  it('reports a missing trailer', () => {
    expectParseError(HAND_WRITTEN_835.replace(/IEA\*1\*000000101~$/, ''), /missing IEA/);
  });

  it('rejects sub-cent or non-numeric amounts with the segment position', () => {
    expectParseError(
      HAND_WRITTEN_835.replace('SVC*HC:99213*200*', 'SVC*HC:99213*200.123*'),
      /segment 23 \(SVC\)/,
    );
    expectParseError(HAND_WRITTEN_835.replace('CAS*CO*45*80~', 'CAS*CO*45*eighty~'), /CAS03/);
  });

  it('requires a patient name on every claim', () => {
    expectParseError(
      HAND_WRITTEN_835.replace('NM1*QC*1*NG*SAM****MI*ACM700800900~\n', '').replace(
        'SE*44',
        'SE*43',
      ),
      /TEST-003.*no patient \(NM1\*QC\)/,
    );
  });

  it('rejects unknown CAS group codes', () => {
    expectParseError(HAND_WRITTEN_835.replace('CAS*OA*23*160', 'CAS*XX*23*160'), /group code "XX"/);
  });

  it('rejects segments that belong inside a claim when no claim is open', () => {
    expectParseError(
      HAND_WRITTEN_835.replace('LX*1~', 'SVC*HC:99213*1*1~'),
      /SVC outside of a claim/,
    );
  });
});
