import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type {
  AgingChart,
  BalanceRow,
  DenialsChart,
  Kpis,
  PaymentEvent,
} from '@plainbill/api/contract';
import { useShell } from '../components/AppShell';
import {
  BalancesGrid,
  type BalancesGridHandle,
  type GroupBy,
  type View,
} from '../components/BalancesGrid';
import { KpiStrip } from '../components/KpiStrip';
import { ReminderPopover } from '../components/ReminderPopover';
import { ReviewDrawer } from '../components/ReviewDrawer';
import { toast } from '../components/Toast';
import { AgingChartCard, DenialsChartCard } from '../components/SideCharts';
import { api, ApiError } from '../lib/api';
import { greeting, todoSummary } from '../lib/dashboard';
import { useServerEvents } from '../lib/useServerEvents';

export function Dashboard() {
  const { practice, search, setSearch } = useShell();
  const navigate = useNavigate();
  const grid = useRef<BalancesGridHandle>(null);

  const [rows, setRows] = useState<BalanceRow[] | null>(null);
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [aging, setAging] = useState<AgingChart | null>(null);
  const [denials, setDenials] = useState<DenialsChart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>('status');
  const [drawerId, setDrawerId] = useState<number | null>(null);
  const [reminder, setReminder] = useState<{ row: BalanceRow; anchor: HTMLElement } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [view, setView] = useState<View>('action');
  const [chartOpen, setChartOpen] = useState(false);
  const chartHost = useRef<HTMLDivElement>(null);

  // "Chart this": an integrated chart in the panel above the grid, redrawn when the grouping
  // changes. It stays linked to the grid, so filters and live payments update it.
  const hasRows = rows !== null;
  useEffect(() => {
    if (!chartOpen || !hasRows || !chartHost.current) return;
    const chart = grid.current?.chart(chartHost.current);
    return () => chart?.destroyChart();
  }, [chartOpen, groupBy, hasRows]);

  const refreshSummary = useCallback(async () => {
    const [k, a, d] = await Promise.all([api.kpis(), api.agingChart(), api.denialsChart()]);
    setKpis(k);
    setAging(a);
    setDenials(d);
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      const [r] = await Promise.all([api.balances(), refreshSummary()]);
      setRows(r);
      setError(null);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'not_seeded'
          ? 'The database is empty. Run `pnpm seed`, then reload.'
          : `Could not reach the Plainbill API (${(err as Error).message}). Is \`pnpm dev\` running?`,
      );
    }
  }, [refreshSummary]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useServerEvents({
    onPayment: (event: PaymentEvent) => {
      grid.current?.applyPayment(event.balance);
      void refreshSummary();
    },
    onBalancesChanged: () => void refreshAll(),
    onOpen: () => void refreshAll(),
  });

  /** The ✦ button: reminders and plan offers confirm in a popover; the rest open the drawer. */
  const runSuggestion = (row: BalanceRow, anchor: HTMLElement) => {
    if (row.aiAction === 'send_reminder' || row.aiAction === 'offer_plan') {
      setReminder({ row, anchor });
    } else {
      setDrawerId(row.id);
    }
  };

  const refreshSuggestions = async () => {
    setRefreshing(true);
    try {
      const r = await api.refreshSuggestions();
      toast(
        r.via === 'claude'
          ? `✦ ${r.updated} suggestions updated by Claude (${r.model})`
          : `✦ ${r.updated} suggestions updated by the rules (AI offline)`,
      );
    } catch (err) {
      toast(`Couldn’t refresh suggestions: ${err instanceof ApiError ? err.message : String(err)}`);
    } finally {
      setRefreshing(false);
    }
  };

  const startReview = () => {
    if (kpis?.review.firstBalanceId == null) return;
    grid.current?.reveal(kpis.review.firstBalanceId);
    setDrawerId(kpis.review.firstBalanceId);
  };

  const firstName = practice?.user.firstName ?? 'Rosa';
  const reviewCount = kpis?.review.count ?? 0;

  return (
    <main className="page">
      <div className="greeting-row">
        <div>
          <h1 className="greeting">
            {greeting(new Date().getHours())}, {firstName}
          </h1>
          <p className="greeting-sub">{kpis ? todoSummary(kpis) : ' '}</p>
        </div>
        <div className="greeting-actions">
          <button type="button" className="btn" onClick={() => navigate('/intake')}>
            Upload remittance
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={startReview}
            disabled={reviewCount === 0}
          >
            Start review ({reviewCount}) →
          </button>
        </div>
      </div>

      {error && (
        <div className="banner" role="alert">
          {error}
        </div>
      )}

      <KpiStrip kpis={kpis} aging={aging} onStartReview={startReview} />

      <div className="main-split">
        <section className="card grid-card" aria-labelledby="balances-title">
          <div className="grid-toolbar">
            <h2 className="grid-title" id="balances-title">
              Patient balances
            </h2>
            <div className="segmented" role="group" aria-label="Which balances to show">
              <button
                type="button"
                aria-pressed={view === 'action'}
                onClick={() => setView('action')}
              >
                Needs action
              </button>
              <button type="button" aria-pressed={view === 'all'} onClick={() => setView('all')}>
                All
              </button>
            </div>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              className="ai-refresh"
              onClick={refreshSuggestions}
              disabled={refreshing}
              title="Ask the AI for a fresh next step on every open balance"
            >
              <span aria-hidden="true">✦</span> {refreshing ? 'Thinking…' : 'Refresh suggestions'}
            </button>
            <button
              type="button"
              className="chart-this"
              aria-pressed={chartOpen}
              aria-controls="balances-chart"
              onClick={() => setChartOpen((open) => !open)}
              disabled={!rows}
              title="Chart the balances on screen by the current grouping"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                <rect x="1" y="7" width="3" height="6" rx="1" />
                <rect x="5.5" y="3" width="3" height="10" rx="1" />
                <rect x="10" y="5" width="3" height="8" rx="1" />
              </svg>
              Chart this
            </button>
            <label className="group-by">
              Group by
              <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
                <option value="status">Status</option>
                <option value="payer">Payer</option>
                <option value="provider">Provider</option>
              </select>
            </label>
            <input
              className="quick-filter"
              type="search"
              placeholder="Quick filter…"
              aria-label="Quick filter"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {chartOpen && (
            <div className="grid-chart" id="balances-chart">
              <div className="grid-chart-host" ref={chartHost} />
              <button
                type="button"
                className="grid-chart-close"
                aria-label="Close chart"
                onClick={() => setChartOpen(false)}
              >
                ×
              </button>
            </div>
          )}
          {rows && practice && (
            <BalancesGrid
              ref={grid}
              rows={rows}
              today={practice.today}
              groupBy={groupBy}
              view={view}
              quickFilter={search}
              onOpenDrawer={setDrawerId}
              onRunSuggestion={runSuggestion}
            />
          )}
        </section>

        <aside className="side" aria-label="Charts">
          <AgingChartCard chart={aging} />
          <DenialsChartCard chart={denials} />
        </aside>
      </div>
      {drawerId !== null && <ReviewDrawer balanceId={drawerId} onClose={() => setDrawerId(null)} />}
      {reminder && (
        <ReminderPopover
          row={reminder.row}
          anchor={reminder.anchor}
          onClose={() => setReminder(null)}
        />
      )}
    </main>
  );
}
