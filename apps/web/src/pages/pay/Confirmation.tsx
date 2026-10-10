/** Artboards 1g (paid in full) and 1h (plan / partial: remaining balance shown). */
import type { PatientBill } from '@plainbill/api/contract';
import { formatLongDate, formatMoney, formatMonthDay } from '@plainbill/core';
import type { Paid } from './PayPage';

interface Props {
  bill: PatientBill;
  paid: Paid;
  onBack: () => void;
}

const when = (iso: string, withTime: boolean) =>
  new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  }).format(new Date(iso));

export function Confirmation({ bill, paid, onBack }: Props) {
  const payment = bill.payments.find((p) => p.id === paid.paymentId) ?? null;
  const remaining = bill.amounts.remainingCents;
  const plan = paid.kind === 'plan' ? bill.plan : null;
  const practiceShort = bill.practice.name.split(' ')[0];

  if (paid.pending || !payment) {
    return (
      <section className="pay-confirm">
        <div className="pay-confirm-icon is-pending" aria-hidden="true">
          …
        </div>
        <h1 className="pay-confirm-title">
          {paid.kind === 'plan' ? 'Plan approved' : 'Payment approved'}
        </h1>
        <p className="pay-confirm-meta">
          PayPal is finishing up your {paid.kind === 'plan' ? 'first payment' : 'payment'}. This
          page updates by itself — you can also close it. {practiceShort} will be notified.
        </p>
      </section>
    );
  }

  const title = plan ? `Payment ${plan.paidCount} of ${plan.months} received` : 'Payment received';
  return (
    <section className="pay-confirm">
      <div className="pay-confirm-icon" aria-hidden="true">
        ✓
      </div>
      <h1 className="pay-confirm-title">{title}</h1>
      <div className="pay-confirm-amount">{formatMoney(payment.amountCents)}</div>
      <div className="pay-confirm-meta">
        Paid via {payment.via} · {when(payment.paidAt, !plan)}
      </div>

      {plan ? (
        <div className="pay-confirm-card">
          <div className="pay-confirm-row is-big">
            <span>Remaining balance</span>
            <b>{formatMoney(remaining)}</b>
          </div>
          <div className="pay-progress" aria-hidden="true">
            <span style={{ width: `${(plan.paidCount / plan.months) * 100}%` }} />
          </div>
          {plan.schedule.map((i) => (
            <div key={i.number} className={`pay-confirm-row${i.paid ? '' : ' is-muted'}`}>
              <span>
                {i.paid ? '✓' : '○'} {formatMonthDay(i.dueDate)}
              </span>
              <span>
                {formatMoney(i.amountCents)} {i.paid ? 'paid' : 'auto-pay'}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="pay-confirm-card">
          <div className="pay-confirm-row">
            <span>Remaining balance</span>
            <b>{formatMoney(remaining)}</b>
          </div>
          <div className="pay-confirm-row">
            <span>Confirmation #</span>
            <span className="pay-mono">{payment.confirmation}</span>
          </div>
        </div>
      )}

      <p className="pay-confirm-note">
        {plan
          ? 'PayPal takes each payment automatically on these dates. No interest or fees.'
          : remaining === 0
            ? `You're all set. ${practiceShort} has been notified — nothing else to do.`
            : `Thank you! You can pay the remaining ${formatMoney(remaining)} by ${formatLongDate(bill.dueDate)} from this page.`}
      </p>

      <div className="pay-spacer" />
      {remaining > 0 && !plan ? (
        <button type="button" className="pay-btn-outline" onClick={onBack}>
          Back to my bill
        </button>
      ) : (
        <button type="button" className="pay-btn-outline" onClick={() => window.print()}>
          View receipt
        </button>
      )}
      {plan && (
        <p className="pay-fine">
          Confirmation <span className="pay-mono">{payment.confirmation}</span>
        </p>
      )}
    </section>
  );
}
