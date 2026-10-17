/**
 * Practice insights: an AG Studio report for the office manager, with Studio's AI agent running
 * on Claude (through /api/studio/llm). The front-desk grid stays the dashboard; this is where
 * someone asks "which payer denied the most this quarter?" and gets a chart.
 */
import './insights.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AgStudio, AgStudioProvider, createWidgets } from 'ag-studio-react';
import {
  AgStudioAiModule,
  AgStudioModuleRegistry,
  createAiHarness,
  studioTheme,
  type AgStudioApi,
} from 'ag-studio';
import type { InsightsData } from '@plainbill/api/contract';
import { api } from '../../lib/api';
import { useServerEvents } from '../../lib/useServerEvents';
import { plainbillClaudeAdapter } from './studioAdapter';
import { afterLoad, type InsightsLoadState } from './loadState';
import { INITIAL_REPORT, insightsSources, PROMPT_STARTERS } from './report';
import { stillOwedWidget } from './StillOwedWidget';
import { moneyFlowWidget } from './MoneyFlowWidget';

AgStudioModuleRegistry.registerModules([AgStudioAiModule]);

const theme = studioTheme.withParams({
  fontFamily: 'Figtree, system-ui, -apple-system, "Segoe UI", sans-serif',
  fontSize: 13,
  accentColor: '#1D5C5C',
  foregroundColor: '#1C2B2D',
  textColor: '#1C2B2D',
  subtleTextColor: '#5C6766',
  backgroundColor: '#FFFFFF',
  borderColor: '#E5E1D9',
  borderRadius: 8,
  iconColor: '#5C6766',
  rowHoverColor: '#FBFAF7',
  chartPaletteFills1Color: '#1D5C5C',
  chartPaletteFills2Color: '#7FA8A3',
  chartPaletteFills3Color: '#D9A53C',
  chartPaletteFills4Color: '#B5483E',
  chartPaletteFills5Color: '#23518C',
  chartPaletteFills6Color: '#5C6766',
});

const adapter = plainbillClaudeAdapter();
const ai = ({ api: studio }: { api: AgStudioApi }) =>
  createAiHarness(studio, { adapter, promptStarters: PROMPT_STARTERS });

// The registry's generics don't model a custom widget with no data mapping; the shape is
// checked by Studio at runtime (enableStudioDevValidations in development).
const widgets = (config: { menu: Array<{ label: string; widgetIds: string[] }> }) =>
  createWidgets({
    additionalTypes: [moneyFlowWidget, stillOwedWidget],
    menu: [...config.menu, { label: 'Plainbill', widgetIds: ['money-flow', 'still-owed'] }],
  } as never);

export function Insights() {
  const [{ data, error }, setLoad] = useState<InsightsLoadState<InsightsData>>({
    data: null,
    error: null,
  });

  const reload = useCallback(() => {
    api
      .insights()
      .then((next) => setLoad((prev) => afterLoad(prev, { ok: true, data: next })))
      .catch(() => setLoad((prev) => afterLoad(prev, { ok: false })));
  }, []);
  useEffect(reload, [reload]);
  // A payment (webhook, capture or the poll) or any balance change: Studio gets the new data and
  // the money flow re-balances, with a coin moving into Collected.
  useServerEvents({ onPayment: reload, onBalancesChanged: reload, onOpen: reload });

  const sources = useMemo(() => (data ? insightsSources(data) : null), [data]);

  return (
    <main className="insights-page">
      <header className="insights-head">
        <div>
          <h1>Practice insights</h1>
          <p>
            Ask the AI analyst about balances, payments and denials. It builds the charts; every
            amount comes from the same computed balances as the dashboard.
          </p>
        </div>
        <span className="insights-badge">AG Studio · Claude</span>
      </header>
      {error && sources ? (
        <p className="insights-stale" role="status">
          {error}
        </p>
      ) : null}
      {sources ? (
        <div className="insights-studio">
          {/* Licensed by the AG Grid key that agGrid.ts applies at startup. */}
          <AgStudioProvider>
            <AgStudio
              mode="edit"
              theme={theme as never}
              data={sources as never}
              initialState={INITIAL_REPORT as never}
              widgets={widgets as never}
              ai={ai as never}
              style={{ height: '100%' }}
            />
          </AgStudioProvider>
        </div>
      ) : error ? (
        <p className="insights-error" role="alert">
          {error}
        </p>
      ) : (
        <p className="insights-loading">Loading practice data…</p>
      )}
    </main>
  );
}
