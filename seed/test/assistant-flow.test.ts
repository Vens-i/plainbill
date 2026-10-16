/**
 * The patient's bill helper end to end: grounded answers with a source line, payment actions
 * proposed as cards (amounts from code), confirmed by the patient, created through the PayPal
 * Agent Toolkit (a stand-in here), approved in PayPal, and recorded like any other payment.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeBillAssistant, RuleBillAssistant, type BillAssistant } from '@plainbill/ai';
import {
  buildApp,
  FakeAgentTools,
  FakePayPal,
  offlineAi,
  openDatabase,
  type AssistantAnswer,
  type AssistantConfirmResult,
  type BalanceRow,
  type DrawerData,
  type PayResult,
} from '@plainbill/api';
import { loadSeed } from '../src/load';
import { SEED_TODAY } from '../src/spec';

const paypal = new FakePayPal();
const agent = new FakeAgentTools(paypal);
const assistant: { current: BillAssistant } = { current: new RuleBillAssistant() };
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
    devRoutes: true,
    ai: { ...offlineAi(), assistant: { reply: (r) => assistant.current.reply(r) } },
    paypal: { api: paypal, agent, clientId: 'test-client', env: 'sandbox', webhookId: 'WH' },
  });
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

const rowOf = async (name: string) =>
  (await call<BalanceRow[]>('GET', '/balances')).json.find((r) => r.patientName === name)!;

async function sendAndVerify(name: string, option: unknown, lastName: string, dob: number[]) {
  const row = await rowOf(name);
  const drawer = (await call<DrawerData>('GET', `/balances/${row.id}/drawer`)).json;
  const sent = await call('POST', `/balances/${row.id}/send`, {
    message: drawer.draft.message,
    messageSource: 'template',
    paymentOption: option,
  });
  expect(sent.status).toBe(200);
  const token = (await rowOf(name)).invoice!.payPath!.split('/').pop()!;
  const verified = await call('POST', `/pay/${token}/verify`, {
    lastName,
    month: dob[0],
    day: dob[1],
    year: dob[2],
  });
  const cookie = verified.headers.get('set-cookie')!.split(';')[0]!;
  return { token, cookie };
}

describe('Ask about your bill (Maria, plan offered)', () => {
  let token: string;
  let cookie: string;

  beforeAll(async () => {
    ({ token, cookie } = await sendAndVerify(
      'Maria Delgado',
      { type: 'plan', months: 3 },
      'Delgado',
      [4, 17, 1984],
    ));
  });

  it('needs the verified session', async () => {
    expect((await call('POST', `/pay/${token}/assistant`, { message: 'Why?' })).status).toBe(401);
  });

  it('answers “why do I owe $240?” from the bill, with its source (artboard 1f)', async () => {
    const { json } = await call<AssistantAnswer>(
      'POST',
      `/pay/${token}/assistant`,
      { message: 'Why do I owe $240?', history: [] },
      cookie,
    );
    expect(json).toEqual({
      text: 'Good question! Your plan put $200 toward your yearly deductible — the amount you pay before insurance starts sharing costs. After that, your share was $40 (coinsurance). $200 + $40 = $240.',
      source: "Based on BlueCross's statement for your Oct 3 visit",
      cards: [],
      via: 'rules',
    });
  });

  it('proposes the plan as a card with code-computed dates and amounts; confirming creates the subscription via the toolkit', async () => {
    const { json } = await call<AssistantAnswer>(
      'POST',
      `/pay/${token}/assistant`,
      { message: 'Can I pay over time?' },
      cookie,
    );
    expect(json.text).toContain('3 payments of $80');
    const card = json.cards[0]!;
    expect(card).toMatchObject({
      kind: 'payment_plan',
      title: '3 payments of $80',
      detail: ['Today: $80', 'Nov 10: $80', 'Dec 10: $80', expect.stringContaining('No interest')],
      amountCents: 8000,
      confirmLabel: 'Confirm plan',
    });
    // Nothing has reached PayPal yet: the card only proposes.
    expect(agent.calls).toEqual([]);

    const confirmed = await call<AssistantConfirmResult>(
      'POST',
      `/pay/${token}/assistant/actions/${card.id}/confirm`,
      undefined,
      cookie,
    );
    expect(confirmed.json).toMatchObject({ kind: 'payment_plan', amountCents: 8000 });
    expect(agent.calls.map((c) => c.tool)).toEqual(['create_subscription']);
    // Confirming twice returns the same subscription instead of making another.
    const again = await call<AssistantConfirmResult>(
      'POST',
      `/pay/${token}/assistant/actions/${card.id}/confirm`,
      undefined,
      cookie,
    );
    expect(again.json.subscriptionId).toBe(confirmed.json.subscriptionId);
    expect(agent.calls).toHaveLength(1);

    // The patient approves in PayPal; the usual confirm route records payment 1 of 3.
    paypal.payerApprovesSubscription(confirmed.json.subscriptionId!);
    const paid = await call<PayResult>(
      'POST',
      `/pay/${token}/plan/confirm`,
      { subscriptionId: confirmed.json.subscriptionId },
      cookie,
    );
    expect(paid.json.bill.plan).toMatchObject({ months: 3, paidCount: 1 });
    expect((await rowOf('Maria Delgado')).sub).toBe('Plan · 1 of 3 paid');
  });

  it('cards only work for the bill they were made for', async () => {
    expect(
      (
        await call(
          'POST',
          `/pay/${token}/assistant/actions/not-a-real-action/confirm`,
          undefined,
          cookie,
        )
      ).status,
    ).toBe(404);
  });
});

type ClaudeClient = ConstructorParameters<typeof ClaudeBillAssistant>[0]['client'];

/** Canned Claude turns: a tool call, then the answer. */
function scriptedClaude(turns: Array<{ tool: string; input: object } | { text: string }>) {
  const create = async () => {
    const next = turns.shift()!;
    return 'tool' in next
      ? {
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'tu-1', name: next.tool, input: next.input }],
        }
      : { stop_reason: 'end_turn', content: [{ type: 'text', text: next.text }] };
  };
  return { beta: { messages: { create } } } as unknown as ClaudeClient;
}

describe('Ask about your bill (Kevin, partial payments allowed, Claude)', () => {
  it('turns “can I pay $50 now?” into a $50 card; the toolkit creates the order; capture records it', async () => {
    const { token, cookie } = await sendAndVerify(
      'Kevin Lam',
      { type: 'partial', minimumCents: 2000 },
      'Lam',
      [2, 11, 1991],
    );
    assistant.current = new ClaudeBillAssistant({
      model: 'claude-test',
      client: scriptedClaude([
        { tool: 'propose_partial_payment', input: { amount: '50' } },
        {
          text: 'Yes! You can pay $50 today and $225 later. Tap Confirm below to continue to PayPal.',
        },
      ]),
    });
    const { json } = await call<AssistantAnswer>(
      'POST',
      `/pay/${token}/assistant`,
      { message: 'Can I pay $50 now?' },
      cookie,
    );
    expect(json.via).toBe('claude');
    expect(json.source).toBe("Based on Harborview's self-pay rate for your Sep 29 visit");
    expect(json.cards[0]).toMatchObject({
      kind: 'partial_payment',
      title: 'Pay $50 now',
      amountCents: 5000,
    });

    const confirmed = await call<AssistantConfirmResult>(
      'POST',
      `/pay/${token}/assistant/actions/${json.cards[0]!.id}/confirm`,
      undefined,
      cookie,
    );
    expect(agent.calls.at(-1)).toEqual({
      tool: 'create_order',
      input: { itemName: 'Services on Sep 29, 2026 with Dr. Kim', amountCents: 5000 },
    });
    paypal.payerApprovesOrder(confirmed.json.orderId!);
    const paid = await call<PayResult>(
      'POST',
      `/pay/${token}/orders/${confirmed.json.orderId}/capture`,
      undefined,
      cookie,
    );
    expect(paid.json.bill.amounts.remainingCents).toBe(22500);
    expect((await rowOf('Kevin Lam')).status).toBe('partial');
  });

  it('a plan the staff didn’t offer is refused to the model, so no card appears', async () => {
    const kevin = await rowOf('Kevin Lam');
    const token = kevin.invoice!.payPath!.split('/').pop()!;
    const { headers } = await call('POST', `/pay/${token}/verify`, {
      lastName: 'Lam',
      month: 2,
      day: 11,
      year: 1991,
    });
    const cookie = headers.get('set-cookie')!.split(';')[0]!;
    assistant.current = new ClaudeBillAssistant({
      model: 'claude-test',
      client: scriptedClaude([
        { tool: 'offer_phone_call', input: {} },
        { text: 'Plans aren’t set up for this bill, but the office can talk it through with you.' },
      ]),
    });
    const { json } = await call<AssistantAnswer>(
      'POST',
      `/pay/${token}/assistant`,
      { message: 'Can I do a 6 month plan?' },
      cookie,
    );
    expect(json.cards.map((c) => c.kind)).toEqual(['phone_call']);
    expect(json.cards[0]!.detail).toEqual(['(555) 014-2290', 'Mon–Fri 8–5']);
  });
});

describe('“I’ll just pay it all now” (video scene 9b)', () => {
  it('shows a pay-in-full card; confirming creates the order via the toolkit; capture pays the bill', async () => {
    const { token, cookie } = await sendAndVerify(
      'Theo Lambert',
      { type: 'full' },
      'Lambert',
      [4, 11, 1979],
    );
    assistant.current = new RuleBillAssistant();
    const { json } = await call<AssistantAnswer>(
      'POST',
      `/pay/${token}/assistant`,
      { message: "I'll just pay it all now" },
      cookie,
    );
    expect(json.cards).toHaveLength(1);
    expect(json.cards[0]).toMatchObject({ kind: 'pay_in_full', amountCents: 15000 });

    const confirmed = await call<AssistantConfirmResult>(
      'POST',
      `/pay/${token}/assistant/actions/${json.cards[0]!.id}/confirm`,
      undefined,
      cookie,
    );
    expect(confirmed.status).toBe(200);
    expect(agent.calls.at(-1)).toMatchObject({
      tool: 'create_order',
      input: { amountCents: 15000 },
    });
    paypal.payerApprovesOrder(confirmed.json.orderId!);
    const paid = await call<PayResult>(
      'POST',
      `/pay/${token}/orders/${confirmed.json.orderId}/capture`,
      undefined,
      cookie,
    );
    expect(paid.json.bill.amounts.remainingCents).toBe(0);
    expect((await rowOf('Theo Lambert')).status).toBe('paid');
  });
});
