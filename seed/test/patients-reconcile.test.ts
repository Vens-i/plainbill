/**
 * The Patients page against the dashboard: every patient's totals are summed again here, in
 * integer cents, from /api/balances, and the patients' "still owed" must add up to the
 * Outstanding KPI, before and after a live payment.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildApp,
  openDatabase,
  type BalanceRow,
  type Kpis,
  type PatientSummary,
} from '@plainbill/api';
import { loadSeed } from '../src/load';
import { SEED_TODAY } from '../src/spec';

let app: ReturnType<typeof buildApp>['app'];
let close: () => void;

beforeAll(async () => {
  const opened = openDatabase(':memory:');
  close = opened.close;
  await loadSeed(opened.db, { now: '2026-10-10T13:00:00.000Z' });
  app = buildApp({ db: opened.db, demoToday: SEED_TODAY, devRoutes: true }).app;
});
afterAll(async () => {
  await app.close();
  close();
});

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const OPEN = ['review', 'ready', 'sent', 'partial'];

async function snapshot() {
  const get = async <T>(url: string) => (await app.inject({ method: 'GET', url })).json() as T;
  const [patients, rows, kpis] = await Promise.all([
    get<PatientSummary[]>('/api/patients'),
    get<BalanceRow[]>('/api/balances'),
    get<Kpis>('/api/kpis'),
  ]);
  return { patients, rows, kpis };
}

function expectAllAgree({ patients, rows, kpis }: Awaited<ReturnType<typeof snapshot>>) {
  expect(sum(patients.map((p) => p.owedCents))).toBe(kpis.outstanding.cents);
  expect(patients.filter((p) => p.owedCents > 0)).toHaveLength(kpis.outstanding.patients);
  expect(sum(patients.map((p) => p.visitCount))).toBe(rows.length);

  for (const p of patients) {
    const mine = rows.filter((r) => r.patientId === p.patientId);
    const billable = mine.filter((r) => r.status !== 'denied');
    const open = mine.filter((r) => OPEN.includes(r.status) && r.remainingCents > 0);
    expect(p.visitCount).toBe(mine.length);
    expect(p.billedCents).toBe(sum(mine.map((r) => r.billedCents)));
    expect(p.patientShareCents).toBe(sum(billable.map((r) => r.patientResponsibilityCents)));
    expect(p.paidCents).toBe(sum(mine.map((r) => r.patientPaidCents)));
    expect(p.owedCents).toBe(sum(open.map((r) => r.remainingCents)));
    expect(p.oldestOpenDays).toBe(open.length ? Math.max(...open.map((r) => r.daysOut!)) : null);
    expect(sum(p.visits.map((v) => v.owedCents ?? 0))).toBe(p.owedCents);
    expect(sum(p.statuses.map((s) => s.count))).toBe(mine.length);
  }
}

describe('Patients page: totals reconcile with the dashboard', () => {
  it('lists the 14 seed patients with their own totals', async () => {
    const s = await snapshot();
    expect(s.patients).toHaveLength(14);
    expectAllAgree(s);

    const aisha = s.patients.find((p) => p.name === 'Aisha Bello')!;
    expect(aisha).toMatchObject({
      visitCount: 1,
      billedCents: 120_000,
      patientShareCents: 120_000,
      paidCents: 60_000,
      owedCents: 60_000,
      oldestOpenDays: 112,
      oldestOpenBucket: '90+',
      statuses: [{ status: 'partial', count: 1 }],
    });
    expect(aisha.lastActivity?.kind).toBe('payment');

    const maria = s.patients.find((p) => p.name === 'Maria Delgado')!;
    expect(maria).toMatchObject({ owedCents: 24_000, paidCents: 0, lastActivity: null });

    // Denied visits aren't billed to the patient: nothing owed, no share.
    const james = s.patients.find((p) => p.name === 'James Whitfield')!;
    expect(james).toMatchObject({ owedCents: 0, patientShareCents: 0, oldestOpenDays: null });
    expect(james.visits[0]).toMatchObject({ status: 'denied', owedCents: null });

    // No contact details on a list page.
    for (const key of ['dob', 'memberId', 'email', 'addressLine1', 'address'])
      expect(aisha).not.toHaveProperty(key);
  });

  it('searches by name', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/patients?q=bel' });
    expect((res.json() as PatientSummary[]).map((p) => p.name)).toEqual(['Aisha Bello']);
  });

  it('still agrees after Robert Chen pays, and shows the payment as his last activity', async () => {
    const before = await snapshot();
    const robert = before.rows.find((r) => r.patientName === 'Robert Chen')!;
    const res = await app.inject({ method: 'POST', url: `/api/dev/simulate-payment/${robert.id}` });
    expect(res.statusCode).toBe(200);

    const after = await snapshot();
    expectAllAgree(after);
    const p = after.patients.find((x) => x.name === 'Robert Chen')!;
    expect(p.owedCents).toBe(0);
    expect(p.lastActivity).toMatchObject({ kind: 'payment', label: 'Paid $150 via PayPal' });
    expect(after.kpis.outstanding.cents).toBe(before.kpis.outstanding.cents - 15_000);
  });
});
