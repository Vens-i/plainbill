import { formatMoneyShort } from '@plainbill/core';
import type { Kpis } from '@plainbill/api/contract';
import { collectedDelta } from '../lib/dashboard';

interface Props {
  kpis: Kpis | null;
  onStartReview: () => void;
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

export function KpiStrip({ kpis, onStartReview }: Props) {
  if (!kpis) {
    return (
      <div className="kpis" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <div className="kpi" key={i}>
            <div className="kpi-label">
              <span className="skeleton" />
            </div>
            <div className="kpi-value">
              <span className="skeleton" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  const delta = collectedDelta(kpis.collectedThisMonth);
  const avg = kpis.avgDaysToPay;
  return (
    <div className="kpis">
      <div className="kpi">
        <div className="kpi-label">Outstanding patient balances</div>
        <div className="kpi-value">{formatMoneyShort(kpis.outstanding.cents)}</div>
        <div className="kpi-note">across {plural(kpis.outstanding.patients, 'patient')}</div>
      </div>
      <div className="kpi">
        <div className="kpi-label">Collected this month</div>
        <div className="kpi-value">{formatMoneyShort(kpis.collectedThisMonth.cents)}</div>
        <div className={`kpi-note ${delta.tone}`}>{delta.text}</div>
      </div>
      <div className="kpi">
        <div className="kpi-label">Average days to pay</div>
        <div className="kpi-value">{avg.days == null ? '—' : plural(avg.days, 'day')}</div>
        <div
          className={`kpi-note ${avg.days != null && avg.paperBaselineDays != null && avg.days < avg.paperBaselineDays ? 'good' : ''}`}
        >
          {avg.days == null
            ? 'No paid bills yet'
            : avg.paperBaselineDays != null
              ? `${avg.days < avg.paperBaselineDays ? '▼' : '▲'} from ${avg.paperBaselineDays} on paper statements`
              : `across ${plural(avg.paidCount, 'paid bill')}`}
        </div>
      </div>
      <div className="kpi review">
        <div className="kpi-label">! Items needing review</div>
        <div className="kpi-value">{kpis.review.count}</div>
        {kpis.review.firstPatientName ? (
          <button type="button" className="kpi-link" onClick={onStartReview}>
            Start with {kpis.review.firstPatientName} →
          </button>
        ) : (
          <div className="kpi-note">All caught up</div>
        )}
      </div>
    </div>
  );
}
