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
import { ReviewDrawer } from '../components/ReviewDrawer';
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
  const [view, setView] = useState<View>('action');

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

      <KpiStrip kpis={kpis} onStartReview={startReview} />

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
          {rows && practice && (
            <BalancesGrid
              ref={grid}
              rows={rows}
              today={practice.today}
              groupBy={groupBy}
              view={view}
              quickFilter={search}
              onOpenDrawer={setDrawerId}
            />
          )}
        </section>

        <aside className="side" aria-label="Charts">
          <AgingChartCard chart={aging} />
          <DenialsChartCard chart={denials} />
        </aside>
      </div>
      {drawerId !== null && <ReviewDrawer balanceId={drawerId} onClose={() => setDrawerId(null)} />}
    </main>
  );
}
