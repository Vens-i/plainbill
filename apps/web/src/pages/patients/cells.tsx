/**
 * Cell renderers for the Patients grid and its per-patient visits grid.
 */
import type { ICellRendererParams } from 'ag-grid-community';
import {
  agingLabel,
  formatShortDate,
  STATUS_META,
  type AgingBucket,
  type BalanceStatus,
} from '@plainbill/core';
import type { PatientActivity, PatientSummary, PatientVisit } from '@plainbill/api/contract';
import { useExpanded } from '../../components/grid/cells';
import { StatusPill } from '../../components/StatusPill';
import { relativeTime } from '../../lib/dashboard';
import { AGING_COLORS, STATUS_COLORS } from '../../theme';

/** Shared with both grids through AG Grid's `context`. */
export interface PatientsGridContext {
  /** Open the Review & Send drawer for one visit. */
  openDrawer: (balanceId: number) => void;
}

type PatientParams = ICellRendererParams<PatientSummary, unknown, PatientsGridContext>;
type VisitParams = ICellRendererParams<PatientVisit, unknown, PatientsGridContext>;

/** Live activity reads as "just now" for a day; older (and seeded) activity shows its date. */
const RECENT_MS = 24 * 60 * 60 * 1000;

export function activityWhen(a: PatientActivity, now: number = Date.now()): string {
  if (a.at && now - Date.parse(a.at) < RECENT_MS) return relativeTime(a.at, now);
  return formatShortDate(a.on);
}

const ACTIVITY_ICON: Record<PatientActivity['kind'], string> = {
  payment: '✓',
  statement_view: '◉',
  reminder: '↻',
  invoice_sent: '↗',
};

export function PatientNameCell({ data, node }: PatientParams) {
  if (!data) return null;
  if (node.rowPinned) return <span className="pt-total-label">{data.name}</span>;
  const latest = data.visits[0];
  return (
    <div className="pb-patient">
      <span className="pb-patient-name">{data.name}</span>
      {latest && (
        <span className="pb-patient-sub" title={latest.sub}>
          {latest.sub}
        </span>
      )}
    </div>
  );
}

function AgingPill({ days, bucket }: { days: number; bucket: AgingBucket }) {
  const c = AGING_COLORS[bucket];
  return (
    <div className="pb-days">
      <span className="pb-days-n">{days}d</span>
      <span className="pill" style={{ background: c.bg, color: c.fg }}>
        {agingLabel(bucket)}
      </span>
    </div>
  );
}

export function OldestOpenCell({ data, node }: PatientParams) {
  if (!data || node.rowPinned) return null;
  if (data.oldestOpenDays == null || !data.oldestOpenBucket) {
    return (
      <div className="pb-days">
        <span className="pb-days-text">Nothing owed</span>
      </div>
    );
  }
  return <AgingPill days={data.oldestOpenDays} bucket={data.oldestOpenBucket} />;
}

export function LastActivityCell({ data, node }: PatientParams) {
  if (!data || node.rowPinned) return null;
  const a = data.lastActivity;
  if (!a) {
    return (
      <div className="pb-patient">
        <span className="pb-muted">No bill sent yet</span>
      </div>
    );
  }
  return (
    <div className="pb-patient">
      <span className={`pt-activity pt-activity-${a.kind}`}>
        <span className="pt-activity-icon" aria-hidden="true">
          {ACTIVITY_ICON[a.kind]}
        </span>
        {a.label}
      </span>
      <span className="pb-patient-sub">{activityWhen(a)}</span>
    </div>
  );
}

/** One compact chip per status (icon + label + color), with a count when there's more than one. */
function StatusChip({ status, count }: { status: BalanceStatus; count: number }) {
  const meta = STATUS_META[status];
  const c = STATUS_COLORS[status];
  return (
    <span
      className="status-pill pt-chip"
      style={{ background: c.bg, borderColor: c.border, color: c.fg }}
    >
      <span className="status-icon" style={{ background: c.fg }} aria-hidden="true">
        {meta.icon}
      </span>
      {meta.label}
      {count > 1 && <span className="pt-chip-count">×{count}</span>}
    </span>
  );
}

export function StatusChipsCell({ data, node }: PatientParams) {
  if (!data || node.rowPinned) return null;
  return (
    <div className="pt-chips">
      {data.statuses.map((s) => (
        <StatusChip key={s.status} status={s.status} count={s.count} />
      ))}
    </div>
  );
}

// ── Visits (detail grid) ────────────────────────────────────────────────────

export function VisitStatusCell({ data }: VisitParams) {
  if (!data) return null;
  return (
    <div className="pt-cell-center">
      <StatusPill status={data.status} />
    </div>
  );
}

export function VisitDaysCell({ data }: VisitParams) {
  if (!data) return null;
  if (data.status === 'paid')
    return (
      <div className="pb-days">
        <span className="pb-days-text">Settled</span>
      </div>
    );
  if (data.daysOut == null || !data.agingBucket || data.status === 'denied') return null;
  return <AgingPill days={data.daysOut} bucket={data.agingBucket} />;
}

const OPEN_LABEL: Record<BalanceStatus, string> = {
  review: 'Review',
  ready: 'Review & send',
  denied: 'Details',
  sent: 'Details',
  partial: 'Details',
  paid: 'Details',
};

export function VisitOpenCell({ data, context }: VisitParams) {
  if (!data) return null;
  return (
    <div className="pt-cell-center">
      <button
        type="button"
        className={data.status === 'ready' ? 'btn btn-primary pt-open' : 'btn pt-open'}
        onClick={() => context.openDrawer(data.balanceId)}
        aria-label={`${OPEN_LABEL[data.status]}: visit on ${formatShortDate(data.visitDate)}`}
      >
        {OPEN_LABEL[data.status]} →
      </button>
    </div>
  );
}

/** Expand/collapse indicator; the grid's row-click handler does the toggling (as on the dashboard). */
export function PatientCaretCell({ node, data }: PatientParams) {
  const expanded = useExpanded(node);
  if (!data || node.rowPinned) return null;
  return (
    <button
      type="button"
      className="pb-caret"
      aria-expanded={expanded}
      aria-label={`${expanded ? 'Hide' : 'Show'} visits for ${data.name}`}
    >
      {expanded ? '▼' : '▶'}
    </button>
  );
}
