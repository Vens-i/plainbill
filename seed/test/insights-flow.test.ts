/**
 * Practice insights (AG Studio): the report's data and the agent's Claude bridge endpoint.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StudioRunner, StudioStreamLine, StudioTurnRequest } from '@plainbill/ai';
import { buildApp, offlineAi, openDatabase, type InsightsData } from '@plainbill/api';
import { loadSeed } from '../src/load';
import { SEED_TODAY } from '../src/spec';

/** Records the turns it gets and answers with a scripted tool call. */
class ScriptedRunner implements StudioRunner {
  readonly live = true;
  readonly seen: StudioTurnRequest[] = [];
  async *run(request: StudioTurnRequest): AsyncIterable<StudioStreamLine> {
    this.seen.push(request);
    yield { event: { type: 'TOOL_CALL_START', toolCallId: 't1', toolCallName: 'view_schema' } };
    yield { event: { type: 'TOOL_CALL_ARGS', toolCallId: 't1', delta: '{}' } };
    yield { event: { type: 'TOOL_CALL_END', toolCallId: 't1' } };
    yield {
      response: {
        id: 'r1',
        createdAt: 0,
        status: 'completed',
        output: [
          {
            id: 't1',
            kind: 'output',
            type: 'function_call',
            callId: 't1',
            name: 'view_schema',
            arguments: '{}',
            status: 'completed',
          },
        ],
      },
    };
  }
}

const runner = new ScriptedRunner();
let app: ReturnType<typeof buildApp>['app'];
let offline: ReturnType<typeof buildApp>['app'];
let close: () => void;

beforeAll(async () => {
  const opened = openDatabase(':memory:');
  close = opened.close;
  await loadSeed(opened.db, { now: '2026-10-10T13:00:00.000Z' });
  app = buildApp({
    db: opened.db,
    demoToday: SEED_TODAY,
    ai: { ...offlineAi(), studio: runner },
  }).app;
  offline = buildApp({ db: opened.db, demoToday: SEED_TODAY }).app;
});
afterAll(async () => {
  await app.close();
  await offline.close();
  close();
});

const lines = (body: string) =>
  body
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as StudioStreamLine);

describe('GET /api/insights/data', () => {
  let data: InsightsData;
  beforeAll(async () => {
    data = (await app.inject({ method: 'GET', url: '/api/insights/data' })).json();
  });

  it('has every balance, in dollars, with the grid’s numbers', () => {
    expect(data.today).toBe('2026-10-10');
    expect(data.balances).toHaveLength(14);
    const owed = data.balances.reduce((s, b) => s + b.stillOwed, 0);
    // Review $1,078 + ready $665 + sent $480 + partial $600 (denied rows owe nothing).
    expect(owed).toBeCloseTo(2823, 2);
    expect(data.balances.find((b) => b.balanceId === 1)).toMatchObject({
      status: 'Ready to invoice',
      payer: 'BlueCross',
      provider: 'Dr. Patel',
      billed: 850,
      insuranceDiscount: 400,
      insurancePaid: 210,
      patientShare: 240,
      stillOwed: 240,
      aging: '0–30 days',
    });
    expect(data.balances.filter((b) => b.splitVisit)).toHaveLength(1);
  });

  it('never carries a patient name (its query results go to the model)', () => {
    const text = JSON.stringify(data);
    for (const name of ['Maria', 'Delgado', 'Theo', 'Lambert', 'Whitfield', 'Bello']) {
      expect(text).not.toContain(name);
    }
  });

  it('lists payments and adjustments, including denials with their reason', () => {
    expect(data.payments.map((p) => [p.paidOn, p.amount, p.method])).toEqual(
      expect.arrayContaining([
        ['2026-07-15', 300, 'PayPal'],
        ['2026-09-16', 100, 'PayPal'],
      ]),
    );
    const denials = data.adjustments.filter((a) => a.denied);
    expect(denials.map((a) => [a.payer, a.code])).toEqual(
      expect.arrayContaining([
        ['BlueCross', 'CO-197'],
        ['UnitedHealth', 'CO-16'],
      ]),
    );
    expect(data.adjustments.every((a) => a.amount > 0)).toBe(true);
  });
});

describe('POST /api/studio/llm', () => {
  const turn: StudioTurnRequest = {
    instructions: 'You build dashboards.',
    input: [
      {
        kind: 'input',
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: 'Which payer denied the most?' }],
      },
    ],
    tools: [{ name: 'view_schema', description: 'See the data', parameters: { type: 'object' } }],
  };

  it('streams the runner’s events, then one response, as NDJSON', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/studio/llm', payload: turn });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    const out = lines(res.body);
    expect(out.map((l) => ('event' in l ? l.event.type : 'response'))).toEqual([
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'response',
    ]);
    expect(runner.seen.at(-1)!.instructions).toBe('You build dashboards.');
  });

  it('answers offline with a note about the key', async () => {
    const res = await offline.inject({ method: 'POST', url: '/api/studio/llm', payload: turn });
    expect(res.body).toContain('ANTHROPIC_API_KEY');
    expect(lines(res.body).at(-1)).toMatchObject({ response: { status: 'completed' } });
  });

  it('refuses something that is not a Studio turn', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/studio/llm', payload: { hello: 1 } });
    expect(res.statusCode).toBe(400);
  });
});
