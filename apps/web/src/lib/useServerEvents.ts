import { useEffect, useRef } from 'react';
import { connectServerEvents, type ServerEventHandlers } from './serverEvents';

export type { ServerEventHandlers } from './serverEvents';

/** Subscribe to /api/events (Server-Sent Events) for as long as the component is mounted. */
export function useServerEvents(handlers: ServerEventHandlers): void {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });
  useEffect(() => connectServerEvents(() => ref.current), []);
}
