/**
 * Artboard 1f: the bill, explained. The hero says what's owed (and why, in one line), the
 * practice's own statement comes with margin notes, and the short version, the helper and the
 * payment options follow.
 */
import { useState } from 'react';
import type { PatientBill, PayResult } from '@plainbill/api/contract';
import { formatLongDate, formatMoney, formatMoneyShort } from '@plainbill/core';
import type { Paid } from './PayPage';
import { AskAboutBill } from './AskAboutBill';
import { formatDay, useI18n } from './i18n';
import { PayOptions } from './PayOptions';
import { StatementExplained } from './statement/StatementExplained';
import { StickyPay } from './StickyPay';
import { Waterfall } from './Waterfall';

interface Props {
  token: string;
  bill: PatientBill;
  onPaid: (result: PayResult, kind: Paid['kind']) => void;
}

/** Scroll to "Ask about your bill" and put the cursor in its box. */
function focusAsk() {
  const input = document.getElementById('pay-ask-input');
  input?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  input?.focus({ preventScroll: true });
}

const scrollToPay = () => document.getElementById('pay')?.scrollIntoView({ behavior: 'smooth' });

export function BillStep({ token, bill, onPaid }: Props) {
  const { t, lang } = useI18n();
  const [termsOpen, setTermsOpen] = useState(false);
  const [planPick, setPlanPick] = useState<{ months: 3 | 6; at: number } | null>(null);
  const { amounts } = bill;
  const paidSome = amounts.paidCents > 0;
  const settled = amounts.remainingCents === 0;
  const owed = formatMoneyShort(amounts.remainingCents);
  const day = formatDay(bill.visit.date, lang);
  const visit = bill.visit.provider
    ? t('visitWith', { date: day, provider: bill.visit.provider })
    : t('visit', { date: day });
  const planRunning = bill.plan?.status === 'active';
  const sub = settled
    ? t('subPaid')
    : planRunning
      ? `${visit} · ${t('subPlan', { paid: bill.plan!.paidCount, months: bill.plan!.months })}`
      : paidSome
        ? `${visit} · ${t('subPartial', { amount: formatMoneyShort(amounts.paidCents) })}`
        : bill.selfPay
          ? `${visit} · ${t('subSelfPay')}`
          : `${visit} · ${t('subInsurance')}`;
  const plans = bill.options.plans;
  const greeting = settled ? 'heroBalance' : paidSome ? 'heroStillOwe' : 'heroOwe';

  return (
    <div className="pay-bill">
      <header className="pay-hero">
        <div className="pay-hero-text">
          <div className="pay-hero-hi">{t(greeting, { name: bill.firstName })}</div>
          <div className="pay-hero-amount">{formatMoney(amounts.remainingCents)}</div>
          <div className="pay-hero-meta">{sub}</div>
        </div>
        <div className="pay-hero-actions">
          <button type="button" className="pay-hero-btn is-ask" onClick={focusAsk}>
            <span aria-hidden="true">✦</span> {t('askButton')}
          </button>
          {!settled && plans.length > 0 && (
            <button
              type="button"
              className="pay-hero-btn is-plan"
              onClick={() => {
                const months = plans.find((p) => p.months === 3)?.months ?? plans[0]!.months;
                setPlanPick({ months, at: Date.now() });
                scrollToPay();
              }}
            >
              {t('payOverTime')}
            </button>
          )}
          {!settled && (
            <button type="button" className="pay-hero-btn is-pay" onClick={scrollToPay}>
              {t('payAmount', { amount: owed })}
            </button>
          )}
        </div>
      </header>

      <StatementExplained token={token} bill={bill} onAsk={focusAsk} />

      <div className="pay-column">
        <section className="pay-card">
          <h2 className="pay-h2">{t('shortVersion')}</h2>
          <p className="pay-sub">{t('tapBar')}</p>
          <Waterfall steps={bill.waterfall} />
        </section>

        {bill.terms.length > 0 && (
          <section className="pay-card pay-terms">
            <button
              type="button"
              className="pay-terms-toggle"
              aria-expanded={termsOpen}
              aria-controls="pay-terms-body"
              onClick={() => setTermsOpen((o) => !o)}
            >
              <span>{t('termsTitle')}</span>
              <span className="pay-terms-sign" aria-hidden="true">
                {termsOpen ? '−' : '+'}
              </span>
            </button>
            {termsOpen && (
              <div id="pay-terms-body" className="pay-terms-body">
                {bill.terms.map((t) => (
                  <p key={t.term}>
                    <b>{t.term}</b> — {t.body}
                  </p>
                ))}
              </div>
            )}
          </section>
        )}

        <>
          <AskAboutBill token={token} bill={bill} onPaid={onPaid} />
          {!settled && <PayOptions token={token} bill={bill} onPaid={onPaid} planPick={planPick} />}
        </>

        {bill.payments.length > 0 && (
          <section className="pay-card">
            <h2 className="pay-h2">{t('yourPayments')}</h2>
            <ul className="pay-lines">
              {bill.payments.map((p) => (
                <li key={p.id}>
                  <span>
                    {formatLongDate(p.paidAt.slice(0, 10))} · {p.via}
                    <span className="pay-mono"> {p.confirmation}</span>
                  </span>
                  <span>{formatMoney(p.amountCents)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="pay-footer">
          {t('footerPrefer')}{' '}
          <a href={`tel:${bill.practice.phone.replace(/\D/g, '')}`}>{bill.practice.phone}</a>
          {bill.practice.hours ? `, ${bill.practice.hours}` : ''}.
          <br />
          {bill.practice.name} · {bill.practice.address}
        </footer>
      </div>
      <StickyPay
        bill={bill}
        label={
          plans.length > 0 ? t('payOrPlan', { amount: owed }) : t('payAmount', { amount: owed })
        }
      />
    </div>
  );
}
