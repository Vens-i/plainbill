/**
 * "Your statement, explained" on the full seed: patient mailing addresses, the itemized
 * statement (JSON layout + PDF) behind verification, and the staff preview.
 */
import type { AddressInfo } from 'node:net';
import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildApp,
  openDatabase,
  schema,
  type BalanceRow,
  type DrawerData,
  type PatientStatement,
  type SendResult,
} from '@plainbill/api';
import { loadSeed } from '../src/load';
import { SEED_TODAY } from '../src/spec';

let base = '';
let db: ReturnType<typeof openDatabase>['db'];
let close: () => void;
let stop: () => Promise<void>;

beforeAll(async () => {
  const opened = openDatabase(':memory:');
  db = opened.db;
  close = opened.close;
  await loadSeed(db, { now: '2026-10-10T13:00:00.000Z' });
  const { app } = buildApp({ db, demoToday: SEED_TODAY, appBaseUrl: 'https://pay.example.test' });
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
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const type = res.headers.get('content-type') ?? '';
  const payload = type.includes('json')
    ? ((await res.json()) as T)
    : (Buffer.from(await res.arrayBuffer()) as unknown as T);
  return { status: res.status, json: payload, headers: res.headers };
}

const rowOf = async (name: string) =>
  (await call<BalanceRow[]>('GET', '/balances')).json.find((r) => r.patientName === name)!;
const tokenOf = (row: BalanceRow) => row.invoice!.payPath!.split('/').pop()!;

async function verify(token: string, lastName: string, dob: [number, number, number]) {
  const res = await call('POST', `/pay/${token}/verify`, {
    lastName,
    month: String(dob[0]),
    day: String(dob[1]),
    year: String(dob[2]),
  });
  expect(res.status).toBe(200);
  return { cookie: res.headers.get('set-cookie')!.split(';')[0]! };
}

/** The text drawn on a pdf-lib page: inflate the content streams, decode the hex strings. */
function pdfText(pdf: Buffer): string {
  const out: string[] = [];
  const raw = pdf.toString('latin1');
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    const bytes = pdf.subarray(start, end);
    let content: string;
    try {
      content = inflateSync(bytes).toString('latin1');
    } catch {
      content = bytes.toString('latin1');
    }
    for (const t of content.matchAll(/<([0-9A-Fa-f]+)> Tj/g)) {
      out.push(Buffer.from(t[1]!, 'hex').toString('latin1'));
    }
  }
  return out.join('\n');
}

describe('patient addresses', () => {
  it('every seed patient has a fictional mailing address', () => {
    const rows = db
      .select()
      .from(schema.patients)
      .all()
      .sort((a, b) => a.id - b.id);
    expect(rows).toHaveLength(13);
    for (const p of rows) {
      expect(p.addressLine1, p.lastName).toMatch(/^\d+ /);
      expect([p.city, p.state, p.zip]).toEqual(['Harborview', 'CA', '94000']);
    }
    expect(rows[0]).toMatchObject({
      firstName: 'Maria',
      addressLine1: '418 Seacliff Ave',
      addressLine2: 'Apt 2B',
    });
  });
});

describe("Maria's statement", () => {
  let token = '';
  let cookie = '';
  let statement: PatientStatement;

  beforeAll(async () => {
    const row = await rowOf('Maria Delgado');
    const drawer = (await call<DrawerData>('GET', `/balances/${row.id}/drawer`)).json;
    const sent = await call<SendResult>('POST', `/balances/${row.id}/send`, {
      message: drawer.draft.message,
      messageSource: 'template',
      paymentOption: { type: 'plan', months: 3 },
    });
    expect(sent.status).toBe(200);
    token = tokenOf(sent.json.balance);
  });

  it('is not served before verification', async () => {
    expect((await call('GET', `/pay/${token}/statement`)).status).toBe(401);
    const pdf = await call('GET', `/pay/${token}/statement.pdf`);
    expect(pdf.status).toBe(401);
    expect(pdf.headers.get('content-type')).toContain('json');
  });

  it('serves the layout with six anchors after verification', async () => {
    cookie = (await verify(token, 'Delgado', [4, 17, 1984])).cookie;
    const res = await call<PatientStatement>('GET', `/pay/${token}/statement`, undefined, {
      cookie,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    statement = res.json;
    expect(statement.statementId).toMatch(/^S\d{7}$/);
    expect(statement.pdfPath).toBe(`/api/pay/${token}/statement.pdf`);
    expect(statement.layout.anchors.map((a) => [a.id, a.quote])).toEqual([
      ['amount_due', 'PAY THIS AMOUNT $240.00'],
      ['charges', '99214 · 80053 · 93000'],
      ['insurance_payment', 'INSPMT −210.00'],
      ['discount', 'CO45 −400.00'],
      ['patient_responsibility', 'PR1 PR2 · DED 200.00 COINS 40.00'],
      ['messages', '3 MONTHLY PAYMENTS'],
    ]);
    const texts = statement.layout.ops.flatMap((op) => (op.t === 'text' ? [op.s] : []));
    expect(texts).toContain('418 SEACLIFF AVE APT 2B');
    expect(texts).toContain('INS PMT BLUECROSS EFT BC1008120117');
  });

  it('renders the same statement as a PDF, the same bytes every time', async () => {
    const res = await call<Buffer>('GET', `/pay/${token}/statement.pdf`, undefined, { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-disposition')).toBe(
      `inline; filename="Harborview-statement-${statement.statementId}.pdf"`,
    );
    const pdf = res.json;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const text = pdfText(pdf);
    for (const s of [
      '$240.00',
      'CO45',
      '-400.00',
      '-210.00',
      'PATIENT STATEMENT',
      'MARIA DELGADO',
    ]) {
      expect(text).toContain(s);
    }
    expect(text).toContain(`STATEMENT ID ${statement.statementId}`);
    expect(text).not.toMatch(/IF PAYING BY CREDIT CARD|CARD NUMBER\b|SIGNATURE/);

    const again = await call<Buffer>('GET', `/pay/${token}/statement.pdf`, undefined, { cookie });
    expect(Buffer.compare(again.json, pdf)).toBe(0);
  });
});

describe("Aisha's statement (self-pay, partly paid)", () => {
  it('shows both payments, no insurance, and $600 in the 91–120 box', async () => {
    const token = tokenOf(await rowOf('Aisha Bello'));
    const { cookie } = await verify(token, 'Bello', [8, 21, 1995]);
    const { json } = await call<PatientStatement>('GET', `/pay/${token}/statement`, undefined, {
      cookie,
    });
    const ids = json.layout.anchors.map((a) => a.id);
    expect(ids).toEqual(['amount_due', 'charges', 'payment-1', 'payment-2', 'messages']);
    const texts = json.layout.ops.flatMap((op) => (op.t === 'text' ? [op] : []));
    const box = texts.find((t) => t.s === '91–120 DAYS')!;
    const value = texts.find((t) => t.x === box.x && t.y === box.y + 15)!;
    expect(value.s).toBe('600.00');
    expect(texts.map((t) => t.s)).toContain('$600.00');
  });
});

describe('staff preview', () => {
  it('renders a statement before sending, with a placeholder ID', async () => {
    const kevin = await rowOf('Kevin Lam');
    expect(kevin.status).toBe('ready');
    const res = await call<Buffer>('GET', `/balances/${kevin.id}/statement.pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const text = pdfText(res.json);
    expect(text).toContain('STATEMENT ID PREVIEW');
    expect(text).toContain('$275.00');
  });

  it('refuses denied claims', async () => {
    const james = await rowOf('James Whitfield');
    expect((await call('GET', `/balances/${james.id}/statement.pdf`)).status).toBe(409);
  });
});
