import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { openDatabase, type Db } from '../src/db/client';
import { practices } from '../src/db/schema';
import type { BalanceRow, IntakeResult } from '../src/contract';

/** One processed claim (Jordan Rivers) and one denial (Kai Morgan). Fictional. */
function remit({ paid = '62', controlNumber = '000000201' } = {}): string {
  const body = [
    'ST*835*0001',
    `BPR*C*${paid}*C*ACH*CCP*01*011000015*DA*0001234567*1512345678**01*021000021*DA*0009876543*20261009`,
    'TRN*1*EFT0000201*1512345678',
    'DTM*405*20261009',
    'N1*PR*AETNA',
    'REF*2U*AETNA60054',
    'N1*PE*HARBORVIEW FAMILY MEDICINE*XX*1999999984',
    'LX*1',
    `CLP*NEW-001*1*225*${paid}*73*12*AE1*11*1`,
    'NM1*QC*1*RIVERS*JORDAN****MI*W100',
    'NM1*82*1*PATEL*ANAND****XX*1999999992',
    'DTM*232*20261006',
    `SVC*HC:99213*225*${paid}**1`,
    'CAS*CO*45*90',
    'CAS*PR*1*50**2*23',
    'CLP*NEW-002*4*1800*0*0*12*AE2*11*1',
    'NM1*QC*1*MORGAN*KAI****MI*W200',
    'DTM*232*20260918',
    'SVC*HC:72148*1800*0**1',
    'CAS*CO*197*1800',
  ];
  return [
    `ISA*00*          *00*          *ZZ*AETNAERA       *ZZ*HARBORVIEWFM   *261009*0600*^*00501*${controlNumber}*0*T*:`,
    'GS*HP*AETNAERA*HARBORVIEWFM*20261009*0600*201*X*005010X221A1',
    ...body,
    `SE*${body.length + 1}*0001`,
    'GE*1*201',
    `IEA*1*${controlNumber}`,
  ]
    .map((s) => `${s}~`)
    .join('\n');
}

let db: Db;
let close: () => void;

function seedPractice() {
  db.insert(practices)
    .values({
      name: 'Harborview Family Medicine',
      addressLine1: '220 Harbor St',
      city: 'Harborview',
      state: 'CA',
      zip: '94000',
      phone: '(555) 014-2290',
      staffName: 'Rosa M.',
      staffFirstName: 'Rosa',
      staffInitials: 'RM',
    })
    .run();
}

beforeEach(() => {
  ({ db, close } = openDatabase(':memory:'));
});
afterEach(() => close());

describe('POST /api/intake/835', () => {
  it('parses, reconciles and stores each claim, then announces it over the event bus', async () => {
    seedPractice();
    const { app, bus } = buildApp({ db, demoToday: '2026-10-10' });
    const published: string[] = [];
    bus.subscribe(({ event }) => published.push(event.type));

    const res = await app.inject({
      method: 'POST',
      url: '/api/intake/835?fileName=aetna_era_1009.835',
      headers: { 'content-type': 'text/plain' },
      payload: remit(),
    });
    expect(res.statusCode).toBe(201);
    const result = res.json() as IntakeResult;
    expect(result.created).toEqual([
      {
        balanceId: 1,
        claimId: 'NEW-001',
        patientName: 'Jordan Rivers',
        status: 'ready',
        owesCents: 7300,
      },
      {
        balanceId: 2,
        claimId: 'NEW-002',
        patientName: 'Kai Morgan',
        status: 'denied',
        owesCents: 0,
      },
    ]);
    expect(published).toEqual(['balances.changed']);

    const rows = (await app.inject({ method: 'GET', url: '/api/balances' })).json() as BalanceRow[];
    expect(rows[0]).toMatchObject({
      sourceFile: 'aetna_era_1009.835',
      payerName: 'Aetna',
      provider: 'Dr. Patel',
      daysOut: 4,
    });
    expect(rows[1]).toMatchObject({ sub: 'MRI · CO-197 prior auth missing', owesCents: null });
  });

  it('skips claims that are already on file (re-uploading is safe)', async () => {
    seedPractice();
    const { app } = buildApp({ db });
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/api/intake/835',
        headers: { 'content-type': 'text/plain' },
        payload: remit(),
      });
    await send();
    const again = await send();
    expect(again.statusCode).toBe(200);
    expect((again.json() as IntakeResult).skipped.map((s) => s.claimId)).toEqual([
      'NEW-001',
      'NEW-002',
    ]);
  });

  it('rejects a file that does not reconcile, storing nothing', async () => {
    seedPractice();
    const { app } = buildApp({ db });
    // Claim says $72 paid but its adjustments were computed for $62.
    const bad = remit({ paid: '72' }).replace('CAS*CO*45*90', 'CAS*CO*45*90');
    const res = await app.inject({
      method: 'POST',
      url: '/api/intake/835',
      headers: { 'content-type': 'text/plain' },
      payload: bad,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'does_not_reconcile', claimId: 'NEW-001' });
    expect(res.json().message).toContain('$225.00 charged − $72.00 paid ≠ $163.00 adjusted');
    const rows = (await app.inject({ method: 'GET', url: '/api/balances' })).json() as BalanceRow[];
    expect(rows).toEqual([]);
  });

  it('rejects malformed EDI with a 400 that names the problem', async () => {
    seedPractice();
    const { app } = buildApp({ db });
    const res = await app.inject({
      method: 'POST',
      url: '/api/intake/835',
      headers: { 'content-type': 'text/plain' },
      payload: remit().replace('SE*', 'SE*9'),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_835' });
    expect(res.json().message).toMatch(/SE01 says 921 segments but the transaction has 21/);
  });
});

describe('guards', () => {
  it('answers 503 with a hint when the database has not been seeded', async () => {
    const { app } = buildApp({ db });
    const res = await app.inject({ method: 'GET', url: '/api/balances' });
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toContain('pnpm seed');
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });

  it('does not expose dev routes unless enabled', async () => {
    seedPractice();
    const { app } = buildApp({ db, devRoutes: false });
    const res = await app.inject({ method: 'POST', url: '/api/dev/simulate-payment/1' });
    expect(res.statusCode).toBe(404);
  });
});
