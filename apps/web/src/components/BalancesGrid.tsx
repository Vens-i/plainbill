/**
 * The patient balances grid: AG Grid Enterprise with row grouping (by status by default),
 * master/detail, quick filter, custom renderers, a Breakdown sparkline per row, integrated charts
 * ("Chart this", or select cells and right-click → Chart Range), and a live payment flash driven
 * by Server-Sent Events.
 */
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, type Ref } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { AgChartTheme, AgSparklineOptions } from 'ag-charts-community';
import type {
  ChartRef,
  ColDef,
  GetRowIdParams,
  GridApi,
  GridReadyEvent,
  InitialGroupOrderComparatorParams,
  IRowNode,
  RowClassRules,
  RowClickedEvent,
  RowDataUpdatedEvent,
  RowHeightParams,
  ValueFormatterParams,
} from 'ag-grid-community';
import {
  formatMoney,
  formatMoneyShort,
  formatShortDate,
  STATUS_META,
  STATUS_ORDER,
  type BalanceStatus,
  type IsoDate,
} from '@plainbill/core';
import type { BalanceRow } from '@plainbill/api/contract';
import { billBreakdown, isPaidNow, needsAction, type BreakdownBar } from '../lib/dashboard';
import { BREAKDOWN_COLORS, CHART_COLORS, gridTheme } from '../theme';
import {
  AiCell,
  CaretCell,
  DaysCell,
  GroupRow,
  PatientCell,
  type BalancesGridContext,
} from './grid/cells';
import { DetailPanel } from './grid/DetailPanel';

export type GroupBy = 'status' | 'payer' | 'provider';
export type View = 'action' | 'all';

export interface BalancesGridHandle {
  /** Apply a live payment: move the row to its new group, flash it, scroll it into view. */
  applyPayment(row: BalanceRow): void;
  /** Expand a row's details and scroll to it. */
  reveal(id: number): void;
  /**
   * Draw an integrated chart of the rows that pass the filters, by the current grouping, into
   * `container`. Destroy it through the returned ref.
   */
  chart(container: HTMLElement): ChartRef | undefined;
}

interface Props {
  rows: BalanceRow[];
  today: IsoDate;
  groupBy: GroupBy;
  view: View;
  quickFilter: string;
  onOpenDrawer: (balanceId: number) => void;
  onRunSuggestion: (row: BalanceRow, anchor: HTMLElement) => void;
  ref?: Ref<BalancesGridHandle>;
}

const FLASH = { flashDuration: 1600, fadeDuration: 2400 };

const money = (p: ValueFormatterParams<BalanceRow, number | null>) =>
  p.value == null ? '—' : formatMoney(p.value);
const mutedWhenEmpty = { 'pb-muted': (p: { value: unknown }) => p.value == null };

/** Breakdown sparkline: four bars, each as tall as its share of the bill. */
const BREAKDOWN_SPARKLINE: AgSparklineOptions<BreakdownBar> = {
  type: 'bar',
  direction: 'vertical',
  xKey: 'label',
  yKey: 'share',
  min: 0,
  max: 1,
  padding: { top: 10, bottom: 10, left: 0, right: 0 },
  cornerRadius: 2,
  itemStyler: ({ datum }) => ({ fill: BREAKDOWN_COLORS[datum.part] }),
  axis: { type: 'category', visible: true, stroke: '#D9D3C8', paddingInner: 0.2 },
  tooltip: {
    renderer: ({ datum }) => ({
      title: datum.label,
      content: `${formatMoney(datum.cents)} · ${Math.round(datum.share * 100)}% of the bill`,
    }),
  },
};

/** "Chart this": the category column for each grouping; the series are the money columns. */
const CHART_CATEGORY: Record<GroupBy, string> = {
  status: 'statusLabel',
  payer: 'payer',
  provider: 'groupProvider',
};
const CHART_SERIES = ['billed', 'insurancePaid', 'owes'];

/** Integrated charts in the Plainbill palette and font. Money columns hold cents. */
const PLAINBILL_CHART_THEME: AgChartTheme = {
  baseTheme: 'ag-default',
  palette: {
    fills: [BREAKDOWN_COLORS.billed, BREAKDOWN_COLORS.insurance, BREAKDOWN_COLORS.owed],
    strokes: [BREAKDOWN_COLORS.billed, BREAKDOWN_COLORS.insurance, BREAKDOWN_COLORS.owed],
  },
  overrides: {
    common: {
      title: { fontFamily: 'Figtree', fontWeight: 700, fontSize: 15, color: CHART_COLORS.ink },
      legend: { item: { label: { fontFamily: 'Figtree', color: CHART_COLORS.ink } } },
      axes: {
        number: {
          label: {
            fontFamily: 'Figtree',
            color: CHART_COLORS.muted,
            formatter: ({ value }) => formatMoneyShort(Number(value)),
          },
        },
        category: { label: { fontFamily: 'Figtree', color: CHART_COLORS.ink } },
      },
    },
    bar: {
      series: {
        cornerRadius: 3,
        tooltip: {
          renderer: ({ datum, yKey, yName }) => ({
            title: yName,
            content: formatMoney(Number((datum as Record<string, unknown>)[yKey]) || 0),
          }),
        },
      },
    },
  },
};
const CUSTOM_CHART_THEMES = { plainbill: PLAINBILL_CHART_THEME };
const CHART_THEMES = ['plainbill', 'ag-default', 'ag-vivid'];

function statusRank(key: string | null): number {
  const i = STATUS_ORDER.indexOf(key as BalanceStatus);
  return i === -1 ? STATUS_ORDER.length : i;
}

export function BalancesGrid({
  rows,
  today,
  groupBy,
  view,
  quickFilter,
  onOpenDrawer,
  onRunSuggestion,
  ref,
}: Props) {
  const openDrawerRef = useRef(onOpenDrawer);
  const runSuggestionRef = useRef(onRunSuggestion);
  useEffect(() => {
    openDrawerRef.current = onOpenDrawer;
    runSuggestionRef.current = onRunSuggestion;
  });
  const gridContext = useMemo<BalancesGridContext>(
    () => ({
      openDrawer: (id) => openDrawerRef.current(id),
      runSuggestion: (row, anchor) => runSuggestionRef.current(row, anchor),
    }),
    [],
  );
  const apiRef = useRef<GridApi<BalanceRow> | null>(null);
  const viewRef = useRef(view);
  const todayRef = useRef(today);

  const columnDefs = useMemo<ColDef<BalanceRow>[]>(
    () => [
      { colId: 'status', field: 'status', hide: true, rowGroup: groupBy === 'status' },
      // The status's label ("Needs review"), as the category for "Chart this".
      {
        colId: 'statusLabel',
        headerName: 'Status',
        valueGetter: (p) => (p.data ? STATUS_META[p.data.status].label : null),
        hide: true,
        chartDataType: 'category',
      },
      {
        colId: 'groupPayer',
        valueGetter: (p) => p.data?.payerName,
        hide: true,
        rowGroup: groupBy === 'payer',
        chartDataType: 'excluded',
      },
      {
        colId: 'groupProvider',
        headerName: 'Provider',
        valueGetter: (p) => p.data?.providerFullName ?? 'No provider on file',
        hide: true,
        rowGroup: groupBy === 'provider',
        chartDataType: 'category',
      },
      {
        colId: 'caret',
        headerName: '',
        width: 32,
        minWidth: 32,
        maxWidth: 32,
        sortable: false,
        resizable: false,
        cellRenderer: CaretCell,
        cellClass: 'pb-cell-caret',
        suppressNavigable: true,
        chartDataType: 'excluded',
      },
      {
        colId: 'patient',
        headerName: 'Patient',
        field: 'patientName',
        width: 160,
        cellRenderer: PatientCell,
        getQuickFilterText: (p) =>
          p.data ? `${p.data.patientName} ${p.data.claimId} ${p.data.sub}` : '',
      },
      {
        colId: 'visit',
        headerName: 'Visit',
        field: 'visitDate',
        width: 80,
        valueFormatter: (p) => (p.value ? formatShortDate(p.value as string) : ''),
      },
      {
        colId: 'payer',
        headerName: 'Payer',
        field: 'payerShortName',
        tooltipField: 'payerName',
        width: 116,
        getQuickFilterText: (p) => p.data?.payerName ?? '',
      },
      {
        colId: 'billed',
        headerName: 'Billed',
        field: 'billedCents',
        width: 88,
        type: 'rightAligned',
        valueFormatter: money,
      },
      {
        colId: 'insurancePaid',
        headerName: 'Insurance paid',
        field: 'insurancePaidCents',
        width: 108,
        type: 'rightAligned',
        valueFormatter: money,
        cellClassRules: mutedWhenEmpty,
      },
      {
        colId: 'owes',
        headerName: 'Patient owes',
        field: 'owesCents',
        width: 100,
        type: 'rightAligned',
        valueFormatter: money,
        cellClass: 'pb-owes',
        cellClassRules: mutedWhenEmpty,
      },
      {
        colId: 'breakdown',
        headerName: 'Breakdown',
        headerTooltip:
          'Where the bill went: discount, insurance paid, patient paid, still owed. Hover a bar for the amount.',
        width: 90,
        sortable: false,
        headerClass: 'pb-header-breakdown',
        cellClass: 'pb-cell-breakdown',
        valueGetter: (p) => (p.data ? billBreakdown(p.data) : null),
        // Denied visits aren't billed to the patient, so they get a dash instead of bars.
        cellRendererSelector: (p) =>
          p.value
            ? {
                component: 'agSparklineCellRenderer',
                params: { sparklineOptions: BREAKDOWN_SPARKLINE },
              }
            : undefined,
        valueFormatter: () => '—',
        cellClassRules: mutedWhenEmpty,
        getQuickFilterText: () => '',
        chartDataType: 'excluded',
      },
      {
        colId: 'days',
        headerName: 'Days out',
        field: 'daysOut',
        width: 96,
        cellRenderer: DaysCell,
        getQuickFilterText: (p) =>
          p.data?.agingBucket ? `${p.data.daysOut}d ${p.data.agingBucket}` : '',
      },
      {
        colId: 'ai',
        headerName: 'AI suggests',
        field: 'aiSuggestion',
        flex: 1,
        minWidth: 160,
        sortable: false,
        cellRenderer: AiCell,
        cellClass: 'pb-cell-ai',
        chartDataType: 'excluded',
      },
    ],
    [groupBy],
  );

  const defaultColDef = useMemo<ColDef<BalanceRow>>(
    () => ({
      sortable: true,
      resizable: true,
      suppressHeaderMenuButton: true,
      suppressMovable: true,
    }),
    [],
  );

  const rowClassRules = useMemo<RowClassRules<BalanceRow>>(
    () => ({
      'pb-row-group': (p) => !!p.node.group,
      'pb-row-paid-now': (p) => !p.node.group && !p.node.detail && !!p.data && isPaidNow(p.data),
    }),
    [],
  );

  const getRowId = useCallback((p: GetRowIdParams<BalanceRow>) => String(p.data.id), []);
  const getRowHeight = useCallback((p: RowHeightParams<BalanceRow>) => {
    if (p.node.group) return 48;
    if (p.node.detail) return undefined; // detailRowAutoHeight sizes the panel
    return 54;
  }, []);
  const groupOrder = useCallback(
    ({ nodeA, nodeB }: InitialGroupOrderComparatorParams<BalanceRow>) =>
      nodeA.rowGroupColumn?.getColId() === 'status'
        ? statusRank(nodeA.key) - statusRank(nodeB.key)
        : (nodeA.key ?? '').localeCompare(nodeB.key ?? ''),
    [],
  );

  const isExternalFilterPresent = useCallback(() => viewRef.current === 'action', []);
  const doesExternalFilterPass = useCallback(
    (node: IRowNode<BalanceRow>) => !node.data || needsAction(node.data, todayRef.current),
    [],
  );

  useEffect(() => {
    viewRef.current = view;
    todayRef.current = today;
    apiRef.current?.onFilterChanged();
  }, [view, today]);

  // Group headers show counts and totals from their children; redraw them when grouping changes.
  useEffect(() => {
    apiRef.current?.redrawRows();
  }, [groupBy]);

  // Keep "just now" fresh and let the paid-now tint expire.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const api = apiRef.current;
      if (!api) return;
      const paid: IRowNode<BalanceRow>[] = [];
      api.forEachNode((n) => {
        if (n.data?.status === 'paid' && n.data.paidAt && !n.group) paid.push(n);
      });
      if (paid.length) api.redrawRows({ rowNodes: paid });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const scrollToRow = (id: number) => {
    requestAnimationFrame(() => {
      document
        .querySelector(`.ag-row[row-id="${id}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  };

  useImperativeHandle(ref, () => ({
    applyPayment(row) {
      const api = apiRef.current;
      if (!api) return;
      // The update moves the row into its new group; row class rules (paid-now tint) re-run on it.
      api.applyTransaction({ update: [row] });
      const node = api.getRowNode(String(row.id));
      if (!node) return;
      // Group rows show counts and totals from their children, so redraw them.
      const groups: IRowNode<BalanceRow>[] = [];
      api.forEachNode((n) => {
        if (n.group) groups.push(n);
      });
      api.redrawRows({ rowNodes: groups });
      if (node.parent && !node.parent.expanded) node.parent.setExpanded(true);
      // flashCells only reaches cells that exist, so render the moved row before flashing it.
      api.flushAllAnimationFrames();
      api.flashCells({ rowNodes: [node], ...FLASH });
      scrollToRow(row.id);
    },
    reveal(id) {
      const api = apiRef.current;
      const node = api?.getRowNode(String(id));
      if (!api || !node) return;
      if (node.parent && !node.parent.expanded) node.parent.setExpanded(true);
      node.setExpanded(true);
      scrollToRow(id);
    },
    chart(container) {
      // Rows that pass the filters, summed per category. The chart stays linked to the grid, so
      // a live payment moves its bars too.
      return apiRef.current?.createRangeChart({
        cellRange: { columns: [CHART_CATEGORY[groupBy], ...CHART_SERIES] },
        chartContainer: container,
        chartType: 'groupedColumn',
        aggFunc: 'sum',
        suppressChartRanges: true,
        chartThemeName: 'plainbill',
        chartThemeOverrides: {
          common: {
            title: {
              enabled: true,
              text: `Billed, insurance paid and patient owes, by ${groupBy}`,
            },
          },
        },
      });
    },
  }));

  // Fresh data (intake approvals, sends) can move rows between groups; group rows show counts
  // and totals from their children, so redraw them.
  const onRowDataUpdated = useCallback((e: RowDataUpdatedEvent<BalanceRow>) => {
    const groups: IRowNode<BalanceRow>[] = [];
    e.api.forEachNode((n) => {
      if (n.group) groups.push(n);
    });
    e.api.redrawRows({ rowNodes: groups });
  }, []);

  const onGridReady = useCallback((e: GridReadyEvent<BalanceRow>) => {
    apiRef.current = e.api;
  }, []);

  // Clicking a row (or its caret) toggles the detail panel; clicks on other controls in the row,
  // like the AI suggestion button, are left to those controls.
  const onRowClicked = useCallback((e: RowClickedEvent<BalanceRow>) => {
    if (e.node.group || e.node.detail || !e.data) return;
    const target = e.event?.target;
    if (target instanceof Element && target.closest('button:not(.pb-caret), a, input, select'))
      return;
    e.node.setExpanded(!e.node.expanded);
  }, []);

  return (
    <AgGridReact<BalanceRow>
      theme={gridTheme}
      loadThemeGoogleFonts={false}
      rowData={rows}
      columnDefs={columnDefs}
      defaultColDef={defaultColDef}
      getRowId={getRowId}
      getRowHeight={getRowHeight}
      rowClassRules={rowClassRules}
      domLayout="autoHeight"
      animateRows
      // Row grouping by status, rendered as full-width group rows.
      groupDisplayType="groupRows"
      groupRowRenderer={GroupRow}
      groupDefaultExpanded={1}
      initialGroupOrderComparator={groupOrder}
      suppressGroupChangesColumnVisibility="suppressHideOnGroup"
      // Master/detail with a custom panel.
      masterDetail
      isRowMaster={(data) => !!data}
      detailCellRenderer={DetailPanel}
      detailRowAutoHeight
      // Quick filter + "Needs action" view.
      quickFilterText={quickFilter}
      cacheQuickFilter
      isExternalFilterPresent={isExternalFilterPresent}
      doesExternalFilterPass={doesExternalFilterPass}
      // Integrated charts: select a range of cells and right-click → Chart Range.
      cellSelection
      enableCharts
      customChartThemes={CUSTOM_CHART_THEMES}
      chartThemes={CHART_THEMES}
      onGridReady={onGridReady}
      onRowClicked={onRowClicked}
      onRowDataUpdated={onRowDataUpdated}
      context={gridContext}
      overlayNoRowsTemplate='<span class="pb-muted">No balances match.</span>'
    />
  );
}
