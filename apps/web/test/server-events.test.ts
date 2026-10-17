import { describe, expect, it, vi } from 'vitest';
import {
  connectServerEvents,
  type EventSourceLike,
  type ServerEventsEnv,
} from '../src/lib/serverEvents';
import { SSE_SILENCE_MS } from '../src/lib/sseWatchdog';

class FakeSource implements EventSourceLike {
  onopen: ((ev: Event) => unknown) | null = null;
  closed = false;
  private listeners = new Map<string, (ev: MessageEvent<string>) => void>();
  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void) {
    this.listeners.set(type, listener);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.(new Event('open'));
  }
  emit(type: string, data: unknown) {
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
}

function setup() {
  let now = 0;
  const sources: FakeSource[] = [];
  let tick: () => void = () => undefined;
  const env: ServerEventsEnv = {
    open: () => {
      const s = new FakeSource();
      sources.push(s);
      return s;
    },
    now: () => now,
    every: (_ms, fn) => {
      tick = fn;
      return () => undefined;
    },
  };
  const handlers = { onOpen: vi.fn(), onPayment: vi.fn(), onBalancesChanged: vi.fn() };
  const stop = connectServerEvents(() => handlers, env);
  const advance = (ms: number) => {
    now += ms;
    tick();
  };
  return { sources, handlers, advance, stop };
}

describe('connectServerEvents', () => {
  it('refetches on the first open too, so a page opened while the API was down recovers', () => {
    // Found live: /insights opened during an API restart showed "Could not load the practice
    // data" forever, because only re-opens called onOpen.
    const { sources, handlers } = setup();
    sources[0]!.open();
    expect(handlers.onOpen).toHaveBeenCalledTimes(1);
  });

  it('reconnects (and refetches) when a stream goes silent, but not while pings arrive', () => {
    const { sources, handlers, advance } = setup();
    sources[0]!.open();
    for (let i = 0; i < 6; i++) {
      advance(15_000);
      sources[0]!.emit('ping', {});
    }
    expect(sources).toHaveLength(1);

    advance(SSE_SILENCE_MS + 1);
    expect(sources).toHaveLength(2);
    expect(sources[0]!.closed).toBe(true);
    sources[1]!.open();
    expect(handlers.onOpen).toHaveBeenCalledTimes(2);
  });

  it('passes payments and balance changes through, and closes on stop', () => {
    const { sources, handlers, stop } = setup();
    sources[0]!.emit('payment', { balance: { id: 12 } });
    sources[0]!.emit('balances.changed', { ids: [12] });
    expect(handlers.onPayment).toHaveBeenCalledWith({ balance: { id: 12 } });
    expect(handlers.onBalancesChanged).toHaveBeenCalledWith({ ids: [12] });
    stop();
    expect(sources[0]!.closed).toBe(true);
  });
});
