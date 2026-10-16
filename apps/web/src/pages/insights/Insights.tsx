/**
 * Practice insights: an AG Studio report for the office manager, with Studio's AI agent running
 * on Claude (through /api/studio/llm). The front-desk grid stays the dashboard; this is where
 * someone asks "which payer denied the most this quarter?" and gets a chart.
 */
import './insights.css';
import { useEffect, useMemo, useState } from 'react';
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
import { plainbillClaudeAdapter } from './studioAdapter';
import { INITIAL_REPORT, insightsSources, PROMPT_STARTERS } from './report';
import { stillOwedWidget } from './StillOwedWidget';

AgStudioModuleRegistry.registerModules([AgStudioAiModule]);

const licenseKey = import.meta.env.VITE_AG_STUDIO_LICENSE_KEY?.trim() || undefined;

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
    additionalTypes: [stillOwedWidget],
    menu: [...config.menu, { label: 'Plainbill', widgetIds: ['still-owed'] }],
  } as never);

export function Insights() {
  const [data, setData] = useState<InsightsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .insights()
      .then(setData)
      .catch(() => setError('Could not load the practice data. Is the API running?'));
  }, []);

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
      {error ? (
        <p className="insights-error" role="alert">
          {error}
        </p>
      ) : sources ? (
        <div className="insights-studio">
          <AgStudioProvider {...(licenseKey ? { licenseKey } : {})}>
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
      ) : (
        <p className="insights-loading">Loading practice data…</p>
      )}
    </main>
  );
}
