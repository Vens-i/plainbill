/**
 * AG Grid cell renderers for the balances grid.
 */
import { useEffect, useState } from 'react';
import type { ICellRendererParams, IRowNode } from 'ag-grid-community';
import { agingLabel, isBalanceStatus } from '@plainbill/core';
import type { BalanceRow } from '@plainbill/api/contract';
import { groupMeta, isPaidNow, plainGroupMeta, relativeTime } from '../../lib/dashboard';
import { AGING_COLORS } from '../../theme';
import { StatusPill } from '../StatusPill';

type Params = ICellRendererParams<BalanceRow>;

/** Re-render when a node is expanded or collapsed. */
function useExpanded(node: IRowNode): boolean {
  const [expanded, setExpanded] = useState(node.expanded);
  useEffect(() => {
    const update = () => setExpanded(node.expanded);
    node.addEventListener('expandedChanged', update);
    update();
    return () => node.removeEventListener('expandedChanged', update);
  }, [node]);
  return expanded;
}

/**
 * Expand/collapse indicator. The grid's row-click handler does the toggling (AG Grid's native
 * row listener runs before React's, so toggling here too would undo it); being a button keeps
 * it reachable by keyboard, and its click bubbles to the row.
 */
export function CaretCell({ node, data }: Params) {
  const expanded = useExpanded(node);
  if (!data) return null;
  return (
    <button
      type="button"
      className="pb-caret"
      aria-expanded={expanded}
      aria-label={`${expanded ? 'Hide' : 'Show'} details for ${data.patientName}`}
    >
      {expanded ? '▼' : '▶'}
    </button>
  );
}

export function PatientCell({ data }: Params) {
  if (!data) return null;
  return (
    <div className="pb-patient">
      <span className="pb-patient-name">{data.patientName}</span>
      <span className="pb-patient-sub" title={data.sub}>
        {data.sub}
      </span>
    </div>
  );
}

export function DaysCell({ data }: Params) {
  if (!data) return null;
  if (data.status === 'paid') {
    return (
      <div className="pb-days">
        <span className="pb-days-text">
          {data.paidInDays != null ? `Paid in ${data.paidInDays} days` : 'Settled'}
        </span>
      </div>
    );
  }
  if (data.daysOut == null || !data.agingBucket) return null;
  const c = AGING_COLORS[data.agingBucket];
  return (
    <div className="pb-days">
      <span className="pb-days-n">{data.daysOut}d</span>
      <span className="pill" style={{ background: c.bg, color: c.fg }}>
        {agingLabel(data.agingBucket)}
      </span>
    </div>
  );
}

export function AiCell({ data }: Params) {
  if (!data) return null;
  if (isPaidNow(data)) {
    return (
      <div className="pb-ai">
        <span className="paid-badge" role="status">
          ✓ Paid via {data.paidVia ?? 'PayPal'} · {relativeTime(data.paidAt!)}
        </span>
      </div>
    );
  }
  if (!data.aiSuggestion) {
    return (
      <div className="pb-ai">
        <span className="pb-muted">—</span>
      </div>
    );
  }
  return (
    <div className="pb-ai">
      <button
        type="button"
        className="ai-btn"
        // One-click AI actions arrive with packages/ai in a later phase; for now this is a no-op.
        title="AI suggestion — one-click actions arrive in a later phase"
      >
        <span className="spark" aria-hidden="true">
          ✦
        </span>
        {data.aiSuggestion}
      </button>
    </div>
  );
}

/** Full-width group row: caret + status pill + "4 visits · $1,078 to confirm". */
export function GroupRow({ node }: ICellRendererParams<BalanceRow>) {
  const expanded = useExpanded(node);
  const rows = (node.childrenAfterFilter ?? [])
    .map((n) => n.data)
    .filter((d): d is BalanceRow => !!d);
  const key = node.key ?? '';
  const byStatus = node.rowGroupColumn?.getColId() === 'status' && isBalanceStatus(key);
  return (
    <button
      type="button"
      className="pb-group"
      onClick={() => node.setExpanded(!node.expanded)}
      aria-expanded={expanded}
    >
      <span className="pb-group-caret" aria-hidden="true">
        {expanded ? '▼' : '▶'}
      </span>
      {byStatus ? <StatusPill status={key} /> : <span className="pb-group-plain">{key}</span>}
      <span className="pb-group-meta">
        {byStatus ? groupMeta(key, rows) : plainGroupMeta(rows)}
      </span>
    </button>
  );
}
