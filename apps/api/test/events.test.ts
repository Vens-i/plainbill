import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { EventBus, HEARTBEAT_MS, streamEvents } from '../src/events';

/** The same parsing EventSource does: a block dispatches only with an event and some data. */
function dispatched(chunks: string[]): string[] {
  return chunks
    .join('')
    .split('\n\n')
    .flatMap((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      return event && data ? [event] : [];
    });
}

describe('Server-Sent Events heartbeat', () => {
  afterEach(() => vi.useRealTimers());

  it('sends a ping the browser can see, so a dead stream can be detected', () => {
    // Found live: after an API restart behind Vite's proxy, the browser's EventSource stayed
    // "open" with no upstream, and payments never flashed. ": ping" comments are invisible to
    // EventSource, so the client had nothing to time out on.
    vi.useFakeTimers();
    const chunks: string[] = [];
    const reply = {
      hijack: () => undefined,
      raw: { writeHead: () => undefined, write: (s: string) => chunks.push(s) },
    } as unknown as FastifyReply;
    const request = { raw: { on: () => undefined } } as unknown as FastifyRequest;
    streamEvents(new EventBus(), request, reply);
    expect(dispatched(chunks)).toEqual([]);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(dispatched(chunks)).toEqual(['ping']);
  });
});
