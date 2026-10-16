/**
 * Phase 2 end to end on the intake-demo seed: upload the four design files, see the AI flags,
 * confirm one, approve, resolve the other from the dashboard, then draft and send Maria's bill.
 * Uses recorded EOB extractions and template messages (offline, deterministic).
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildApp,
  openDatabase,
  type BalanceRow,
  type DrawerData,
  type IntakeApproveResult,
  type IntakeBatchView,
  type SendResult,
} from '@plainbill/api';
import { readSeedFile } from '../src/files';
import { loadSeed } from '../src/load';
import { INTAKE_DEMO_FILES, SEED_TODAY } from '../src/spec';

let base = '';
let close: () => void;
let stop: () => Promise<void>;
const published: string[] = [];

beforeAll(async () => {
  const db = openDatabase(':memory:');
  close = db.close;
  await loadSeed(db.db, { scenario: 'intake-demo', now: '2026-10-10T13:00:00.000Z' });
  const { app, bus } = buildApp({ db: db.db, demoToday: SEED_TODAY, devRoutes: true });
  bus.subscribe(({ event }) => published.push(event.type));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api`;
  stop = () => app.close();
});
afterAll(async () => {
  await stop();
  close();
});

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const res = await fetch(`${base}${path}`, {
    method,
    ...(body instanceof FormData
      ? { body }
      : body !== undefined
        ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
        : {}),
  });
  return { status: res.status, json: (await res.json()) as T };
}

function upload(fileNames: string[]): FormData {
  const form = new FormData();
  for (const name of fileNames) form.append('files', new Blob([readSeedFile(name)]), name);
  return form;
}

const byPatient = (batch: IntakeBatchView, name: string) =>
  batch.items.find((i) => i.patientName === name)!;
const rows = async () => (await call<BalanceRow[]>('GET', '/balances')).json;

describe('Intake → dashboard → Review & Send', () => {
  let batch: IntakeBatchView;

  it('starts with no open batch and 9 rows on the dashboard', async () => {
    expect((await call<{ batch: null }>('GET', '/intake/batch')).json.batch).toBeNull();
    expect(await rows()).toHaveLength(9);
  });

  it('reads the four files into 5 visits with 2 fields flagged', async () => {
    const { status, json } = await call<{ batch: IntakeBatchView }>(
      'POST',
      '/intake/files',
      upload(INTAKE_DEMO_FILES),
    );
    expect(status).toBe(200);
    batch = json.batch;
    expect(batch.files.map((f) => [f.fileName, f.kind, f.visitCount, f.status])).toEqual([
      ['bcbs_era_1008.835', '835', 2, 'parsed'],
      ['aetna_eob_raman.pdf', 'eob', 1, 'parsed'],
      ['uhc_eob_sept.pdf', 'eob', 1, 'parsed'],
      ['selfpay_0929.csv', 'self-pay-csv', 1, 'parsed'],
    ]);
    expect(batch.items.map((i) => i.patientName)).toEqual([
      'Maria Delgado',
      'Samuel Ortiz',
      'Priya Raman',
      'Tomás Herrera',
      'Kevin Lam',
    ]);
    expect(batch.openFlagCount).toBe(2);
    expect(batch.approvableCount).toBe(5);

    expect(byPatient(batch, 'Maria Delgado')).toMatchObject({
      sourceLabel: '835 · bcbs_era_1008',
      payerName: 'BlueCross BlueShield',
      billedCents: 85000,
      insurancePaidCents: 21000,
      owesCents: 24000,
      adjustmentsSummary: 'Insurance discount · Deductible · Coinsurance',
      flags: [],
    });
    expect(byPatient(batch, 'Kevin Lam')).toMatchObject({
      insurancePaidCents: null,
      adjustmentsSummary: 'Self-pay rate applied',
    });
    const priya = byPatient(batch, 'Priya Raman');
    expect(priya).toMatchObject({
      sourceLabel: 'EOB · aetna_eob_raman',
      owesCents: 16000,
      adjustmentsSummary: 'Insurance discount · Copay',
    });
    expect(priya.flags[0]).toMatchObject({
      column: 'insurancePaid',
      current: { display: '$260.00', reconciles: true },
    });
    expect(byPatient(batch, 'Tomás Herrera').flags[0]).toMatchObject({
      column: 'adjustments',
      current: { display: 'PR-3 → Copay' },
    });
  });

  it('ignores a file uploaded twice', async () => {
    const { json } = await call<{ batch: IntakeBatchView }>(
      'POST',
      '/intake/files',
      upload(['bcbs_era_1008.835']),
    );
    expect(json.batch.items).toHaveLength(5);
  });

  it('shows when a reading does not add up, and lets staff change their mind', async () => {
    const priya = byPatient(batch, 'Priya Raman');
    const wrong = priya.flags[0]!.alternatives[0]!.value;
    let res = await call<{ batch: IntakeBatchView }>('PATCH', `/intake/items/${priya.id}/flags`, {
      path: 'claims.0.insurance_paid',
      value: wrong,
    });
    let item = byPatient(res.json.batch, 'Priya Raman');
    expect(item.reconciles).toBe(false);
    expect(item.error).toMatch(/does not reconcile/);
    expect(res.json.batch.approvableCount).toBe(4);

    res = await call<{ batch: IntakeBatchView }>('PATCH', `/intake/items/${priya.id}/flags`, {
      path: 'claims.0.insurance_paid',
      value: '260.00',
    });
    item = byPatient(res.json.batch, 'Priya Raman');
    expect(item).toMatchObject({ reconciles: true, flags: [], owesCents: 16000 });
    expect(item.resolved.at(-1)).toMatchObject({ label: 'Insurance paid', to: '$260.00' });
    batch = res.json.batch;
    expect(batch.openFlagCount).toBe(1);
  });

  it('approves the batch: flagged items land in review, the rest are ready', async () => {
    published.length = 0;
    const { json } = await call<IntakeApproveResult>('POST', '/intake/batch/approve');
    expect(json.skipped).toEqual([]);
    expect(json.approved.map((a) => a.status)).toEqual([
      'ready',
      'ready',
      'ready',
      'review',
      'ready',
    ]);
    expect(json.batch.status).toBe('approved');
    expect(published).toEqual(['balances.changed']);

    const all = await rows();
    expect(all).toHaveLength(14);
    const tomas = all.find((r) => r.patientName === 'Tomás Herrera')!;
    expect(tomas).toMatchObject({
      status: 'review',
      aiSuggestion: 'Check copay vs. coinsurance',
      sourceFile: 'uhc_eob_sept.pdf',
    });
    expect(tomas.reviewReason).toMatch(/^Code read as PR-3 \(copay\), may be PR-2 \(coinsurance\)/);
    expect((await call<{ batch: null }>('GET', '/intake/batch')).json.batch).toBeNull();
  });

  it('resolves the remaining flag from the dashboard, then marks the row ready', async () => {
    const tomas = (await rows()).find((r) => r.patientName === 'Tomás Herrera')!;
    let drawer = (await call<DrawerData>('GET', `/balances/${tomas.id}/drawer`)).json;
    expect(drawer.review).toMatchObject({ canMarkReady: false });
    const flag = drawer.review!.flags[0]!;

    expect((await call('POST', `/balances/${tomas.id}/review/ready`)).status).toBe(409);
    drawer = (
      await call<DrawerData>('POST', `/balances/${tomas.id}/review/resolve`, {
        path: flag.path,
        value: '2',
      })
    ).json;
    expect(drawer.review).toMatchObject({ flags: [], canMarkReady: true });
    expect(drawer.balance.patientShare).toMatchObject({ coinsuranceCents: 36800, copayCents: 0 });
    expect(drawer.balance.owesCents).toBe(36800);

    drawer = (await call<DrawerData>('POST', `/balances/${tomas.id}/review/ready`)).json;
    expect(drawer.balance).toMatchObject({
      status: 'ready',
      aiSuggestion: 'Send invoice',
      reviewReason: null,
    });
  });

  it("prepares Maria's bill the way the design shows it", async () => {
    const maria = (await rows()).find((r) => r.patientName === 'Maria Delgado')!;
    const drawer = (await call<DrawerData>('GET', `/balances/${maria.id}/drawer`)).json;
    expect(drawer.draft).toMatchObject({
      paymentOption: { type: 'plan', months: 3 },
      saved: false,
      message:
        'Hi Maria, thanks for visiting Dr. Patel on Oct 3. Your visit came to $850. Your BlueCross plan lowered that to $450 and paid $210. The $240 left is $200 toward your yearly deductible plus $40 for your share of the cost. You can pay in full or split it into 3 payments of $80.',
    });
    expect(drawer.email).toEqual({
      to: 'm•••••@example.com',
      subject: 'Your Oct 3 visit — $240.00 due Nov 2',
      dueDate: '2026-11-02',
    });
    expect(drawer.messageProvenance).toBe(
      'Written from the 835 remittance. No diagnosis details are included.',
    );
    expect(drawer.plans).toEqual([
      { months: 3, firstCents: 8000, regularCents: 8000, eligible: true },
      { months: 6, firstCents: 4000, regularCents: 4000, eligible: true },
    ]);

    const spanish = await call<{ text: string; source: string }>(
      'POST',
      `/balances/${maria.id}/message`,
      {
        variant: 'spanish',
        paymentOption: { type: 'plan', months: 3 },
      },
    );
    expect(spanish.json).toMatchObject({ source: 'template' });
    expect(spanish.json.text).toMatch(/^Hola Maria/);
  });

  it('refuses to send a message with a figure the core did not compute', async () => {
    const maria = (await rows()).find((r) => r.patientName === 'Maria Delgado')!;
    const res = await call<{ message: string; details: string[] }>(
      'POST',
      `/balances/${maria.id}/send`,
      {
        message: 'Hi Maria, you owe $999.',
        messageSource: 'edited',
        paymentOption: { type: 'full' },
      },
    );
    expect(res.status).toBe(422);
    expect(res.json.details).toEqual(["$999.00 is not one of this bill's figures."]);
  });

  it('saves a draft and sends the invoice (stubbed until PayPal), moving the row to Sent', async () => {
    const maria = (await rows()).find((r) => r.patientName === 'Maria Delgado')!;
    const message =
      'Hi Maria, your Oct 3 visit with Dr. Patel came to $850. You owe $240, or 6 payments of $40.';
    const saved = (
      await call<DrawerData>('PUT', `/balances/${maria.id}/draft`, {
        message,
        messageSource: 'edited',
        paymentOption: { type: 'plan', months: 6 },
      })
    ).json;
    expect(saved.draft).toMatchObject({
      message,
      saved: true,
      paymentOption: { type: 'plan', months: 6 },
    });

    published.length = 0;
    const sent = await call<SendResult>('POST', `/balances/${maria.id}/send`, {
      message,
      messageSource: 'edited',
      paymentOption: { type: 'plan', months: 6 },
    });
    expect(sent.status).toBe(200);
    expect(sent.json.balance).toMatchObject({ status: 'sent', sub: 'Not opened' });
    expect(published).toEqual(['balances.changed']);

    const again = await call('POST', `/balances/${maria.id}/send`, {
      message,
      messageSource: 'edited',
      paymentOption: { type: 'full' },
    });
    expect(again.status).toBe(409);
  });

  it('does not allow an ineligible plan', async () => {
    const kevin = (await rows()).find((r) => r.patientName === 'Kevin Lam')!;
    const res = await call<{ message: string }>('PUT', `/balances/${kevin.id}/draft`, {
      message: 'Hi Kevin.',
      messageSource: 'edited',
      paymentOption: { type: 'plan', months: 4 },
    });
    expect(res.status).toBe(400);
  });
});

describe('dashboard review on the full seed', () => {
  it('refuses a correction that would make a live balance stop adding up', async () => {
    const db = openDatabase(':memory:');
    await loadSeed(db.db, { now: '2026-10-10T13:00:00.000Z' });
    const { app } = buildApp({ db: db.db, demoToday: SEED_TODAY });
    const list = (await app.inject({ method: 'GET', url: '/api/balances' })).json() as BalanceRow[];
    const priya = list.find((r) => r.patientName === 'Priya Raman')!;
    expect(priya).toMatchObject({
      status: 'review',
      aiSuggestion: 'Confirm insurance paid amount',
    });
    expect(priya.reviewReason).toMatch(/^EOB scan unclear: insurance paid \$260\.00 or /);

    const drawer = (
      await app.inject({ method: 'GET', url: `/api/balances/${priya.id}/drawer` })
    ).json() as DrawerData;
    const wrong = drawer.review!.flags[0]!.alternatives[0]!.value;
    const res = await app.inject({
      method: 'POST',
      url: `/api/balances/${priya.id}/review/resolve`,
      payload: { path: 'claims.0.insurance_paid', value: wrong },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/doesn't add up/);
    await app.close();
    db.close();
  });
});
