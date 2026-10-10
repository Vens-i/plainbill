/**
 * The patient balances grid: AG Grid Enterprise with row grouping (by status by default),
 * master/detail, quick filter, custom renderers, integrated charts on cell ranges, and a live
 * payment flash driven by Server-Sent Events.
 */
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, type Ref } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type {
  ColDef,
  GetRowIdParams,
  GridApi,
  GridReadyEvent,
  InitialGroupOrderComparatorParams,
  IRowNode,
  RowClassRules,
  RowClickedEvent,
  RowHeightParams,
  ValueFormatterParams,
} from 'ag-grid-community';
import {
  formatMoney,
  formatShortDate,
  STATUS_ORDER,
  type BalanceStatus,
  type IsoDate,
} from '@plainbill/core';
import type { BalanceRow } from '@plainbill/api/contract';
import { isPaidNow, needsAction } from '../lib/dashboard';
import { gridTheme } from '../theme';
import { AiCell, CaretCell, DaysCell, GroupRow, PatientCell } from './grid/cells';
import { DetailPanel } from './grid/DetailPanel';

export type GroupBy = 'status' | 'payer' | 'provider';
export type View = 'action' | 'all';

export interface BalancesGridHandle {
  /** Apply a live payment: move the row to its new group, flash it, scroll it into view. */
  applyPayment(row: BalanceRow): void;
  /** Expand a row's details and scroll to it. */
  reveal(id: number): void;
}

interface Props {
  rows: BalanceRow[];
  today: IsoDate;
  groupBy: GroupBy;
  view: View;
  quickFilter: string;
  ref?: Ref<BalancesGridHandle>;
}

const FLASH = { flashDuration: 1600, fadeDuration: 2400 };

const money = (p: ValueFormatterParams<BalanceRow, number | null>) =>
  p.value == null ? '—' : formatMoney(p.value);
const mutedWhenEmpty = { 'pb-muted': (p: { value: unknown }) => p.value == null };

function statusRank(key: string | null): number {
  const i = STATUS_ORDER.indexOf(key as BalanceStatus);
  return i === -1 ? STATUS_ORDER.length : i;
}

export function BalancesGrid({ rows, today, groupBy, view, quickFilter, ref }: Props) {
  const apiRef = useRef<GridApi<BalanceRow> | null>(null);
  const viewRef = useRef(view);
  const todayRef = useRef(today);

  const columnDefs = useMemo<ColDef<BalanceRow>[]>(
    () => [
      { colId: 'status', field: 'status', hide: true, rowGroup: groupBy === 'status' },
      {
        colId: 'groupPayer',
        valueGetter: (p) => p.data?.payerName,
        hide: true,
        rowGroup: groupBy === 'payer',
      },
      {
        colId: 'groupProvider',
        valueGetter: (p) => p.data?.providerFullName ?? 'No provider on file',
        hide: true,
        rowGroup: groupBy === 'provider',
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
      },
      {
        colId: 'patient',
        headerName: 'Patient',
        field: 'patientName',
        width: 176,
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
      { colId: 'payer', headerName: 'Payer', field: 'payerName', width: 144 },
      {
        colId: 'billed',
        headerName: 'Billed',
        field: 'billedCents',
        width: 92,
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
        colId: 'days',
        headerName: 'Days out',
        field: 'daysOut',
        width: 104,
        cellRenderer: DaysCell,
        getQuickFilterText: (p) =>
          p.data?.agingBucket ? `${p.data.daysOut}d ${p.data.agingBucket}` : '',
      },
      {
        colId: 'ai',
        headerName: 'AI suggests',
        field: 'aiSuggestion',
        flex: 1,
        minWidth: 172,
        sortable: false,
        cellRenderer: AiCell,
        cellClass: 'pb-cell-ai',
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
    if (p.node.group) return 42;
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
  }));

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
      onGridReady={onGridReady}
      onRowClicked={onRowClicked}
      overlayNoRowsTemplate='<span class="pb-muted">No balances match.</span>'
    />
  );
}
