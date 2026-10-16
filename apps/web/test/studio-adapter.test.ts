import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgLlmRequest } from 'ag-studio';
import { plainbillClaudeAdapter } from '../src/pages/insights/studioAdapter';

const request = { input: [], responseFormat: { type: 'text' } } as unknown as AgLlmRequest;

function streamed(chunks: string[], status = 200) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'application/x-ndjson' } });
}

async function run(response: Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response),
  );
  const handler = plainbillClaudeAdapter('/api/studio/llm').executeTurn(request);
  const events: unknown[] = [];
  for await (const e of handler.stream) events.push(e);
  return { events, response: await handler.complete };
}

afterEach(() => vi.unstubAllGlobals());

describe('plainbillClaudeAdapter', () => {
  it('reads NDJSON events and the response, even when a line is split across chunks', async () => {
    const lines = [
      { event: { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' } },
      { event: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'UHC denied the most.' } },
      { event: { type: 'TEXT_MESSAGE_END', messageId: 'm' } },
      { response: { id: 'm', createdAt: 1, status: 'completed', output: [] } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n');
    const { events, response } = await run(
      streamed([lines.slice(0, 40), lines.slice(40, 130), `${lines.slice(130)}\n`]),
    );
    expect(events).toHaveLength(3);
    expect(events[1]).toMatchObject({ delta: 'UHC denied the most.' });
    expect(response).toMatchObject({ id: 'm', status: 'completed' });
  });

  it('turns an HTTP error into a failed turn with the API’s message', async () => {
    const { events, response } = await run(
      new Response(JSON.stringify({ message: 'Too many questions this hour.' }), { status: 429 }),
    );
    expect(events).toEqual([]);
    expect(response).toMatchObject({
      status: 'failed',
      error: { message: 'Too many questions this hour.' },
    });
  });

  it('fails the turn when the stream ends without a response', async () => {
    const { response } = await run(
      streamed([`${JSON.stringify({ event: { type: 'TEXT_MESSAGE_END', messageId: 'm' } })}\n`]),
    );
    expect(response).toMatchObject({ status: 'failed' });
  });
});
