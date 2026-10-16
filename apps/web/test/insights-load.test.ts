import { describe, expect, it } from 'vitest';
import { afterLoad, LOAD_ERROR, STALE_NOTICE } from '../src/pages/insights/loadState';

describe('Insights load state', () => {
  it('keeps the report on screen when a reload fails, and clears the notice on the next load', () => {
    // Found live: the API restarted with /insights open, the reload failed, and the whole report
    // (and the analyst's conversation) was replaced by an error that never went away.
    const loaded = afterLoad({ data: null, error: null }, { ok: true, data: { n: 1 } });
    const failed = afterLoad(loaded, { ok: false });
    expect(failed).toEqual({ data: { n: 1 }, error: STALE_NOTICE });
    expect(afterLoad(failed, { ok: true, data: { n: 2 } })).toEqual({
      data: { n: 2 },
      error: null,
    });
  });

  it('shows the error alone only when nothing has loaded yet, and recovers', () => {
    const first = afterLoad<{ n: number }>({ data: null, error: null }, { ok: false });
    expect(first).toEqual({ data: null, error: LOAD_ERROR });
    expect(afterLoad(first, { ok: true, data: { n: 1 } })).toEqual({ data: { n: 1 }, error: null });
  });
});
