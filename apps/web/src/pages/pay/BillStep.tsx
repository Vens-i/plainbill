/** Artboard 1f: the bill, explained. Tap a bar to learn what it means. */
import { useState } from 'react';
import type { PatientBill, PayResult } from '@plainbill/api/contract';
import { formatLongDate, formatMoney, formatMonthDay } from '@plainbill/core';
import type { Paid } from './PayPage';
import { AskAboutBill } from './AskAboutBill';
import { PayOptions, PayPalScope } from './PayOptions';
import { Waterfall } from './Waterfall';

interface Props {
  token: string;
  bill: PatientBill;
  onPaid: (result: PayResult, kind: Paid['kind']) => void;
}

export function BillStep({ token, bill, onPaid }: Props) {
  const [termsOpen, setTermsOpen] = useState(true);
  const { amounts } = bill;
  const paidSome = amounts.paidCents > 0;
  const visitLine = `Visit ${formatMonthDay(bill.visit.date)}${bill.visit.provider ? ` with ${bill.visit.provider}` : ''}`;
  const settled = amounts.remainingCents === 0;

  return (
    <div className="pay-bill">
      <header className="pay-hero">
        <div className="pay-hero-hi">
          Hi {bill.firstName} —{' '}
          {settled ? 'this bill is paid' : paidSome ? 'you still owe' : 'you owe'}
        </div>
        <div className="pay-hero-amount">{formatMoney(amounts.remainingCents)}</div>
        <div className="pay-hero-meta">
          {settled ? visitLine : `Due ${formatLongDate(bill.dueDate)} · ${visitLine}`}
        </div>
        {bill.plan && bill.plan.status === 'active' && (
          <div className="pay-hero-meta">
            Payment plan: {bill.plan.paidCount} of {bill.plan.months} paid
          </div>
        )}
        {!settled && !bill.plan && (
          <a
            className="pay-btn-primary pay-cta"
            href="#pay"
            onClick={(e) => {
              e.preventDefault();
              document.getElementById('pay')?.scrollIntoView({ behavior: 'smooth' });
            }}
          >
            Choose how to pay ↓
          </a>
        )}
      </header>

      <section className="pay-card">
        <h2 className="pay-h2">How we got to {formatMoney(amounts.remainingCents)}</h2>
        <p className="pay-sub">Tap a bar to learn what it means</p>
        <Waterfall steps={bill.waterfall} />
      </section>

      <section className="pay-card">
        <h2 className="pay-h2">What you were seen for</h2>
        <ul className="pay-lines">
          {bill.services.map((s, i) => (
            <li key={i}>
              <span>{s.name}</span>
              <span>{formatMoney(s.chargeCents)}</span>
            </li>
          ))}
          <li className="pay-lines-total">
            <span>Total billed</span>
            <span>{formatMoney(amounts.billedCents)}</span>
          </li>
        </ul>
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
            <span>What do these terms mean?</span>
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

      <PayPalScope bill={bill}>
        <AskAboutBill token={token} bill={bill} onPaid={onPaid} />
        {!settled && <PayOptions token={token} bill={bill} onPaid={onPaid} />}
      </PayPalScope>

      {bill.payments.length > 0 && (
        <section className="pay-card">
          <h2 className="pay-h2">Your payments</h2>
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
        Prefer a person? Call{' '}
        <a href={`tel:${bill.practice.phone.replace(/\D/g, '')}`}>{bill.practice.phone}</a>
        {bill.practice.hours ? `, ${bill.practice.hours}` : ''}.
        <br />
        {bill.practice.name} · {bill.practice.address}
      </footer>
    </div>
  );
}
