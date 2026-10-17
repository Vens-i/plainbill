/**
 * The /api/events connection, without React, so it can be tested with a fake EventSource.
 *
 * - Every open (the first one too) calls onOpen, so the page refetches: if the API was down when
 *   the page loaded, the first successful open is what brings the data in.
 * - EventSource reconnects on its own when a connection drops, but gives up for good on an HTTP
 *   error (Vite's proxy answers 502 while the API restarts), and a proxy can keep a dead
 *   connection looking open. The server sends a `ping` event every 15 s; when nothing at all has
 *   arrived for SSE_SILENCE_MS, we close the connection and open a new one.
 */
import type { BalancesChangedEvent, PaymentEvent } from '@plainbill/api/contract';
import { isSilent, SSE_SILENCE_MS } from './sseWatchdog';

export interface ServerEventHandlers {
  onPayment?: (event: PaymentEvent) => void;
  onBalancesChanged?: (event: BalancesChangedEvent) => void;
  /** Fires on every (re)connect; refetch here so nothing missed while offline is lost. */
  onOpen?: () => void;
}

/** The parts of EventSource we use. */
export interface EventSourceLike {
  onopen: ((ev: Event) => unknown) | null;
  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void;
  close(): void;
}

export interface ServerEventsEnv {
  open: (url: string) => EventSourceLike;
  now: () => number;
  every: (ms: number, fn: () => void) => () => void;
}

const browserEnv = (): ServerEventsEnv => ({
  open: (url) => new EventSource(url) as unknown as EventSourceLike,
  now: () => Date.now(),
  every: (ms, fn) => {
    const id = window.setInterval(fn, ms);
    return () => window.clearInterval(id);
  },
});

/** Connects and stays connected until the returned function is called. */
export function connectServerEvents(
  handlers: () => ServerEventHandlers,
  env: ServerEventsEnv = browserEnv(),
): () => void {
  let source: EventSourceLike | null = null;
  let lastSeenAt = env.now();
  const seen = () => {
    lastSeenAt = env.now();
  };

  const connect = () => {
    source?.close();
    seen();
    const next = env.open('/api/events');
    source = next;
    next.onopen = () => {
      seen();
      handlers().onOpen?.();
    };
    next.addEventListener('ping', seen);
    next.addEventListener('payment', (e) => {
      seen();
      handlers().onPayment?.(JSON.parse(e.data) as PaymentEvent);
    });
    next.addEventListener('balances.changed', (e) => {
      seen();
      handlers().onBalancesChanged?.(JSON.parse(e.data) as BalancesChangedEvent);
    });
  };

  connect();
  const stop = env.every(SSE_SILENCE_MS / 4, () => {
    if (isSilent(lastSeenAt, env.now())) connect();
  });
  return () => {
    stop();
    source?.close();
  };
}
