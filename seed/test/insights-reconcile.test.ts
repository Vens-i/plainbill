/**
 * Money accuracy across the three places a practice sees totals: the grid (/api/balances,
 * /api/kpis), Practice insights (/api/insights/data) and the money flow built from it. Every
 * figure is summed here in integer cents, independently of the code under test, and checked
 * again after a live payment.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, openDatabase, type BalanceRow, type InsightsData } from '@plainbill/api';
import { buildFlow, type FlowNodeId } from '../../apps/web/src/pages/insights/flow';
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

const cents = (dollars: number) => Math.round(dollars * 100);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

async function snapshot() {
  const get = async <T>(url: string) => (await app.inject({ method: 'GET', url })).json() as T;
  const data = await get<InsightsData>('/api/insights/data');
  const rows = await get<BalanceRow[]>('/api/balances');
  const kpis = await get<{ outstanding: { cents: number } }>('/api/kpis');
  const flow = buildFlow(data.balances);
  const node = (id: FlowNodeId) => flow.nodes.find((n) => n.id === id)?.cents ?? 0;
  return { data, rows, kpis, flow, node };
}

function expectAllAgree({ data, rows, kpis, node }: Awaited<ReturnType<typeof snapshot>>) {
  const open = rows.filter((r) => r.status !== 'denied');
  const stillOwed = sum(data.balances.map((b) => cents(b.stillOwed)));
  const collected = sum(data.payments.map((p) => cents(p.amount)));

  // Insights vs the grid.
  expect(stillOwed).toBe(sum(open.map((r) => r.remainingCents)));
  expect(stillOwed).toBe(kpis.outstanding.cents);
  expect(sum(data.balances.map((b) => cents(b.billed)))).toBe(sum(rows.map((r) => r.billedCents)));
  expect(data.balances.filter((b) => b.status === 'Denied')).toHaveLength(
    rows.filter((r) => r.status === 'denied').length,
  );
  // Payments are recorded with the balance update, so the two "collected" agree.
  expect(collected).toBe(sum(rows.map((r) => r.patientPaidCents)));

  // The flow vs the data.
  const billed = node('billed');
  expect(billed).toBe(sum(rows.map((r) => r.billedCents)));
  expect(node('discount') + node('denied') + node('insurance') + node('share')).toBe(billed);
  expect(node('collected')).toBe(collected);
  const buckets: Array<[FlowNodeId, string]> = [
    ['owed-0-30', '0–30 days'],
    ['owed-31-60', '31–60 days'],
    ['owed-61-90', '61–90 days'],
    ['owed-90', '90+ days'],
  ];
  for (const [id, aging] of buckets) {
    expect(node(id)).toBe(
      sum(data.balances.filter((b) => b.aging === aging).map((b) => cents(b.stillOwed))),
    );
  }
  expect(node('share')).toBe(node('collected') + sum(buckets.map(([id]) => node(id))));
}

describe('money accuracy: grid, insights and the money flow', () => {
  it('Theo Lambert matches the 835 by hand: $750 − $210 − $390 = $150', async () => {
    const { rows } = await snapshot();
    const theo = rows.find((r) => r.patientName === 'Theo Lambert')!;
    expect(theo).toMatchObject({
      billedCents: 75000,
      contractualCents: 21000,
      insurancePaidCents: 39000,
      patientResponsibilityCents: 15000,
    });
    // bcbs_era_0930.835: SVC*HC:99396*380*280 + CO-45 100 (no PR); SVC*HC:99213:25*220*0 +
    // CO-45 70 + PR-1 150; SVC*HC:80061*150*110 + CO-45 40.
    expect(theo.lines.map((l) => [l.code, l.chargeCents])).toEqual([
      ['99396', 38000],
      ['99213', 22000],
      ['80061', 15000],
    ]);
    expect(theo.splitVisit).toMatchObject({
      preventive: { code: '99396', chargeCents: 38000, paidCents: 28000 },
      problem: {
        code: '99213',
        chargeCents: 22000,
        paidCents: 0,
        patientShare: { deductibleCents: 15000, totalCents: 15000 },
      },
    });
  });

  it('agrees everywhere on the seed (billed $11,945; owed $2,823; collected $700)', async () => {
    const s = await snapshot();
    expectAllAgree(s);
    expect(s.node('billed')).toBe(1_194_500);
    expect(s.node('collected')).toBe(70_000);
    expect(s.kpis.outstanding.cents).toBe(282_300);
  });

  it('still agrees after Samuel Ortiz pays $80', async () => {
    const before = await snapshot();
    const samuel = before.rows.find((r) => r.patientName === 'Samuel Ortiz')!;
    const res = await app.inject({
      method: 'POST',
      url: `/api/dev/simulate-payment/${samuel.id}`,
    });
    expect(res.statusCode).toBe(200);
    const after = await snapshot();
    expectAllAgree(after);
    expect(after.node('collected') - before.node('collected')).toBe(8_000);
    expect(after.kpis.outstanding.cents).toBe(before.kpis.outstanding.cents - 8_000);
  });
});
