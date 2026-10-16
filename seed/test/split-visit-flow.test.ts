/**
 * The split visit end to end (no API key: templates and the rule-based helper): Theo Lambert's
 * yearly checkup was covered, but another concern discussed during it was billed as its own
 * office visit. Send → verify → the statement highlights that line and explains it in English
 * and Spanish → the helper answers "why wasn't my checkup free?". The email stays generic.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildApp,
  openDatabase,
  type BalanceRow,
  type DrawerData,
  type EmailPreview,
  type PatientBill,
  type PatientStatement,
  type SendResult,
  type StatementNotes,
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
  const { app } = buildApp({
    db: opened.db,
    demoToday: SEED_TODAY,
    appBaseUrl: 'https://pay.example.test',
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api`;
  stop = () => app.close();
});
afterAll(async () => {
  await stop();
  close();
});

async function call<T>(method: string, path: string, body?: unknown, cookie?: string) {
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

const rowOf = async (name: string) =>
  (await call<BalanceRow[]>('GET', '/balances')).json.find((r) => r.patientName === name)!;

describe("Theo's split visit", () => {
  let row: BalanceRow;
  let token = '';
  let cookie = '';

  beforeAll(async () => {
    row = await rowOf('Theo Lambert');
    const drawer = (await call<DrawerData>('GET', `/balances/${row.id}/drawer`)).json;
    const sent = await call<SendResult>('POST', `/balances/${row.id}/send`, {
      message: drawer.draft.message,
      messageSource: 'template',
      paymentOption: { type: 'full' },
    });
    expect(sent.status).toBe(200);
    token = sent.json.balance.invoice!.payPath!.split('/').pop()!;
    const verified = await call('POST', `/pay/${token}/verify`, {
      lastName: 'Lambert',
      month: '4',
      day: '11',
      year: '1979',
    });
    expect(verified.status).toBe(200);
    cookie = verified.headers.get('set-cookie')!.split(';')[0]!;
  });

  it('is detected on the dashboard row, pointing at the right lines', () => {
    expect(row.splitVisit).toMatchObject({
      preventiveIndex: 0,
      problemIndex: 1,
      preventive: { code: '99396', chargeCents: 38000 },
      problem: { code: '99213', chargeCents: 22000, patientShare: { deductibleCents: 15000 } },
    });
    expect(row.owesCents).toBe(15000);
  });

  it('highlights the office-visit line on the statement', async () => {
    const { json } = await call<PatientStatement>(
      'GET',
      `/pay/${token}/statement`,
      undefined,
      cookie,
    );
    const split = json.layout.anchors.find((a) => a.id === 'split_visit')!;
    expect(split).toMatchObject({ kind: 'split_visit', quote: '99213 220.00' });
  });

  it('explains it in English and Spanish', async () => {
    const en = (
      await call<StatementNotes>('GET', `/pay/${token}/statement/notes?lang=en`, undefined, cookie)
    ).json;
    const note = en.notes.find((n) => n.anchorId === 'split_visit')!;
    expect(note).toMatchObject({ n: 3, title: "Why your checkup wasn't free" });
    expect(note.body).toContain('That $150 goes toward your deductible.');

    const es = (
      await call<StatementNotes>('GET', `/pay/${token}/statement/notes?lang=es`, undefined, cookie)
    ).json;
    expect(es.notes.find((n) => n.anchorId === 'split_visit')!.title).toBe(
      '¿Por qué no fue gratis?',
    );
  });

  it('adds a plain glossary term to the bill page', async () => {
    const { json } = await call<PatientBill>('GET', `/pay/${token}/bill`, undefined, cookie);
    expect(json.splitVisit).toEqual({
      checkupChargeCents: 38000,
      visitChargeCents: 22000,
      share: {
        deductibleCents: 15000,
        coinsuranceCents: 0,
        copayCents: 0,
        otherCents: 0,
        totalCents: 15000,
      },
    });
    expect(json.terms.map((t) => t.term)).toContain('Checkup vs. office visit');
  });

  it("answers “why wasn't my checkup free?” from the bill", async () => {
    const { json } = await call<{ text: string; source: string; via: string }>(
      'POST',
      `/pay/${token}/assistant`,
      { message: "Why wasn't my checkup free?", history: [] },
      cookie,
    );
    expect(json.via).toBe('rules');
    expect(json.text).toContain('Your yearly checkup was covered in full.');
    expect(json.text).toContain('regular office visit ($220)');
    expect(json.source).toBe("Based on BlueCross's statement for your Sep 16 visit");
  });

  it('keeps the email generic: no checkup, concern or office-visit wording', async () => {
    const { json } = await call<EmailPreview>('GET', `/balances/${row.id}/email`);
    expect(json.html).not.toMatch(/checkup|concern|office visit|99396|99213/i);
  });
});
