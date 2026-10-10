/**
 * "AI suggests" end to end: refresh the column (rules offline; Claude is unit-tested in
 * packages/ai), then the one-click actions on sent rows: a friendly reminder, and a reminder
 * that offers a payment plan (which turns plans on for the patient's page).
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildApp,
  openDatabase,
  type BalanceRow,
  type EmailPreview,
  type PatientBill,
  type ReminderResult,
} from '@plainbill/api';
import { loadSeed } from '../src/load';
import { SEED_TODAY } from '../src/spec';

let base = '';
let close: () => void;
let stop: () => Promise<void>;

beforeAll(async () => {
  const opened = openDatabase(':memory:');
  close = opened.close;
  await loadSeed(opened.db, { now: '2026-10-10T13:00:00.000Z' });
  const { app } = buildApp({ db: opened.db, demoToday: SEED_TODAY });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api`;
  stop = () => app.close();
});
afterAll(async () => {
  await stop();
  close();
});

async function call<T>(method: string, path: string, body?: unknown, cookie = '') {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as T, headers: res.headers };
}

const rows = async () => (await call<BalanceRow[]>('GET', '/balances')).json;
const rowOf = async (name: string) => (await rows()).find((r) => r.patientName === name)!;

describe('AI suggests', () => {
  it('seeded suggestions already carry the action their button runs', async () => {
    const all = await rows();
    const by = (n: string) => all.find((r) => r.patientName === n)!;
    expect(by('Maria Delgado')).toMatchObject({
      aiSuggestion: 'Send invoice + 3-month plan',
      aiAction: 'send_invoice_with_plan',
    });
    expect(by('Grace Whitaker').aiAction).toBe('send_reminder');
    expect(by('James Whitfield').aiAction).toBe('resubmit_with_auth');
  });

  it('refreshes every open row; the design’s labels come out of the rules', async () => {
    const { json } = await call<{ via: string; updated: number }>('POST', '/suggestions/refresh');
    expect(json).toMatchObject({ via: 'rules', updated: 12 });
    const all = await rows();
    const by = (n: string) => all.find((r) => r.patientName === n)!;
    expect(by('Grace Whitaker')).toMatchObject({
      aiSuggestion: 'Send friendly reminder',
      aiAction: 'send_reminder',
      aiSuggestionBy: 'rules',
    });
    expect(by('Robert Chen')).toMatchObject({
      aiSuggestion: 'Offer 3-month plan',
      aiAction: 'offer_plan',
    });
    expect(by('Aisha Bello').aiSuggestion).toBe('Offer 6-month plan · $100/mo');
    expect(by('Kevin Lam').aiSuggestion).toBe('Send invoice');
    expect(by('Linda Park').aiSuggestion).toBeNull();
  });

  it('“Send friendly reminder” emails the patient and quiets the suggestion', async () => {
    const grace = await rowOf('Grace Whitaker');
    const { status, json } = await call<ReminderResult>('POST', `/balances/${grace.id}/remind`, {});
    expect(status).toBe(200);
    expect(json).toMatchObject({ planMonths: null, email: { status: 'outbox' } });
    const email = (await call<EmailPreview>('GET', `/balances/${grace.id}/email`)).json;
    expect(email.subject).toBe('Reminder: your Aug 2 visit — $250.00 balance');
    expect(email.html).toContain('this is a friendly reminder from Harborview Family Medicine');
    expect(await rowOf('Grace Whitaker')).toMatchObject({
      aiSuggestion: 'Reminder sent today',
      aiAction: 'none',
    });
  });

  it('“Offer 3-month plan” reminds with the plan and turns plans on for the patient', async () => {
    const robert = await rowOf('Robert Chen');
    const { json } = await call<ReminderResult>('POST', `/balances/${robert.id}/remind`, {
      offerPlanMonths: 3,
    });
    expect(json.planMonths).toBe(3);
    const email = (await call<EmailPreview>('GET', `/balances/${robert.id}/email`)).json;
    expect(email.html).toContain('split it into 3 payments of $50');
    expect(email.html).toContain('payment plans available');

    const token = json.payUrl.split('/').pop()!;
    const verified = await call('POST', `/pay/${token}/verify`, {
      lastName: 'Chen',
      month: 5,
      day: 27,
      year: 1981,
    });
    const cookie = verified.headers.get('set-cookie')!.split(';')[0]!;
    const bill = (await call<PatientBill>('GET', `/pay/${token}/bill`, undefined, cookie)).json;
    expect(bill.options.plans.map((p) => p.months)).toEqual([3, 6]);
  });

  it('refuses reminders for bills that aren’t out', async () => {
    const maria = await rowOf('Maria Delgado');
    expect((await call('POST', `/balances/${maria.id}/remind`, {})).status).toBe(409);
  });
});
