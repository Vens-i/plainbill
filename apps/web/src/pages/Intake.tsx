/**
 * Intake (artboard 1b): drop 835s, EOB PDFs and self-pay CSVs; review what was read, confirm the
 * fields the AI flagged, approve. Nothing reaches the dashboard until "Approve".
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router';
import { AgGridReact } from 'ag-grid-react';
import type {
  ColDef,
  GridApi,
  ICellRendererParams,
  RowClassRules,
  RowHeightParams,
  ValueFormatterParams,
} from 'ag-grid-community';
import { formatMoney, formatShortDate } from '@plainbill/core';
import type {
  IntakeApproveResult,
  IntakeBatchView,
  IntakeFlagView,
  IntakeItemView,
} from '@plainbill/api/contract';
import { FlagChoices } from '../components/FlagChoices';
import { Popover } from '../components/Popover';
import { toast } from '../components/Toast';
import { api, ApiError } from '../lib/api';
import { gridTheme } from '../theme';

/** The files the design's Intake artboard shows (seed/data), for rehearsing the demo. */
const SAMPLE_FILES = [
  'bcbs_era_1008.835',
  'aetna_eob_raman.pdf',
  'uhc_eob_sept.pdf',
  'selfpay_0929.csv',
];

interface Upload {
  name: string;
  state: 'reading' | 'done' | 'error';
  message?: string;
}

interface GridContext {
  openFlag: (item: IntakeItemView, flag: IntakeFlagView, anchor: HTMLElement) => void;
}

type CellParams = ICellRendererParams<IntakeItemView, unknown, GridContext>;

const money = (p: ValueFormatterParams<IntakeItemView, number | null>) =>
  p.value == null ? '—' : formatMoney(p.value);

function FlagBox({
  item,
  flag,
  context,
  align,
}: {
  item: IntakeItemView;
  flag: IntakeFlagView;
  context: GridContext;
  align?: 'right';
}) {
  // Compact, like the design ("or $280? Scan blurry"): two alternatives at most, no ".00".
  const alts = flag.alternatives.map((a) => a.display.split(' → ')[0]!.replace(/\.00$/, ''));
  const others = alts.length > 2 ? `${alts.slice(0, 2).join(', ')}…` : alts.join(' or ');
  return (
    <button
      type="button"
      className={`flag-box${align === 'right' ? ' right' : ''}`}
      onClick={(e) => context.openFlag(item, flag, e.currentTarget)}
      aria-label={`${flag.label} needs a look: read as ${flag.current.display}`}
    >
      <span className="flag-box-main">
        <span className="flag-q" aria-hidden="true">
          ?
        </span>
        {flag.current.display}
      </span>
      <span className="flag-box-note" title={flag.note ?? undefined}>
        {others ? `or ${others}? ` : ''}
        {flag.note ?? 'Check this'}
      </span>
    </button>
  );
}

function SourceCell({ data }: CellParams) {
  return data ? <span className="mono intake-source">{data.sourceLabel}</span> : null;
}

function PatientCell({ data }: CellParams) {
  if (!data) return null;
  return (
    <div className="pb-patient">
      <span className="pb-patient-name">{data.patientName}</span>
      {data.status === 'duplicate' && (
        <span className="pb-patient-sub">Already on file — will be skipped</span>
      )}
      {data.status === 'approved' && <span className="pb-patient-sub">Added to the dashboard</span>}
    </div>
  );
}

function PaidCell({ data, context, valueFormatted }: CellParams) {
  if (!data) return null;
  const flag = data.flags.find((f) => f.column === 'insurancePaid');
  if (flag) return <FlagBox item={data} flag={flag} context={context} align="right" />;
  const resolved = data.resolved.find((r) => r.path.endsWith('insurance_paid'));
  return (
    <div className="intake-cell right">
      <span className={data.insurancePaidCents == null ? 'pb-muted' : ''}>{valueFormatted}</span>
      {resolved && <span className="resolved-note">✓ confirmed</span>}
    </div>
  );
}

function AdjustmentsCell({ data, context }: CellParams) {
  if (!data) return null;
  const flags = data.flags.filter((f) => f.column !== 'insurancePaid');
  if (flags.length) {
    return (
      <div className="intake-flags">
        {flags.map((f) => (
          <FlagBox key={f.path} item={data} flag={f} context={context} />
        ))}
      </div>
    );
  }
  if (data.error && !data.reconciles)
    return <span className="intake-error">Doesn’t add up — {data.error}</span>;
  const resolved = data.resolved.filter((r) => !r.path.endsWith('insurance_paid'));
  return (
    <div className="intake-cell">
      <span>{data.adjustmentsSummary}</span>
      {resolved.map((r) => (
        <span key={r.path} className="resolved-note">
          ✓ {r.to}
        </span>
      ))}
    </div>
  );
}

function OwesCell({ data, valueFormatted }: CellParams) {
  if (!data) return null;
  return <span className="pb-owes">{data.reconciles ? valueFormatted : '—'}</span>;
}

const reviewCount = (r: IntakeApproveResult) =>
  r.approved.filter((a) => a.status === 'review').length;

export function Intake() {
  const [batch, setBatch] = useState<IntakeBatchView | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<IntakeApproveResult | null>(null);
  const [open, setOpen] = useState<{
    item: IntakeItemView;
    flag: IntakeFlagView;
    anchor: HTMLElement;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const gridApi = useRef<GridApi<IntakeItemView> | null>(null);

  // A resolved flag can leave a cell's value unchanged (Priya's paid stays $260) while its
  // rendering, row height and tint change — so redraw rows whenever the batch changes.
  useEffect(() => {
    const api = gridApi.current;
    if (!api) return;
    api.resetRowHeights();
    api.redrawRows();
  }, [batch]);

  useEffect(() => {
    api.intakeBatch().then(
      (r) => setBatch(r.batch),
      (e: Error) => setError(e.message),
    );
  }, []);

  const addFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setDone(null);
    setError(null);
    setUploads((u) => [
      ...u.filter((x) => !files.some((f) => f.name === x.name)),
      ...files.map((f) => ({ name: f.name, state: 'reading' as const })),
    ]);
    await Promise.all(
      files.map(async (file) => {
        try {
          const { batch: next } = await api.uploadIntakeFile(file);
          setBatch(next);
          const info = next.files.find((f) => f.fileName === file.name);
          setUploads((u) =>
            u.map((x) =>
              x.name === file.name
                ? info?.status === 'error'
                  ? {
                      name: x.name,
                      state: 'error',
                      message: info.error ?? 'Could not read this file',
                    }
                  : { name: x.name, state: 'done' }
                : x,
            ),
          );
        } catch (e) {
          setUploads((u) =>
            u.map((x) =>
              x.name === file.name
                ? { name: x.name, state: 'error', message: (e as Error).message }
                : x,
            ),
          );
        }
      }),
    );
    const latest = await api.intakeBatch();
    setBatch(latest.batch);
  }, []);

  const useSamples = async () => {
    setDone(null);
    setUploads(SAMPLE_FILES.map((name) => ({ name, state: 'reading' })));
    try {
      const { batch: next } = await api.intakeSamples(SAMPLE_FILES);
      setBatch(next);
      setUploads(SAMPLE_FILES.map((name) => ({ name, state: 'done' })));
    } catch (e) {
      setError((e as Error).message);
      setUploads([]);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void addFiles([...e.dataTransfer.files]);
  };

  const resolve = async (item: IntakeItemView, flag: IntakeFlagView, value: string) => {
    setBusy(true);
    try {
      const { batch: next } = await api.resolveIntakeFlag(item.id, flag.path, value);
      setBatch(next);
      setOpen(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    setBusy(true);
    try {
      const result = await api.approveIntake();
      setDone(result);
      setBatch(null);
      setUploads([]);
      const review = result.approved.filter((a) => a.status === 'review').length;
      toast(
        `✓ ${result.approved.length} visits added${review ? ` · ${review} need a quick check` : ''}`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    setBusy(true);
    try {
      await api.discardIntake();
      setBatch(null);
      setUploads([]);
    } finally {
      setBusy(false);
    }
  };

  const items = useMemo(() => batch?.items.filter((i) => i.status !== 'discarded') ?? [], [batch]);
  const pending = items.filter((i) => i.status === 'pending');
  const duplicates = items.filter((i) => i.status === 'duplicate').length;
  const context = useMemo<GridContext>(
    () => ({ openFlag: (item, flag, anchor) => setOpen({ item, flag, anchor }) }),
    [],
  );

  const columnDefs = useMemo<ColDef<IntakeItemView>[]>(
    () => [
      { headerName: 'Source', field: 'sourceLabel', width: 190, cellRenderer: SourceCell },
      { headerName: 'Patient', field: 'patientName', width: 160, cellRenderer: PatientCell },
      {
        headerName: 'Visit',
        field: 'visitDate',
        width: 90,
        valueFormatter: (p) => (p.value ? formatShortDate(p.value as string) : '—'),
      },
      { headerName: 'Payer', field: 'payerName', width: 140 },
      {
        headerName: 'Billed',
        field: 'billedCents',
        width: 96,
        type: 'rightAligned',
        valueFormatter: money,
      },
      {
        headerName: 'Insurance paid',
        field: 'insurancePaidCents',
        width: 144,
        type: 'rightAligned',
        valueFormatter: money,
        cellRenderer: PaidCell,
      },
      {
        headerName: 'Adjustments',
        field: 'adjustmentsSummary',
        flex: 1,
        minWidth: 220,
        cellRenderer: AdjustmentsCell,
        wrapText: true,
      },
      {
        headerName: 'Patient owes',
        field: 'owesCents',
        width: 110,
        type: 'rightAligned',
        valueFormatter: money,
        cellRenderer: OwesCell,
      },
    ],
    [],
  );
  const rowClassRules = useMemo<RowClassRules<IntakeItemView>>(
    () => ({
      'intake-row-flagged': (p) =>
        !!p.data && p.data.status === 'pending' && (p.data.flags.length > 0 || !p.data.reconciles),
      'intake-row-muted': (p) => !!p.data && p.data.status !== 'pending',
    }),
    [],
  );
  const getRowHeight = useCallback((p: RowHeightParams<IntakeItemView>) => {
    const flags = p.data?.flags.filter((f) => f.column !== 'insurancePaid').length ?? 0;
    return p.data && (p.data.flags.length || !p.data.reconciles)
      ? Math.max(76, 22 + flags * 56)
      : 54;
  }, []);

  return (
    <main className="page intake-page" onDragOver={(e) => e.preventDefault()}>
      <div>
        <h1 className="greeting">Add insurance responses &amp; visits</h1>
        <p className="greeting-sub">
          Drop files here. We’ll read them and work out what each patient owes.
        </p>
      </div>

      {error && (
        <div className="banner" role="alert">
          {error}
        </div>
      )}

      <section
        className={`dropzone${dragging ? ' dragging' : ''}`}
        onDragEnter={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
        }}
        onDrop={onDrop}
        aria-label="Upload files"
      >
        <div className="drop-card">
          <div className="drop-ext">.835 / .txt</div>
          <div className="drop-title">Insurance remittance</div>
          <div className="drop-sub">The electronic file your clearinghouse sends</div>
        </div>
        <div className="drop-card">
          <div className="drop-ext">.pdf</div>
          <div className="drop-title">Explanation of Benefits</div>
          <div className="drop-sub">Scanned or downloaded EOB from a payer</div>
        </div>
        <div className="drop-card">
          <div className="drop-ext">.csv</div>
          <div className="drop-title">Self-pay visit summary</div>
          <div className="drop-sub">Visits with no insurance on file</div>
        </div>
        <div className="drop-action">
          <div className="drop-hint">Drag files anywhere here</div>
          <button type="button" className="btn" onClick={() => input.current?.click()}>
            Browse files
          </button>
          {import.meta.env.DEV && (
            <button type="button" className="link-btn" onClick={useSamples}>
              Use the sample files
            </button>
          )}
          <input
            ref={input}
            type="file"
            multiple
            accept=".835,.txt,.edi,.x12,.pdf,.csv"
            hidden
            onChange={(e) => {
              void addFiles([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
        </div>
      </section>

      {(uploads.length > 0 || (batch?.files.length ?? 0) > 0) && (
        <ul className="file-chips" aria-label="Files">
          {(batch?.files ?? []).map((f) => (
            <li key={f.id} className={`file-chip ${f.status}`}>
              <b aria-hidden="true">{f.status === 'error' ? '×' : '✓'}</b>
              <span className="mono">{f.fileName}</span>
              {f.status === 'error'
                ? ` · ${f.error}`
                : ` · ${f.visitCount} ${f.visitCount === 1 ? 'visit' : 'visits'}`}
              {f.reader && (
                <span
                  className="chip-ai"
                  title={
                    f.reader === 'recorded'
                      ? 'A saved Claude reading of this exact file (offline/demo mode)'
                      : 'Read just now by Claude'
                  }
                >
                  ✦ read by AI
                </span>
              )}
            </li>
          ))}
          {uploads
            .filter((u) => u.state !== 'done' && !batch?.files.some((f) => f.fileName === u.name))
            .map((u) => (
              <li key={u.name} className={`file-chip ${u.state}`}>
                {u.state === 'reading' ? (
                  <span className="spinner" aria-hidden="true" />
                ) : (
                  <b aria-hidden="true">×</b>
                )}
                <span className="mono">{u.name}</span>
                {u.state === 'reading'
                  ? u.name.toLowerCase().endsWith('.pdf')
                    ? ' · reading with AI…'
                    : ' · reading…'
                  : ` · ${u.message}`}
              </li>
            ))}
        </ul>
      )}

      {done && !batch && (
        <div className="card intake-done">
          <b>✓ {done.approved.length} visits added to the dashboard.</b>{' '}
          {reviewCount(done) > 0
            ? `${reviewCount(done)} still ${reviewCount(done) === 1 ? 'needs' : 'need'} a quick check there.`
            : 'All ready to invoice.'}{' '}
          <Link to="/dashboard">Go to the dashboard →</Link>
        </div>
      )}

      {items.length > 0 && batch && (
        <section className="card grid-card" aria-labelledby="found-title">
          <div className="intake-head">
            <div>
              <h2 className="grid-title" id="found-title">
                We found {items.length} {items.length === 1 ? 'visit' : 'visits'}
              </h2>
              <p className="intake-sub">
                {batch.openFlagCount > 0 ? (
                  <>
                    <span className="needs-look">
                      <span className="flag-q" aria-hidden="true">
                        ?
                      </span>
                      {batch.openFlagCount}{' '}
                      {batch.openFlagCount === 1 ? 'field needs' : 'fields need'} a quick look
                    </span>{' '}
                    — click to confirm or fix. Everything else matched.
                  </>
                ) : (
                  'Everything matched.'
                )}
                {duplicates > 0 && ` ${duplicates} already on file and will be skipped.`}
              </p>
            </div>
            <div style={{ flex: 1 }} />
            <button type="button" className="btn" onClick={discard} disabled={busy}>
              Discard
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={approve}
              disabled={busy || batch.approvableCount === 0}
            >
              {batch.approvableCount === pending.length
                ? `Approve all ${pending.length}`
                : `Approve ${batch.approvableCount} of ${pending.length}`}
            </button>
          </div>
          <AgGridReact<IntakeItemView>
            theme={gridTheme}
            loadThemeGoogleFonts={false}
            rowData={items}
            columnDefs={columnDefs}
            defaultColDef={{
              sortable: false,
              resizable: true,
              suppressHeaderMenuButton: true,
              suppressMovable: true,
            }}
            getRowId={(p) => String(p.data.id)}
            getRowHeight={getRowHeight}
            rowClassRules={rowClassRules}
            context={context}
            onGridReady={(e) => {
              gridApi.current = e.api;
            }}
            domLayout="autoHeight"
            suppressCellFocus
          />
        </section>
      )}

      {open && (
        <Popover
          anchor={open.anchor}
          onClose={() => setOpen(null)}
          label={`${open.flag.label} for ${open.item.patientName}`}
        >
          <FlagChoices
            flag={open.flag}
            busy={busy}
            onChoose={(v) => void resolve(open.item, open.flag, v)}
          />
        </Popover>
      )}
    </main>
  );
}
