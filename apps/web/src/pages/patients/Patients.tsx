/**
 * Staff Patients page: one row per patient (AG Grid Enterprise), rolled up server-side in integer
 * cents from the same rows as the dashboard, with each patient's visits in a master/detail grid
 * that opens the Review & Send drawer. Live: payments and balance changes refetch and flash the
 * patient's row.
 */
import './patients.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type {
  ColDef,
  GetRowIdParams,
  GridApi,
  GridOptions,
  IDetailCellRendererParams,
  IRowNode,
  ModelUpdatedEvent,
  RowClassRules,
  RowClickedEvent,
  RowDataUpdatedEvent,
} from 'ag-grid-community';
import { dobSearchForms, formatMoney, formatMoneyShort, formatShortDate } from '@plainbill/core';
import type { PatientSummary, PatientVisit } from '@plainbill/api/contract';
import { useShell } from '../../components/AppShell';
import { ReviewDrawer } from '../../components/ReviewDrawer';
import { api, ApiError } from '../../lib/api';
import { PAID_NOW_WINDOW_MS } from '../../lib/dashboard';
import { useServerEvents } from '../../lib/useServerEvents';
import { gridTheme } from '../../theme';
import {
  DobCell,
  LastActivityCell,
  OldestOpenCell,
  PatientCaretCell,
  PatientNameCell,
  StatusChipsCell,
  VisitDaysCell,
  VisitOpenCell,
  VisitStatusCell,
  type PatientsGridContext,
} from './cells';

type View = 'owing' | 'all';

const FLASH = { flashDuration: 1600, fadeDuration: 2400 };

const money = (p: { value: number | null | undefined }) =>
  p.value == null ? '—' : formatMoney(p.value);
const mutedWhenEmpty = { 'pb-muted': (p: { value: unknown }) => p.value == null || p.value === 0 };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The pinned bottom row: the visible patients' totals, shaped like a patient. */
function totalsRow(rows: PatientSummary[]): PatientSummary {
  const sum = (f: (p: PatientSummary) => number) => rows.reduce((t, p) => t + f(p), 0);
  return {
    patientId: -1,
    name: `Total · ${plural(rows.length, 'patient')}`,
    sortName: '',
    dob: null,
    age: null,
    visitCount: sum((p) => p.visitCount),
    billedCents: sum((p) => p.billedCents),
    patientShareCents: sum((p) => p.patientShareCents),
    paidCents: sum((p) => p.paidCents),
    owedCents: sum((p) => p.owedCents),
    oldestOpenDays: null,
    oldestOpenBucket: null,
    statuses: [],
    lastActivity: null,
    visits: [],
  };
}

const isPaidNow = (p: PatientSummary, now = Date.now()) =>
  p.lastActivity?.kind === 'payment' &&
  p.lastActivity.at != null &&
  now - Date.parse(p.lastActivity.at) < PAID_NOW_WINDOW_MS;

const VISIT_COLUMNS: ColDef<PatientVisit>[] = [
  {
    headerName: 'Visit',
    field: 'visitDate',
    width: 92,
    valueFormatter: (p) => (p.value ? formatShortDate(p.value as string) : ''),
  },
  { headerName: 'Claim', field: 'claimId', width: 130, cellClass: 'pt-mono' },
  {
    headerName: 'Provider',
    field: 'provider',
    width: 100,
    valueFormatter: (p) => p.value ?? '—',
  },
  { headerName: 'Payer', field: 'payerShortName', tooltipField: 'payerName', width: 140 },
  { headerName: 'Status', field: 'status', width: 170, cellRenderer: VisitStatusCell },
  {
    headerName: 'Billed',
    field: 'billedCents',
    width: 96,
    type: 'rightAligned',
    valueFormatter: money,
  },
  {
    headerName: 'Patient share',
    field: 'patientShareCents',
    width: 124,
    type: 'rightAligned',
    valueFormatter: money,
    cellClassRules: mutedWhenEmpty,
  },
  {
    headerName: 'Paid',
    field: 'paidCents',
    width: 90,
    type: 'rightAligned',
    valueFormatter: money,
    cellClassRules: mutedWhenEmpty,
  },
  {
    headerName: 'Still owed',
    field: 'owedCents',
    width: 104,
    type: 'rightAligned',
    valueFormatter: money,
    cellClass: 'pb-owes',
    cellClassRules: mutedWhenEmpty,
  },
  { headerName: 'Days out', field: 'daysOut', width: 110, cellRenderer: VisitDaysCell },
  {
    headerName: '',
    colId: 'open',
    flex: 1,
    minWidth: 150,
    sortable: false,
    cellRenderer: VisitOpenCell,
  },
];

export function Patients() {
  const { search, setSearch } = useShell();
  const [rows, setRows] = useState<PatientSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>('all');
  const [drawerId, setDrawerId] = useState<number | null>(null);
  const [totals, setTotals] = useState<PatientSummary[]>([]);
  const apiRef = useRef<GridApi<PatientSummary> | null>(null);
  const viewRef = useRef(view);
  const rowsRef = useRef<PatientSummary[]>([]);
  /** Patients to flash once their fresh rows are in the grid. */
  const pendingFlash = useRef(new Set<number>());

  const load = useCallback(async () => {
    try {
      const next = await api.patients();
      rowsRef.current = next;
      setRows(next);
      setError(null);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'not_seeded'
          ? 'The database is empty. Run `pnpm seed`, then reload.'
          : `Could not reach the Plainbill API (${(err as Error).message}). Is \`pnpm dev\` running?`,
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Flash the patients these balances belong to, after the refetch lands. */
  const refreshFor = useCallback(
    (balanceIds: number[], patientIds: number[] = []) => {
      const owners = rowsRef.current
        .filter((p) => p.visits.some((v) => balanceIds.includes(v.balanceId)))
        .map((p) => p.patientId);
      for (const id of [...owners, ...patientIds]) pendingFlash.current.add(id);
      void load();
    },
    [load],
  );

  useServerEvents({
    onPayment: (event) => refreshFor([event.balance.id], [event.balance.patientId]),
    onBalancesChanged: (event) => refreshFor(event.ids),
    onOpen: () => void load(),
  });

  const gridContext = useMemo<PatientsGridContext>(() => ({ openDrawer: setDrawerId }), []);

  const columnDefs = useMemo<ColDef<PatientSummary>[]>(
    () => [
      {
        colId: 'caret',
        headerName: '',
        width: 32,
        minWidth: 32,
        maxWidth: 32,
        sortable: false,
        resizable: false,
        cellRenderer: PatientCaretCell,
        cellClass: 'pb-cell-caret',
        suppressNavigable: true,
      },
      {
        colId: 'patient',
        headerName: 'Patient',
        field: 'sortName',
        width: 200,
        cellRenderer: PatientNameCell,
        getQuickFilterText: (p) => p.data?.name ?? '',
        sort: 'asc',
      },
      {
        colId: 'dob',
        headerName: 'Date of birth',
        field: 'dob',
        width: 140,
        cellRenderer: DobCell,
        // Typed either way: "04/17/1984", "4/17/1984" or "1984-04-17".
        getQuickFilterText: (p) => (p.data?.dob ? dobSearchForms(p.data.dob).join(' ') : ''),
      },
      { headerName: 'Visits', field: 'visitCount', width: 78, type: 'rightAligned' },
      {
        headerName: 'Total billed',
        field: 'billedCents',
        width: 108,
        type: 'rightAligned',
        valueFormatter: money,
      },
      {
        headerName: 'Patient share',
        field: 'patientShareCents',
        width: 124,
        type: 'rightAligned',
        valueFormatter: money,
        cellClassRules: mutedWhenEmpty,
      },
      {
        headerName: 'Paid',
        field: 'paidCents',
        width: 96,
        type: 'rightAligned',
        valueFormatter: money,
        cellClassRules: mutedWhenEmpty,
      },
      {
        headerName: 'Still owed',
        field: 'owedCents',
        width: 106,
        type: 'rightAligned',
        valueFormatter: money,
        cellClass: 'pb-owes',
        cellClassRules: mutedWhenEmpty,
      },
      {
        headerName: 'Oldest open',
        headerTooltip: 'Days since the oldest visit that still has money owed',
        field: 'oldestOpenDays',
        width: 118,
        cellRenderer: OldestOpenCell,
      },
      {
        colId: 'activity',
        headerName: 'Last activity',
        valueGetter: (p) => p.data?.lastActivity?.on ?? null,
        width: 190,
        cellRenderer: LastActivityCell,
      },
      {
        colId: 'statuses',
        headerName: 'Status',
        flex: 1,
        minWidth: 170,
        sortable: false,
        cellRenderer: StatusChipsCell,
      },
    ],
    [],
  );

  const defaultColDef = useMemo<ColDef<PatientSummary>>(
    () => ({
      sortable: true,
      resizable: true,
      suppressHeaderMenuButton: true,
      suppressMovable: true,
      // Search is by name only.
      getQuickFilterText: () => '',
      // Renderers read more than their own value (the name cell shows the latest visit's line),
      // so a live update re-renders every cell of the changed row.
      equals: () => false,
    }),
    [],
  );

  const detailCellRendererParams = useMemo<Partial<IDetailCellRendererParams<PatientSummary>>>(
    () => ({
      // Live updates re-render the open visit list in place.
      refreshStrategy: 'rows',
      detailGridOptions: {
        theme: gridTheme,
        columnDefs: VISIT_COLUMNS,
        defaultColDef: { resizable: true, sortable: true, suppressHeaderMenuButton: true },
        getRowId: (p) => String(p.data.balanceId),
        rowHeight: 48,
        headerHeight: 34,
        domLayout: 'autoHeight',
        context: gridContext,
        suppressCellFocus: true,
      } satisfies GridOptions<PatientVisit>,
      getDetailRowData: (p) => p.successCallback(p.data.visits),
    }),
    [gridContext],
  );

  const rowClassRules = useMemo<RowClassRules<PatientSummary>>(
    () => ({
      'pb-row-paid-now': (p) =>
        !p.node.detail && !p.node.rowPinned && !!p.data && isPaidNow(p.data),
      'pt-row-total': (p) => !!p.node.rowPinned,
    }),
    [],
  );

  const getRowId = useCallback((p: GetRowIdParams<PatientSummary>) => String(p.data.patientId), []);

  const isExternalFilterPresent = useCallback(() => viewRef.current === 'owing', []);
  const doesExternalFilterPass = useCallback(
    (node: IRowNode<PatientSummary>) => (node.data?.owedCents ?? 0) > 0,
    [],
  );
  useEffect(() => {
    viewRef.current = view;
    apiRef.current?.onFilterChanged();
  }, [view]);

  // The totals row follows the filters: it adds up the patients on screen.
  const onModelUpdated = useCallback((e: ModelUpdatedEvent<PatientSummary>) => {
    const shown: PatientSummary[] = [];
    e.api.forEachNodeAfterFilter((n) => {
      if (n.data && !n.detail) shown.push(n.data);
    });
    const next = totalsRow(shown);
    setTotals((prev) =>
      prev[0] &&
      prev[0].name === next.name &&
      prev[0].owedCents === next.owedCents &&
      prev[0].paidCents === next.paidCents &&
      prev[0].billedCents === next.billedCents
        ? prev
        : [next],
    );
  }, []);

  const onRowDataUpdated = useCallback((e: RowDataUpdatedEvent<PatientSummary>) => {
    const ids = [...pendingFlash.current];
    pendingFlash.current.clear();
    const nodes = ids
      .map((id) => e.api.getRowNode(String(id)))
      .filter((n): n is IRowNode<PatientSummary> => !!n && n.displayed);
    if (!nodes.length) return;
    // flashCells only reaches cells that exist, so render the updated rows first.
    e.api.flushAllAnimationFrames();
    e.api.flashCells({ rowNodes: nodes, ...FLASH });
  }, []);

  const onRowClicked = useCallback((e: RowClickedEvent<PatientSummary>) => {
    if (e.node.detail || e.node.rowPinned || !e.data) return;
    const target = e.event?.target;
    if (target instanceof Element && target.closest('button:not(.pb-caret), a, input, select'))
      return;
    e.node.setExpanded(!e.node.expanded);
  }, []);

  // Keep "just now" fresh and let the paid-now tint expire.
  useEffect(() => {
    const timer = window.setInterval(() => apiRef.current?.redrawRows(), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const owing = rows?.filter((p) => p.owedCents > 0) ?? [];
  const oldest = owing.reduce<PatientSummary | null>(
    (o, p) => (o == null || (p.oldestOpenDays ?? 0) > (o.oldestOpenDays ?? 0) ? p : o),
    null,
  );
  const owedCents = owing.reduce((t, p) => t + p.owedCents, 0);

  return (
    <main className="page">
      <div className="greeting-row">
        <div>
          <h1 className="greeting">Patients</h1>
          <p className="greeting-sub">
            {rows
              ? `${plural(rows.length, 'patient')} · ${owing.length} owe ${formatMoneyShort(owedCents)}` +
                (oldest?.oldestOpenDays != null
                  ? ` · oldest balance ${oldest.oldestOpenDays} days (${oldest.name})`
                  : '')
              : ' '}
          </p>
        </div>
      </div>

      {error && (
        <div className="banner" role="alert">
          {error}
        </div>
      )}

      <section className="card grid-card" aria-labelledby="patients-title">
        <div className="grid-toolbar">
          <h2 className="grid-title" id="patients-title">
            Everyone with a bill
          </h2>
          <div className="segmented" role="group" aria-label="Which patients to show">
            <button type="button" aria-pressed={view === 'all'} onClick={() => setView('all')}>
              All
            </button>
            <button type="button" aria-pressed={view === 'owing'} onClick={() => setView('owing')}>
              Owes money
            </button>
          </div>
          <div style={{ flex: 1 }} />
          <input
            className="quick-filter"
            type="search"
            placeholder="Search name or DOB…"
            aria-label="Search patients by name or date of birth"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {rows && (
          <AgGridReact<PatientSummary>
            theme={gridTheme}
            loadThemeGoogleFonts={false}
            rowData={rows}
            columnDefs={columnDefs}
            defaultColDef={defaultColDef}
            getRowId={getRowId}
            rowHeight={54}
            rowClassRules={rowClassRules}
            pinnedBottomRowData={totals}
            domLayout="autoHeight"
            animateRows
            masterDetail
            isRowMaster={(data) => !!data && data.patientId > 0}
            detailCellRendererParams={detailCellRendererParams}
            detailRowAutoHeight
            quickFilterText={search}
            cacheQuickFilter
            isExternalFilterPresent={isExternalFilterPresent}
            doesExternalFilterPass={doesExternalFilterPass}
            onGridReady={(e) => (apiRef.current = e.api)}
            onModelUpdated={onModelUpdated}
            onRowDataUpdated={onRowDataUpdated}
            onRowClicked={onRowClicked}
            context={gridContext}
            overlayNoRowsTemplate='<span class="pb-muted">No patients match.</span>'
          />
        )}
      </section>
      {drawerId !== null && <ReviewDrawer balanceId={drawerId} onClose={() => setDrawerId(null)} />}
    </main>
  );
}
