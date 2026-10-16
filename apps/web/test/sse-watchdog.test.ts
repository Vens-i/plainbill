import { describe, expect, it } from 'vitest';
import { isSilent, SSE_SILENCE_MS } from '../src/lib/sseWatchdog';

describe('SSE watchdog', () => {
  it('allows two missed pings (15 s apart) before calling a stream dead', () => {
    expect(SSE_SILENCE_MS).toBeGreaterThan(2 * 15_000);
    expect(isSilent(0, SSE_SILENCE_MS)).toBe(false);
    expect(isSilent(0, SSE_SILENCE_MS + 1)).toBe(true);
  });
});
