/**
 * Side-panel charts (AG Charts): patient balances by age, and denials by payer. Data comes from
 * /api/charts/*; bar lengths use integer cents and labels use @plainbill/core formatting.
 */
import { useEffect, useMemo, useState } from 'react';
import { AgCharts } from 'ag-charts-react';
import type { AgCartesianChartOptions } from 'ag-charts-community';
import { formatMoneyShort } from '@plainbill/core';
import type { AgingChart, DenialsChart } from '@plainbill/api/contract';
import { CHART_COLORS } from '../theme';

const ROW_HEIGHT = 30;

/**
 * Canvas text is measured when a chart is created, so explicitly load the Figtree weights the
 * charts use first; otherwise labels are sized with a fallback font and get clipped.
 */
const chartFonts =
  typeof document === 'undefined'
    ? Promise.resolve()
    : Promise.all(['400 13px Figtree', '600 13px Figtree'].map((f) => document.fonts.load(f))).then(
        () => undefined,
        () => undefined,
      );

function useFontsReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void chartFonts.then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return ready;
}

function barOptions<T extends object>(params: {
  data: T[];
  xKey: keyof T & string;
  yKey: keyof T & string;
  fill: string;
  label: (datum: T) => string;
  tooltip: (datum: T) => string;
}): AgCartesianChartOptions {
  const largest = Math.max(1, ...params.data.map((d) => Number(d[params.yKey]) || 0));
  return {
    data: params.data,
    height: params.data.length * ROW_HEIGHT + 8,
    background: { visible: false },
    padding: { top: 0, right: 4, bottom: 0, left: 4 },
    legend: { enabled: false },
    animation: { enabled: true },
    series: [
      {
        type: 'bar',
        direction: 'horizontal',
        xKey: params.xKey,
        yKey: params.yKey,
        fill: params.fill,
        cornerRadius: 4,
        label: {
          enabled: true,
          placement: 'outside-end',
          color: CHART_COLORS.ink,
          fontFamily: 'Figtree',
          fontSize: 13,
          formatter: ({ datum }) => params.label(datum as T),
        },
        tooltip: {
          renderer: ({ datum }) => ({ title: '', content: params.tooltip(datum as T) }),
        },
      },
    ],
    axes: {
      x: {
        type: 'category',
        position: 'left',
        line: { enabled: false },
        label: { fontFamily: 'Figtree', fontSize: 13, fontWeight: 600, color: CHART_COLORS.ink },
        paddingInner: 0.45,
        paddingOuter: 0.1,
      },
      y: {
        type: 'number',
        position: 'bottom',
        label: { enabled: false },
        gridLine: { enabled: false },
        line: { enabled: false },
        min: 0,
        // Headroom so the value label after the longest bar stays inside the chart.
        max: largest * 1.4,
        nice: false,
      },
    },
  };
}

export function AgingChartCard({ chart }: { chart: AgingChart | null }) {
  const fontsReady = useFontsReady();
  const options = useMemo(
    () =>
      chart && fontsReady
        ? barOptions({
            data: chart.buckets.map((b) => ({ label: b.label, cents: b.cents, count: b.count })),
            xKey: 'label',
            yKey: 'cents',
            fill: CHART_COLORS.teal,
            label: (d) => formatMoneyShort(d.cents),
            tooltip: (d) =>
              `${d.label} days: ${formatMoneyShort(d.cents)} across ${d.count} ${d.count === 1 ? 'visit' : 'visits'}`,
          })
        : null,
    [chart, fontsReady],
  );
  return (
    <section className="card chart-card" aria-labelledby="aging-title">
      <h2 className="chart-title" id="aging-title">
        Balances by age
      </h2>
      <p className="chart-sub">
        Patient-owed, {chart ? formatMoneyShort(chart.totalCents) : '…'} total
      </p>
      {options && <AgCharts options={options} />}
      {chart && (
        <table className="visually-hidden">
          <caption>Patient-owed balances by days since visit</caption>
          <tbody>
            {chart.buckets.map((b) => (
              <tr key={b.bucket}>
                <th scope="row">{b.label} days</th>
                <td>{formatMoneyShort(b.cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function DenialsChartCard({ chart }: { chart: DenialsChart | null }) {
  const fontsReady = useFontsReady();
  const options = useMemo(
    () =>
      chart && fontsReady && chart.payers.length
        ? barOptions({
            data: chart.payers,
            xKey: 'shortName',
            yKey: 'count',
            fill: CHART_COLORS.denial,
            label: (d) => String(d.count),
            tooltip: (d) => `${d.payer}: ${d.count} ${d.count === 1 ? 'denial' : 'denials'}`,
          })
        : null,
    [chart, fontsReady],
  );
  return (
    <section className="card chart-card" aria-labelledby="denials-title">
      <h2 className="chart-title" id="denials-title">
        Denials by payer
      </h2>
      <p className="chart-sub">Last {chart?.windowDays ?? 90} days</p>
      {options ? (
        <AgCharts options={options} />
      ) : (
        chart && <div className="chart-empty">No insurance claims yet.</div>
      )}
      {chart?.mostCommon && (
        <div className="chart-foot">
          <b>Most common:</b> {chart.mostCommon.label.toLowerCase()} ({chart.mostCommon.code}).{' '}
          {chart.mostCommon.count} of {chart.total}.
        </div>
      )}
    </section>
  );
}
