/**
 * Master/detail panel: services, adjustments translated to plain English, and what the
 * patient owes. Every amount here comes from the API (computed by @plainbill/core).
 */
import type { ICellRendererParams } from 'ag-grid-community';
import { formatMoney, formatMoneyShort } from '@plainbill/core';
import type { BalanceRow, DisplayAdjustment } from '@plainbill/api/contract';
import { DRAWER_STATUSES, type BalancesGridContext } from './cells';

function adjustmentAmount(a: DisplayAdjustment): string {
  if (a.amountCents == null) return '';
  return formatMoney(a.amountCents);
}

function planNote(row: BalanceRow): string | null {
  const plan = row.plan;
  if (!plan) return null;
  if (!plan.eligible) return 'Too small for a payment plan';
  return plan.firstCents === plan.regularCents
    ? `Plan-eligible: ${plan.months} × ${formatMoneyShort(plan.regularCents)}`
    : `Plan-eligible: ${formatMoneyShort(plan.firstCents)}, then ${plan.months - 1} × ${formatMoneyShort(plan.regularCents)}`;
}

const ACTION_LABEL: Record<BalanceRow['status'], string> = {
  review: 'Review & confirm →',
  ready: 'Review & send →',
  sent: 'Send a reminder →',
  partial: 'Send a reminder →',
  denied: 'Fix & resubmit →',
  paid: 'View receipt →',
};

export function DetailPanel({
  data,
  context,
}: ICellRendererParams<BalanceRow, unknown, BalancesGridContext>) {
  if (!data) return null;
  const owesLabel = data.status === 'paid' ? 'Patient paid' : 'Patient owes';
  const owesValue =
    data.status === 'denied'
      ? formatMoney(0)
      : formatMoney(data.status === 'paid' ? data.patientPaidCents : data.remainingCents);
  const note =
    data.status === 'denied'
      ? 'Denied — not billed to the patient'
      : data.status === 'paid'
        ? data.paidInDays != null
          ? `Paid in ${data.paidInDays} days${data.paidVia ? ` via ${data.paidVia}` : ''}`
          : 'Settled'
        : planNote(data);

  return (
    <div className="pb-detail" role="region" aria-label={`Details for ${data.patientName}`}>
      <section>
        <h3>Services</h3>
        <div className="pb-services">
          {data.lines.map((l, i) => (
            <div key={`${l.code}-${i}`} style={{ display: 'contents' }}>
              <span className="pb-code">{l.code}</span>
              <span>{l.description}</span>
              <span className="pb-right">{formatMoney(l.chargeCents)}</span>
            </div>
          ))}
          <span />
          <span className="pb-total">Billed</span>
          <span className="pb-total pb-right">{formatMoney(data.billedCents)}</span>
        </div>
      </section>

      <section>
        <h3>Adjustments, translated</h3>
        <div className="pb-adjustments">
          {data.adjustments.map((a, i) => (
            <div className="pb-adj" key={`${a.code}-${i}`}>
              <span className="pb-chip">{a.code}</span>
              <span className="pb-arrow" aria-hidden="true">
                →
              </span>
              <span className="pb-adj-label">{a.label}</span>
              <span>{adjustmentAmount(a)}</span>
            </div>
          ))}
        </div>
        {data.reviewReason && <div className="pb-review-note">! {data.reviewReason}</div>}
      </section>

      <section className="pb-owes-panel">
        <div>
          <div className="pb-owes-label">{owesLabel}</div>
          <div className="pb-owes-value">{owesValue}</div>
          {note && <div className="pb-owes-note">{note}</div>}
        </div>
        <button
          type="button"
          className={data.status === 'ready' ? 'btn btn-primary' : 'btn'}
          disabled={!DRAWER_STATUSES.includes(data.status)}
          onClick={() => context.openDrawer(data.id)}
          title={DRAWER_STATUSES.includes(data.status) ? undefined : 'Arrives in a later phase'}
        >
          {ACTION_LABEL[data.status]}
        </button>
      </section>
    </div>
  );
}
