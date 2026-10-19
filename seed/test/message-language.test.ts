/**
 * The drawer's message language: drafted in any statement language (a fake Claude client),
 * guarded the same way, English when there's no template to fall back to, and kept with the
 * draft through save, the email preview and send.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeMessageDrafter } from '@plainbill/ai';
import {
  buildApp,
  offlineAi,
  openDatabase,
  schema,
  type BalanceRow,
  type DraftMessageResult,
  type DrawerData,
  type EmailPreview,
  type SendResult,
} from '@plainbill/api';
import { loadSeed } from '../src/load';
import { SEED_TODAY } from '../src/spec';

const VIETNAMESE =
  'Chào Maria, bạn còn nợ $240 cho lần khám ngày 3/10 với Dr. Patel. Bảo hiểm đã trả $210.';

/** Answers by the language the prompt asks for; Kreyòl always invents a figure. */
const prompts: string[] = [];
const client = {
  beta: {
    messages: {
      create: async (params: { messages: Array<{ content: string }> }) => {
        const prompt = params.messages[0]!.content;
        prompts.push(prompt);
        const text = prompt.includes('Vietnamese') ? VIETNAMESE : 'Ou dwe 999 dola.';
        return { stop_reason: 'end_turn', content: [{ type: 'text', text }] };
      },
    },
  },
} as unknown as ConstructorParameters<typeof ClaudeMessageDrafter>[0]['client'];

let base = '';
let db: ReturnType<typeof openDatabase>['db'];
let close: () => void;
let stop: () => Promise<void>;
let maria: BalanceRow;

beforeAll(async () => {
  const opened = openDatabase(':memory:');
  db = opened.db;
  close = opened.close;
  await loadSeed(db, { now: '2026-10-10T13:00:00.000Z' });
  const { app } = buildApp({
    db,
    demoToday: SEED_TODAY,
    ai: {
      ...offlineAi(),
      drafter: new ClaudeMessageDrafter({ client, model: 'fake-model' }),
      available: true,
      model: 'fake-model',
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api`;
  stop = () => app.close();
  maria = (await call<BalanceRow[]>('GET', '/balances')).json.find(
    (r) => r.patientName === 'Maria Delgado',
  )!;
});
afterAll(async () => {
  await stop();
  close();
});

async function call<T>(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
      : {}),
  });
  return { status: res.status, json: (await res.json()) as T };
}

const plan3 = { type: 'plan', months: 3 } as const;

describe('Review & Send message language', () => {
  it('starts in English when the patient has never chosen a language', async () => {
    const drawer = (await call<DrawerData>('GET', `/balances/${maria.id}/drawer`)).json;
    expect(drawer.patientLang).toBeNull();
    expect(drawer.draft).toMatchObject({ lang: 'en', requestedLang: 'en', saved: false });
  });

  it('defaults to the language the patient last chose on a statement', async () => {
    db.insert(schema.events)
      .values({ type: 'statement.language', balanceId: maria.id, payload: { lang: 'vi' } })
      .run();
    const drawer = (await call<DrawerData>('GET', `/balances/${maria.id}/drawer`)).json;
    expect(drawer.patientLang).toBe('vi');
    // No Vietnamese template: the placeholder is honest about being English.
    expect(drawer.draft).toMatchObject({ lang: 'en', requestedLang: 'vi' });
    expect(drawer.draft.message).toMatch(/^Hi Maria/);
  });

  it('drafts in the chosen language, simpler or not', async () => {
    const res = await call<DraftMessageResult>('POST', `/balances/${maria.id}/message`, {
      variant: 'simpler',
      lang: 'vi',
      paymentOption: plan3,
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      text: VIETNAMESE,
      variant: 'simpler',
      lang: 'vi',
      requestedLang: 'vi',
      source: 'ai',
      notes: [],
    });
    expect(prompts.at(-1)).toContain('natural Vietnamese');
    expect(prompts.at(-1)).toContain('under 50 words');
  });

  it('refuses invented figures, then falls back to English and says so', async () => {
    const res = await call<DraftMessageResult>('POST', `/balances/${maria.id}/message`, {
      lang: 'ht',
      paymentOption: plan3,
    });
    expect(res.json).toMatchObject({ source: 'template', lang: 'en', requestedLang: 'ht' });
    expect(res.json.text).toMatch(/^Hi Maria/);
    expect(res.json.notes).toEqual([
      `Draft 1 rejected: "999" is not one of this bill's figures.`,
      `Draft 2 rejected: "999" is not one of this bill's figures.`,
      'There’s no Haitian Creole template, so this is the English one.',
    ]);
  });

  it('refuses a language it does not know', async () => {
    const res = await call<{ message: string }>('POST', `/balances/${maria.id}/message`, {
      lang: 'tlh',
      paymentOption: plan3,
    });
    expect(res.status).toBe(400);
    expect(res.json.message).toBe('Unknown language "tlh".');
    const save = await call('PUT', `/balances/${maria.id}/draft`, {
      message: VIETNAMESE,
      messageSource: 'ai',
      messageLang: 'xx',
      paymentOption: plan3,
    });
    expect(save.status).toBe(400);
  });

  it('keeps the language with the saved draft, the row and the email preview', async () => {
    const saved = await call<DrawerData>('PUT', `/balances/${maria.id}/draft`, {
      message: VIETNAMESE,
      messageSource: 'ai',
      messageLang: 'vi',
      paymentOption: plan3,
    });
    expect(saved.status).toBe(200);
    expect(saved.json.draft).toMatchObject({
      message: VIETNAMESE,
      lang: 'vi',
      requestedLang: 'vi',
      saved: true,
    });
    const reopened = (await call<DrawerData>('GET', `/balances/${maria.id}/drawer`)).json;
    expect(reopened.draft).toMatchObject({ lang: 'vi', requestedLang: 'vi' });

    const row = (await call<BalanceRow[]>('GET', '/balances')).json.find((r) => r.id === maria.id)!;
    expect(row.invoice).toMatchObject({
      status: 'draft',
      messageLang: { code: 'vi', language: 'Tiếng Việt' },
    });

    const preview = (await call<EmailPreview>('GET', `/balances/${maria.id}/email`)).json;
    expect(preview.kind).toBe('draft');
    expect(preview.html).toContain('lang="vi"');
    expect(preview.html).toContain('bạn còn nợ $240');
  });

  it('sends the message in its language (the rest of the email stays English)', async () => {
    const sent = await call<SendResult>('POST', `/balances/${maria.id}/send`, {
      message: VIETNAMESE,
      messageSource: 'ai',
      messageLang: 'vi',
      paymentOption: plan3,
    });
    expect(sent.status).toBe(200);
    expect(sent.json.balance.invoice).toMatchObject({
      status: 'sent',
      messageLang: { code: 'vi', language: 'Tiếng Việt' },
    });
    const email = (await call<EmailPreview>('GET', `/balances/${maria.id}/email`)).json;
    expect(email.kind).toBe('sent');
    expect(email.html).toContain('<html lang="en">');
    expect(email.html).toMatch(/lang="vi">Chào Maria/);
  });
});
