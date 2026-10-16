/**
 * The server sends a `ping` event every 15 s. If nothing at all arrives for this long, the
 * stream is dead even if EventSource still says it's open (a proxy can keep the browser's side
 * of a connection alive after the API behind it restarted), so we reconnect.
 */
export const SSE_SILENCE_MS = 40_000;

export function isSilent(lastSeenAt: number, now: number, limit = SSE_SILENCE_MS): boolean {
  return now - lastSeenAt > limit;
}
