/**
 * What the Insights page shows after each data load. A failed reload (the API restarting, a
 * dropped connection) keeps the report and the analyst's conversation on screen with a short
 * notice; the next successful load clears it. Only a first load that fails shows an error alone.
 */
export interface InsightsLoadState<T> {
  data: T | null;
  error: string | null;
}

export const LOAD_ERROR = 'Could not load the practice data. Is the API running?';
export const STALE_NOTICE =
  'Lost touch with the server. Showing the last numbers we had; they update when it’s back.';

export function afterLoad<T>(
  previous: InsightsLoadState<T>,
  result: { ok: true; data: T } | { ok: false },
): InsightsLoadState<T> {
  if (result.ok) return { data: result.data, error: null };
  return previous.data
    ? { data: previous.data, error: STALE_NOTICE }
    : { data: null, error: LOAD_ERROR };
}
