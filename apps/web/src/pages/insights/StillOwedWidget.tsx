/**
 * "Still owed": a scoreboard of open balances (not a collections report), longest-waiting first,
 * with a friendly Send reminder button for bills that went out. A custom AG Studio widget: it
 * reads balance ids, amounts and days out through Studio's data engine (so page filters and
 * cross-filters apply), and looks patient names up from the staff API itself, so names never
 * enter Studio's data, which its AI agent reads.
 */
import { useCallback, useEffect, useState } from 'react';
import type { AgWidgetField, AgWidgetParams } from 'ag-studio';
import type { BalanceRow } from '@plainbill/api/contract';
import { api, ApiError } from '../../lib/api';
import { formatMoneyShort } from '@plainbill/core';

interface Entry {
  balanceId: number;
  stillOwed: number;
  daysOut: number;
  status: string;
}

type SendState = 'idle' | 'confirm' | 'sending' | 'sent' | { error: string };

const FIELDS = ['balanceId', 'stillOwed', 'daysOut', 'status'] as const;

export function StillOwedWidget({ widgetApi }: AgWidgetParams) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [names, setNames] = useState<Map<number, BalanceRow>>(new Map());
  const [send, setSend] = useState<Record<number, SendState>>({});

  const load = useCallback(async () => {
    widgetApi.setDisplayState('loading');
    const table = widgetApi.getSchema().find((t) => t.id === 'balances');
    const fields = FIELDS.map((id) =>
      table?.fields.find((f) => String(f.fieldId) === `balances.${id}`),
    );
    if (fields.some((f) => !f)) {
      widgetApi.setDisplayState('noData');
      return;
    }
    const found = fields as AgWidgetField[];
    const [result, rows] = await Promise.all([
      widgetApi.getData({ fields: found }),
      api.balances(),
    ]);
    const read = (row: Record<string, unknown>, i: number) => row[found[i]!.key];
    const open = result.results.rows
      .map((r) => ({
        balanceId: Number(read(r, 0)),
        stillOwed: Number(read(r, 1)),
        daysOut: Number(read(r, 2)),
        status: String(read(r, 3)),
      }))
      .filter((e) => e.stillOwed > 0)
      .sort((a, b) => b.daysOut - a.daysOut || b.stillOwed - a.stillOwed);
    setNames(new Map(rows.map((r) => [r.id, r])));
    setEntries(open);
    widgetApi.setDisplayState(open.length ? 'displayed' : 'noData');
  }, [widgetApi]);

  useEffect(() => {
    void load();
  }, [load]);

  const remind = async (id: number) => {
    setSend((s) => ({ ...s, [id]: 'sending' }));
    try {
      await api.remind(id);
      setSend((s) => ({ ...s, [id]: 'sent' }));
    } catch (err) {
      setSend((s) => ({
        ...s,
        [id]: { error: err instanceof ApiError ? err.message : 'Could not send the reminder.' },
      }));
    }
  };

  if (!entries) return null;
  const max = Math.max(...entries.map((e) => e.daysOut), 1);

  return (
    <ol className="owed-board" aria-label="Open balances, longest waiting first">
      {entries.map((e) => {
        const row = names.get(e.balanceId);
        const state = send[e.balanceId] ?? 'idle';
        const canRemind = e.status === 'Sent' || e.status === 'Partially paid';
        return (
          <li key={e.balanceId} className="owed-row">
            <div className="owed-who">
              <span className="owed-name">{row?.patientName ?? `Balance ${e.balanceId}`}</span>
              <span className="owed-meta">
                {e.status} · {row?.payerKind === 'self-pay' ? 'Self-pay' : row?.payerShortName}
              </span>
            </div>
            <span className="owed-amount">{formatMoneyShort(Math.round(e.stillOwed * 100))}</span>
            <div className="owed-days" aria-label={`${e.daysOut} days`}>
              <span
                className="owed-bar"
                style={{ width: `${Math.max(6, (e.daysOut / max) * 100)}%` }}
              />
              <span className="owed-days-label">{e.daysOut} days</span>
            </div>
            <span className="owed-action">
              {!canRemind ? (
                <span className="owed-note">
                  {e.status === 'Ready to invoice' ? 'Not sent yet' : 'Needs review'}
                </span>
              ) : state === 'idle' ? (
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => setSend((s) => ({ ...s, [e.balanceId]: 'confirm' }))}
                >
                  Send reminder
                </button>
              ) : state === 'confirm' ? (
                <span className="owed-confirm">
                  <button
                    type="button"
                    className="btn btn-small btn-primary"
                    onClick={() => void remind(e.balanceId)}
                  >
                    Email {row?.patientFirstName ?? 'them'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-small btn-quiet"
                    onClick={() => setSend((s) => ({ ...s, [e.balanceId]: 'idle' }))}
                  >
                    Cancel
                  </button>
                </span>
              ) : state === 'sending' ? (
                <span className="owed-note">Sending…</span>
              ) : state === 'sent' ? (
                <span className="owed-note owed-sent">✓ Reminder sent</span>
              ) : (
                <span className="owed-note owed-error" role="alert">
                  {state.error}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The widget's registration with AG Studio. */
export const stillOwedWidget = {
  id: 'still-owed',
  label: 'Still owed',
  dataMapping: {},
  form: (params: { createDefaults: (p: object) => unknown }) =>
    params.createDefaults({ dataMappingItems: [] }),
  comp: StillOwedWidget,
  defaultSize: { width: 520, height: 520 },
  minSize: { width: 360, height: 240 },
};
