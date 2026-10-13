/**
 * Statement notes with a model configured (a fake annotator standing in for Claude): written in
 * the background on Send, cached per invoice and language, rewritten when the balance changes.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  TemplateStatementAnnotator,
  type AnnotateFacts,
  type AnnotateResult,
  type StatementAnnotator,
} from '@plainbill/ai';
import {
  buildApp,
  offlineAi,
  openDatabase,
  recordPayment,
  schema,
  type BalanceRow,
  type DrawerData,
  type SendResult,
  type StatementNotes,
} from '@plainbill/api';
import { loadSeed } from '../src/load';
import { SEED_TODAY } from '../src/spec';

/** Writes the template notes but reports them as the model's, and counts its calls. */
class FakeAnnotator implements StatementAnnotator {
  calls: string[] = [];
  private readonly inner = new TemplateStatementAnnotator();
  async annotate(facts: AnnotateFacts): Promise<AnnotateResult> {
    this.calls.push(`${facts.language.code}:${facts.owesCents}`);
    const result = await this.inner.annotate(facts);
    return {
      ...result,
      notes: result.notes.map((n) => ({ ...n, title: `${n.title}.` })),
      source: 'ai',
      fallback: false,
      model: 'fake-model',
    };
  }
}

const annotator = new FakeAnnotator();
let base = '';
let db: ReturnType<typeof openDatabase>['db'];
let close: () => void;
let stop: () => Promise<void>;

beforeAll(async () => {
  const opened = openDatabase(':memory:');
  db = opened.db;
  close = opened.close;
  await loadSeed(db, { now: '2026-10-10T13:00:00.000Z' });
  const { app } = buildApp({
    db,
    demoToday: SEED_TODAY,
    ai: { ...offlineAi(), annotator, available: true, model: 'fake-model' },
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

describe('AI statement notes', () => {
  let token = '';
  let cookie = '';
  let balanceId = 0;

  it('are written in English and Spanish in the background when the bill is sent', async () => {
    const rows = (await call<BalanceRow[]>('GET', '/balances')).json;
    balanceId = rows.find((r) => r.patientName === 'Maria Delgado')!.id;
    const drawer = (await call<DrawerData>('GET', `/balances/${balanceId}/drawer`)).json;
    const sent = await call<SendResult>('POST', `/balances/${balanceId}/send`, {
      message: drawer.draft.message,
      messageSource: 'template',
      paymentOption: { type: 'plan', months: 3 },
    });
    expect(sent.status).toBe(200);
    token = sent.json.balance.invoice!.payPath!.split('/').pop()!;
    await vi.waitFor(() =>
      expect(
        db
          .select()
          .from(schema.statementNotes)
          .all()
          .map((r) => [r.lang, r.source, r.model]),
      ).toEqual([
        ['en', 'ai', 'fake-model'],
        ['es', 'ai', 'fake-model'],
      ]),
    );
    expect(annotator.calls.sort()).toEqual(['en:24000', 'es:24000']);
  });

  it('are served from the cache while the balance is unchanged', async () => {
    const verified = await call('POST', `/pay/${token}/verify`, {
      lastName: 'Delgado',
      month: '4',
      day: '17',
      year: '1984',
    });
    cookie = verified.headers.get('set-cookie')!.split(';')[0]!;
    const { json } = await call<StatementNotes>(
      'GET',
      `/pay/${token}/statement/notes?lang=es`,
      undefined,
      cookie,
    );
    expect(json).toMatchObject({ lang: 'es', source: 'ai', fallback: false });
    expect(json.notes[0]).toMatchObject({ n: 1, title: 'Esto es lo que debe.' });
    expect(annotator.calls).toHaveLength(2);
  });

  it('are rewritten after a payment changes the balance', async () => {
    recordPayment(db, balanceId, {
      amountCents: 8000,
      method: 'paypal',
      source: 'simulated',
      postedOn: SEED_TODAY,
      receivedAt: '2026-10-10T15:00:00.000Z',
    });
    const { json } = await call<StatementNotes>(
      'GET',
      `/pay/${token}/statement/notes?lang=en`,
      undefined,
      cookie,
    );
    expect(annotator.calls.at(-1)).toBe('en:16000');
    expect(json.notes.map((n) => n.anchorId)).toContain('payment-1');
    expect(json.notes[0]!.body).toContain('$160.00');
    // Asking again doesn't call the model.
    await call('GET', `/pay/${token}/statement/notes?lang=en`, undefined, cookie);
    expect(annotator.calls).toHaveLength(3);
  });
});
