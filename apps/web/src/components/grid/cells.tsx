/**
 * AG Grid cell renderers for the balances grid.
 */
import { useEffect, useState, type CSSProperties } from 'react';
import type { ICellRendererParams, IRowNode } from 'ag-grid-community';
import { agingLabel, isBalanceStatus, STATUS_META } from '@plainbill/core';
import type { BalanceRow } from '@plainbill/api/contract';
import { groupSummary, isPaidNow, plainGroupSummary, relativeTime } from '../../lib/dashboard';
import { AGING_COLORS, STATUS_COLORS } from '../../theme';

/** Shared with the grid through AG Grid's `context`. */
export interface BalancesGridContext {
  /** Open the Review & Send drawer (ready and review rows). */
  openDrawer: (balanceId: number) => void;
  /** The ✦ button: run the suggestion's action (drawer, reminder, plan offer). */
  runSuggestion: (row: BalanceRow, anchor: HTMLElement) => void;
}

/** Suggestions whose one-click action isn't built yet (resubmitting claims to payers). */
const NOT_BUILT = new Set(['resubmit_with_auth', 'add_referral_resubmit', 'resubmit']);

const ACTION_TITLE: Record<string, string> = {
  send_invoice: 'Open Review & Send',
  send_invoice_with_plan: 'Open Review & Send',
  confirm_field: 'Open the review',
  check_duplicate: 'Open the review',
  apply_self_pay_rate: 'Open the review',
  review: 'Open the review',
  send_reminder: 'Email the patient a friendly reminder',
  offer_plan: 'Email the patient a reminder offering a payment plan',
};

/** Statuses the Review & Send drawer handles in Phase 2. */
export const DRAWER_STATUSES: ReadonlyArray<BalanceRow['status']> = ['ready', 'review'];

type Params = ICellRendererParams<BalanceRow, unknown, BalancesGridContext>;

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

export function AiCell({ data, context }: Params) {
  if (!data) return null;
  if (isPaidNow(data)) {
    const via = data.paidVia ?? 'PayPal';
    const paypal = via === 'PayPal';
    return (
      <div className="pb-ai">
        <span className={`paid-badge${paypal ? ' paypal' : ''}`} role="status">
          <span className="paid-badge-check" aria-hidden="true">
            ✓
          </span>
          <span>
            Paid via{' '}
            {paypal ? (
              <span className="paypal-word">
                <b>Pay</b>
                <b className="paypal-pal">Pal</b>
              </span>
            ) : (
              via
            )}{' '}
            · {relativeTime(data.paidAt!)}
          </span>
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
  const action = data.aiAction ?? '';
  if (action === 'none') {
    return (
      <div className="pb-ai">
        <span className="pb-muted">{data.aiSuggestion}</span>
      </div>
    );
  }
  const notBuilt = NOT_BUILT.has(action);
  return (
    <div className="pb-ai">
      <button
        type="button"
        className="ai-btn"
        aria-disabled={notBuilt}
        onClick={notBuilt ? undefined : (e) => context.runSuggestion(data, e.currentTarget)}
        title={
          notBuilt
            ? 'Resubmitting to the payer is not built yet'
            : (ACTION_TITLE[action] ?? 'Open Review & Send')
        }
      >
        <span className="spark" aria-hidden="true">
          ✦
        </span>
        {data.aiSuggestion}
      </button>
    </div>
  );
}

/**
 * Full-width group row: a band tinted in the status's color, with caret + icon + label, a
 * "4 visits" chip, and the group total on the right ("$1,078 to confirm").
 */
export function GroupRow({ node }: ICellRendererParams<BalanceRow>) {
  const expanded = useExpanded(node);
  const rows = (node.childrenAfterFilter ?? [])
    .map((n) => n.data)
    .filter((d): d is BalanceRow => !!d);
  const key = node.key ?? '';
  const status = node.rowGroupColumn?.getColId() === 'status' && isBalanceStatus(key) ? key : null;
  const summary = status ? groupSummary(status, rows) : plainGroupSummary(rows);
  const c = status ? STATUS_COLORS[status] : null;
  const style = c
    ? ({
        '--group-band': c.band,
        '--group-line': c.line,
        '--group-solid': c.solid,
        '--group-ink': c.ink,
        '--group-fg': c.fg,
      } as CSSProperties)
    : undefined;
  return (
    <button
      type="button"
      className={`pb-group${c ? ' pb-group-status' : ''}`}
      style={style}
      onClick={() => node.setExpanded(!node.expanded)}
      aria-expanded={expanded}
    >
      <span className="pb-group-caret" aria-hidden="true">
        {expanded ? '▼' : '▶'}
      </span>
      {status && (
        <span className="pb-group-icon" aria-hidden="true">
          {STATUS_META[status].icon}
        </span>
      )}
      <span className="pb-group-label">{status ? STATUS_META[status].label : key}</span>
      <span className="pb-group-count">{summary.visits}</span>
      <span className="pb-group-total">
        <b>{summary.amount}</b> {summary.what}
      </span>
    </button>
  );
}
