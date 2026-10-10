/**
 * End-to-end: seed an in-memory database through the real parsers, then exercise the API the
 * dashboard uses — grid rows, group totals, KPIs, charts, and the live payment over SSE.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatMoneyShort, STATUS_ORDER, type BalanceStatus } from '@plainbill/core';
import {
  buildApp,
  openDatabase,
  type AgingChart,
  type BalanceRow,
  type DenialsChart,
  type Kpis,
  type PaymentEvent,
} from '@plainbill/api';
import { loadSeed } from '../src/load';
import { SEED_TODAY } from '../src/spec';

function setup() {
  const { db, close } = openDatabase(':memory:');
  loadSeed(db, { now: '2026-10-10T13:00:00.000Z' });
  const { app, bus } = buildApp({ db, demoToday: SEED_TODAY, devRoutes: true });
  return { db, close, app, bus };
}

describe('dashboard API on the seed world', () => {
  const ctx = setup();
  afterAll(async () => {
    await ctx.app.close();
    ctx.close();
  });

  const get = async <T>(url: string): Promise<T> => {
    const res = await ctx.app.inject({ method: 'GET', url });
    expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
    return res.json() as T;
  };

  it('GET /api/balances returns all 13 rows with line items', async () => {
    const rows = await get<BalanceRow[]>('/api/balances');
    expect(rows).toHaveLength(13);
    const maria = rows.find((r) => r.patientName === 'Maria Delgado')!;
    expect(maria).toMatchObject({
      status: 'ready',
      provider: 'Dr. Patel',
      sub: 'Dr. Patel',
      payerName: 'BlueCross BlueShield',
      billedCents: 85000,
      insurancePaidCents: 21000,
      owesCents: 24000,
      daysOut: 7,
      agingBucket: '0-30',
      aiSuggestion: 'Send invoice + 3-month plan',
      plan: { months: 3, regularCents: 8000, eligible: true },
    });
    expect(maria.lines).toEqual([
      {
        code: '99214',
        description: 'Office visit, established patient (30–39 min)',
        chargeCents: 35000,
      },
      { code: '80053', description: 'Blood work — metabolic panel', chargeCents: 18000 },
      { code: '93000', description: 'Heart rhythm test (ECG)', chargeCents: 32000 },
    ]);
    expect(maria.adjustments).toEqual([
      {
        code: 'CO-45',
        label: 'Insurance discount (contract rate)',
        amountCents: -40000,
        kind: 'writeoff',
      },
      { code: 'PAID', label: 'BlueCross BlueShield paid', amountCents: -21000, kind: 'payment' },
      { code: 'PR-1', label: 'Deductible — patient pays', amountCents: 20000, kind: 'patient' },
      { code: 'PR-2', label: "Coinsurance — patient's share", amountCents: 4000, kind: 'patient' },
    ]);
  });

  it('builds the sub-lines and days-out the design shows', async () => {
    const rows = await get<BalanceRow[]>('/api/balances');
    const by = (name: string) => rows.find((r) => r.patientName === name)!;
    expect(by('James Whitfield').sub).toBe('MRI · CO-197 prior auth missing');
    expect(by('Denise Okafor').sub).toBe('CO-16 · referral missing');
    expect(by('Grace Whitaker').sub).toBe('Opened 2× · not paid');
    expect(by('Robert Chen').sub).toBe('Not opened');
    expect(by('Aisha Bello').sub).toBe('$600 of $1,200 paid');
    expect(by('Kevin Lam').insurancePaidCents).toBeNull();
    expect(by('James Whitfield').owesCents).toBeNull();
    expect(by('Linda Park')).toMatchObject({
      owesCents: 10000,
      paidInDays: 6,
      daysOut: null,
      paidVia: 'PayPal',
    });
    expect(rows.map((r) => [r.patientName, r.daysOut])).toEqual([
      ['Maria Delgado', 7],
      ['Kevin Lam', 11],
      ['Priya Raman', 9],
      ['Tomás Herrera', 28],
      ['Ellen Brooks', 10],
      ['Marcus Reid', 46],
      ['James Whitfield', 22],
      ['Denise Okafor', 57],
      ['Grace Whitaker', 69],
      ['Robert Chen', 35],
      ['Aisha Bello', 112],
      ['Samuel Ortiz', 18],
      ['Linda Park', null],
    ]);
  });

  it('group totals match the design meta lines', async () => {
    const rows = await get<BalanceRow[]>('/api/balances');
    const group = (s: BalanceStatus) => rows.filter((r) => r.status === s);
    const sum = (rs: BalanceRow[], f: (r: BalanceRow) => number) =>
      formatMoneyShort(rs.reduce((t, r) => t + f(r), 0));
    expect(group('review').map((r) => r.patientName)).toEqual([
      'Priya Raman',
      'Tomás Herrera',
      'Ellen Brooks',
      'Marcus Reid',
    ]);
    expect(sum(group('review'), (r) => r.remainingCents)).toBe('$1,078');
    expect(sum(group('denied'), (r) => r.billedCents)).toBe('$3,010');
    expect(sum(group('ready'), (r) => r.remainingCents)).toBe('$515');
    expect(sum(group('sent'), (r) => r.remainingCents)).toBe('$480'); // $400 + Samuel's $80 until he pays
    expect(sum(group('partial'), (r) => r.remainingCents)).toBe('$600');
    expect(sum(group('paid'), (r) => r.patientPaidCents)).toBe('$100');
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(STATUS_ORDER));
  });

  it('GET /api/kpis is computed from the data', async () => {
    const kpis = await get<Kpis>('/api/kpis');
    expect(kpis).toEqual({
      today: '2026-10-10',
      outstanding: { cents: 107800 + 51500 + 48000 + 60000, patients: 10 },
      collectedThisMonth: {
        cents: 30000,
        previousCents: 10000,
        month: 'October',
        previousMonth: 'September',
      },
      avgDaysToPay: { days: 6, paidCount: 1, paperBaselineDays: 34 },
      review: { count: 4, cents: 107800, firstPatientName: 'Priya Raman', firstBalanceId: 3 },
      ready: { count: 2, cents: 51500 },
      todoMinutes: 5,
    });
  });

  it('GET /api/charts/aging buckets open patient balances', async () => {
    const chart = await get<AgingChart>('/api/charts/aging');
    expect(chart.buckets.map((b) => [b.label, b.cents])).toEqual([
      ['0–30', 24000 + 27500 + 16000 + 36800 + 31000 + 8000],
      ['31–60', 24000 + 15000],
      ['61–90', 25000],
      ['90+', 60000],
    ]);
    expect(chart.totalCents).toBe(chart.buckets.reduce((s, b) => s + b.cents, 0));
  });

  it('GET /api/charts/denials-by-payer counts denials in the last 90 days', async () => {
    const chart = await get<DenialsChart>('/api/charts/denials-by-payer');
    expect(chart).toEqual({
      windowDays: 90,
      total: 2,
      payers: [
        { payerId: 'BCBS', payer: 'BlueCross BlueShield', shortName: 'BlueCross', count: 1 },
        { payerId: 'UHC', payer: 'UnitedHealthcare', shortName: 'UnitedHealth', count: 1 },
        { payerId: 'AETNA', payer: 'Aetna', shortName: 'Aetna', count: 0 },
      ],
      mostCommon: { code: 'CO-197', label: 'Prior authorization missing', count: 1 },
    });
  });

  it('refuses to simulate a payment on a balance that cannot be paid', async () => {
    const rows = await get<BalanceRow[]>('/api/balances');
    const james = rows.find((r) => r.patientName === 'James Whitfield')!;
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/dev/simulate-payment/${james.id}`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'invalid_transition' });
  });
});

describe('live payment over Server-Sent Events', () => {
  const ctx = setup();
  let base = '';
  beforeAll(async () => {
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await ctx.app.close();
    ctx.close();
  });

  it('simulating Samuel Ortiz’s payment moves him to Paid and pushes a payment event', async () => {
    const controller = new AbortController();
    const stream = await fetch(`${base}/api/events`, { signal: controller.signal });
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();

    const nextEvent = async (): Promise<{ event: string; data: string }> => {
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error('stream closed');
        buffer += decoder.decode(value, { stream: true });
        for (const block of buffer.split('\n\n')) {
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (event && data) return { event, data };
        }
      }
    };

    const rows = (await (await fetch(`${base}/api/balances`)).json()) as BalanceRow[];
    const samuel = rows.find((r) => r.patientName === 'Samuel Ortiz')!;
    expect(samuel.status).toBe('sent');

    const pending = nextEvent();
    const res = await fetch(`${base}/api/dev/simulate-payment/${samuel.id}`, { method: 'POST' });
    expect(res.status).toBe(200);

    const { event, data } = await pending;
    controller.abort();
    expect(event).toBe('payment');
    const payload = JSON.parse(data) as PaymentEvent;
    expect(payload.payment).toMatchObject({
      amountCents: 8000,
      method: 'paypal',
      source: 'simulated',
    });
    expect(payload.balance).toMatchObject({
      id: samuel.id,
      status: 'paid',
      owesCents: 8000,
      remainingCents: 0,
      paidInDays: 18,
      paidVia: 'PayPal',
      daysOut: null,
    });
    expect(Date.now() - Date.parse(payload.balance.paidAt!)).toBeLessThan(10_000);

    // The paid group now matches the design: 2 visits · $180 collected.
    const after = (await (await fetch(`${base}/api/balances`)).json()) as BalanceRow[];
    const paid = after.filter((r) => r.status === 'paid');
    expect(paid.map((r) => r.patientName)).toEqual(['Samuel Ortiz', 'Linda Park']);
    expect(paid.reduce((s, r) => s + r.patientPaidCents, 0)).toBe(18000);

    const kpis = (await (await fetch(`${base}/api/kpis`)).json()) as Kpis;
    expect(kpis.collectedThisMonth.cents).toBe(38000);
    expect(kpis.avgDaysToPay.days).toBe(12);

    // Paying twice is refused by the status machine.
    const again = await fetch(`${base}/api/dev/simulate-payment/${samuel.id}`, { method: 'POST' });
    expect(again.status).toBe(409);
  });
});
