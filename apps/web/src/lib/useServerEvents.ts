import { useEffect, useRef } from 'react';
import type { BalancesChangedEvent, PaymentEvent } from '@plainbill/api/contract';
import { isSilent, SSE_SILENCE_MS } from './sseWatchdog';

export interface ServerEventHandlers {
  onPayment?: (event: PaymentEvent) => void;
  onBalancesChanged?: (event: BalancesChangedEvent) => void;
  /** Fires on every (re)connect; refetch here so nothing missed while offline is lost. */
  onOpen?: () => void;
}

/**
 * Subscribe to /api/events (Server-Sent Events). EventSource reconnects on its own when the
 * connection drops; when it silently dies instead (no ping for SSE_SILENCE_MS, e.g. behind a
 * proxy after an API restart), we close it and open a new one.
 */
export function useServerEvents(handlers: ServerEventHandlers): void {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    let source: EventSource | null = null;
    let opened = false;
    let lastSeenAt = Date.now();
    const seen = () => {
      lastSeenAt = Date.now();
    };

    const connect = () => {
      source?.close();
      seen();
      const next = new EventSource('/api/events');
      source = next;
      next.onopen = () => {
        seen();
        // The first open happens alongside the initial fetch; refetch only on reconnects.
        if (opened) ref.current.onOpen?.();
        opened = true;
      };
      next.addEventListener('ping', seen);
      next.addEventListener('payment', (e) => {
        seen();
        ref.current.onPayment?.(JSON.parse((e as MessageEvent<string>).data) as PaymentEvent);
      });
      next.addEventListener('balances.changed', (e) => {
        seen();
        ref.current.onBalancesChanged?.(
          JSON.parse((e as MessageEvent<string>).data) as BalancesChangedEvent,
        );
      });
    };

    connect();
    const watchdog = window.setInterval(() => {
      if (isSilent(lastSeenAt, Date.now())) connect();
    }, SSE_SILENCE_MS / 4);
    return () => {
      window.clearInterval(watchdog);
      source?.close();
    };
  }, []);
}
