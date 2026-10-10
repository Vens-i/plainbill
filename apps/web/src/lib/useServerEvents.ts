import { useEffect, useRef } from 'react';
import type { BalancesChangedEvent, PaymentEvent } from '@plainbill/api/contract';

export interface ServerEventHandlers {
  onPayment?: (event: PaymentEvent) => void;
  onBalancesChanged?: (event: BalancesChangedEvent) => void;
  /** Fires on every (re)connect; refetch here so nothing missed while offline is lost. */
  onOpen?: () => void;
}

/** Subscribe to /api/events (Server-Sent Events). EventSource reconnects on its own. */
export function useServerEvents(handlers: ServerEventHandlers): void {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    const source = new EventSource('/api/events');
    let opened = false;
    source.onopen = () => {
      // The first open happens alongside the initial fetch; refetch only on reconnects.
      if (opened) ref.current.onOpen?.();
      opened = true;
    };
    source.addEventListener('payment', (e) => {
      ref.current.onPayment?.(JSON.parse((e as MessageEvent<string>).data) as PaymentEvent);
    });
    source.addEventListener('balances.changed', (e) => {
      ref.current.onBalancesChanged?.(
        JSON.parse((e as MessageEvent<string>).data) as BalancesChangedEvent,
      );
    });
    return () => source.close();
  }, []);
}
