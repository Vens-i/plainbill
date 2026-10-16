/**
 * In-process event bus + Server-Sent Events. Payment events (from the PayPal webhook later, or
 * the dev simulate route now) are published here and pushed to every open dashboard.
 */
import { EventEmitter } from 'node:events';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ServerEvent } from './contract';

export interface PublishedEvent {
  id: number;
  event: ServerEvent;
}

export class EventBus {
  private readonly emitter = new EventEmitter();
  private seq = 0;

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(event: ServerEvent, id?: number): void {
    this.seq = Math.max(this.seq + 1, id ?? 0);
    this.emitter.emit('event', { id: this.seq, event } satisfies PublishedEvent);
  }

  subscribe(listener: (e: PublishedEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  get listenerCount(): number {
    return this.emitter.listenerCount('event');
  }
}

/**
 * A visible `ping` event (not an SSE comment, which EventSource never surfaces), so the browser
 * can tell a live stream from a dead one: behind a proxy (Vite's in dev), an API restart can
 * leave the browser's connection open with nothing behind it. The client reconnects when pings
 * stop (see useServerEvents).
 */
export const HEARTBEAT_MS = 15_000;
export const HEARTBEAT_CHUNK = 'event: ping\ndata: {}\n\n';

export function streamEvents(bus: EventBus, request: FastifyRequest, reply: FastifyReply): void {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Clients refetch on (re)connect, so no replay is needed; tell them to retry quickly.
  res.write('retry: 3000\n: connected\n\n');

  const unsubscribe = bus.subscribe(({ id, event }) => {
    res.write(`id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
  });
  const heartbeat = setInterval(() => res.write(HEARTBEAT_CHUNK), HEARTBEAT_MS);
  request.raw.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}
