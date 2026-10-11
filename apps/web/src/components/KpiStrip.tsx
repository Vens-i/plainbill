import type { ReactNode } from 'react';
import { formatMoneyShort } from '@plainbill/core';
import type { AgingChart, Kpis } from '@plainbill/api/contract';
import { collectedDelta } from '../lib/dashboard';
import { AGING_KPI_COLORS } from '../theme';

interface Props {
  kpis: Kpis | null;
  /** Splits the Outstanding card's age bar; the bar is left out until it loads. */
  aging: AgingChart | null;
  onStartReview: () => void;
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** 18×18 stroke icons for the cards' icon tiles. */
const ICONS: Record<'outstanding' | 'collected' | 'days' | 'review', ReactNode> = {
  outstanding: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="2.5" />
      <path d="M3 10h18M16 14.5h2" />
    </>
  ),
  collected: (
    <path d="M12 4v10M7.5 9.5 12 14l4.5-4.5M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16" />
  ),
  days: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  review: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v6M12 16.5v.5" />
    </>
  ),
};

function KpiHead({ icon, children }: { icon: keyof typeof ICONS; children: ReactNode }) {
  return (
    <div className="kpi-head">
      <span className="kpi-icon" aria-hidden="true">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {ICONS[icon]}
        </svg>
      </span>
      <span className="kpi-label">{children}</span>
    </div>
  );
}

/** The Outstanding card's thin bar: balances split by age, fresh to old. */
function AgeBar({ aging }: { aging: AgingChart }) {
  if (aging.totalCents <= 0) return null;
  const overSixty = aging.buckets
    .filter((b) => b.bucket === '61-90' || b.bucket === '90+')
    .reduce((t, b) => t + b.cents, 0);
  return (
    <>
      <div className="kpi-agebar" aria-hidden="true">
        {aging.buckets
          .filter((b) => b.cents > 0)
          .map((b) => (
            <span
              key={b.bucket}
              style={{ flexGrow: b.cents, background: AGING_KPI_COLORS[b.bucket] }}
            />
          ))}
      </div>
      <div className="kpi-agenote">
        {overSixty > 0
          ? `${formatMoneyShort(overSixty)} is over 60 days old`
          : 'Nothing over 60 days old'}
      </div>
    </>
  );
}

export function KpiStrip({ kpis, aging, onStartReview }: Props) {
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
  const fasterThanPaper =
    avg.days != null && avg.paperBaselineDays != null && avg.days < avg.paperBaselineDays;
  return (
    <div className="kpis">
      <div className="kpi kpi-outstanding">
        <KpiHead icon="outstanding">Outstanding patient balances</KpiHead>
        <div className="kpi-value">{formatMoneyShort(kpis.outstanding.cents)}</div>
        <div className="kpi-note">across {plural(kpis.outstanding.patients, 'patient')}</div>
        {aging && <AgeBar aging={aging} />}
      </div>
      <div className="kpi kpi-collected">
        <KpiHead icon="collected">Collected this month</KpiHead>
        <div className="kpi-value">{formatMoneyShort(kpis.collectedThisMonth.cents)}</div>
        <div className={`kpi-note ${delta.tone}`}>{delta.text}</div>
      </div>
      <div className="kpi kpi-days">
        <KpiHead icon="days">Average days to pay</KpiHead>
        <div className="kpi-value">{avg.days == null ? '—' : plural(avg.days, 'day')}</div>
        <div className={`kpi-note ${fasterThanPaper ? 'good' : ''}`}>
          {avg.days == null
            ? 'No paid bills yet'
            : avg.paperBaselineDays != null
              ? `${avg.days < avg.paperBaselineDays ? '▼' : '▲'} from ${avg.paperBaselineDays} on paper statements`
              : `across ${plural(avg.paidCount, 'paid bill')}`}
        </div>
      </div>
      <div className="kpi kpi-review">
        <KpiHead icon="review">Items needing review</KpiHead>
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
