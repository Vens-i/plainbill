/**
 * "Pay $240.00": PayPal's official v6 SDK buttons (never restyled). The amount is decided by the
 * server; the browser only says "full" or, when staff allowed it, how much to pay now.
 * Plans (when staff offered one) use PayPal Subscriptions: first payment today, no interest.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  INSTANCE_LOADING_STATE,
  PayLaterOneTimePaymentButton,
  PayPalGuestPaymentButton,
  PayPalOneTimePaymentButton,
  PayPalProvider,
  PayPalSubscriptionButton,
  useEligibleMethods,
  usePayPal,
} from '@paypal/react-paypal-js/sdk-v6';
import type { PatientBill, PayResult } from '@plainbill/api/contract';
import { formatMoney, formatMoneyShort } from '@plainbill/core';
import { ApiError, payApi } from '../../lib/api';
import type { Paid } from './PayPage';

interface Props {
  token: string;
  bill: PatientBill;
  onPaid: (result: PayResult, kind: Paid['kind']) => void;
  /** "Pay over time" in the hero: pre-select this plan (`at` makes each click count). */
  planPick?: { months: 3 | 6; at: number } | null;
}

/** "45.5" / "$45.50" → 4550, or null. */
function parseDollars(text: string): number | null {
  const m = /^\$?\s*(\d{1,6})(?:\.(\d{0,2}))?\s*$/.exec(text.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

const message = (err: unknown) =>
  err instanceof ApiError ? err.message : 'PayPal could not finish. Please try again.';

export function PayOptions({ token, bill, onPaid, planPick }: Props) {
  const total = bill.amounts.remainingCents;
  const minimum = bill.options.partialMinimumCents;
  const [mode, setMode] = useState<'full' | 'part'>('full');
  const [partText, setPartText] = useState('');
  const [months, setMonths] = useState<3 | 6 | null>(
    bill.options.plans.find((p) => p.selected)?.months ?? bill.options.plans[0]?.months ?? null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (planPick && bill.options.plans.some((p) => p.months === planPick.months)) {
      setMonths(planPick.months);
    }
  }, [planPick, bill.options.plans]);

  const part = parseDollars(partText);
  const partProblem =
    mode !== 'part'
      ? null
      : part === null
        ? 'Enter an amount, like 50.00'
        : minimum !== null && part < minimum
          ? `The smallest payment is ${formatMoney(minimum)}.`
          : part > total
            ? `That's more than the ${formatMoney(total)} you owe.`
            : null;
  const amount = mode === 'part' && part !== null && !partProblem ? part : total;
  const canPay = mode === 'full' || (part !== null && !partProblem);

  if (!bill.paypal.enabled || !bill.paypal.clientId) {
    return (
      <section id="pay" className="pay-card pay-pay">
        <h2 className="pay-h2">Pay {formatMoney(total)}</h2>
        <p className="pay-sub">
          Online payment isn’t set up yet. Please call {bill.practice.phone} to pay.
        </p>
      </section>
    );
  }

  return (
    <section id="pay" className="pay-card pay-pay">
      <h2 className="pay-h2">Pay {formatMoney(amount)}</h2>

      {minimum !== null && (
        <div className="pay-amounts" role="radiogroup" aria-label="How much to pay">
          <label className={`pay-amount${mode === 'full' ? ' is-on' : ''}`}>
            <input
              type="radio"
              name="pay-amount"
              checked={mode === 'full'}
              onChange={() => setMode('full')}
            />
            <span>Pay in full</span>
            <b>{formatMoney(total)}</b>
          </label>
          <label className={`pay-amount${mode === 'part' ? ' is-on' : ''}`}>
            <input
              type="radio"
              name="pay-amount"
              checked={mode === 'part'}
              onChange={() => setMode('part')}
            />
            <span>Pay part now</span>
            <small>{formatMoney(minimum)} minimum</small>
          </label>
          {mode === 'part' && (
            <div className="pay-part">
              <label htmlFor="pay-part-input" className="visually-hidden">
                Amount to pay now
              </label>
              <span aria-hidden="true">$</span>
              <input
                id="pay-part-input"
                className="pay-input"
                inputMode="decimal"
                placeholder="50.00"
                value={partText}
                onChange={(e) => setPartText(e.target.value.replace(/[^\d.]/g, ''))}
              />
              {partProblem && partText && <p className="pay-error">{partProblem}</p>}
            </div>
          )}
        </div>
      )}

      <>
        <WalletButtons
          token={token}
          amountCents={amount}
          partCents={mode === 'part' ? part : null}
          disabled={!canPay}
          onPaid={onPaid}
          onError={setError}
        />

        {bill.options.plans.length > 0 && (
          <div className="pay-plans">
            <div className="pay-divider">
              <span>or split it with {bill.practice.name.split(' ')[0]}</span>
            </div>
            <div className="pay-plan-grid" role="radiogroup" aria-label="Payment plan">
              {bill.options.plans.map((p) => (
                <button
                  key={p.months}
                  type="button"
                  role="radio"
                  aria-checked={months === p.months}
                  className={`pay-plan${months === p.months ? ' is-on' : ''}`}
                  onClick={() => setMonths(p.months)}
                >
                  <span className="pay-plan-amount">
                    {formatMoneyShort(p.regularCents)}
                    <small>/mo</small>
                  </span>
                  <span className="pay-plan-count">{p.months} payments</span>
                  {p.firstCents !== p.regularCents && (
                    <span className="pay-plan-first">first {formatMoney(p.firstCents)}</span>
                  )}
                </button>
              ))}
            </div>
            <p className="pay-fine pay-left">
              No interest or fees. First payment today through PayPal.
            </p>
            {months && (
              <div className="pay-button-slot">
                <PayPalSubscriptionButton
                  key={months}
                  type="subscribe"
                  createSubscription={async () => {
                    setError(null);
                    return payApi.startPlan(token, months);
                  }}
                  onApprove={async ({ subscriptionId }) => {
                    try {
                      onPaid(await payApi.confirmPlan(token, subscriptionId), 'plan');
                    } catch (err) {
                      setError(message(err));
                    }
                  }}
                  onError={() => setError('PayPal could not start the plan. Please try again.')}
                />
              </div>
            )}
          </div>
        )}
      </>

      {error && (
        <p className="pay-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** One PayPal SDK instance for the whole bill page (helper cards and the pay section). */
export function PayPalScope({ bill, children }: { bill: PatientBill; children: ReactNode }) {
  if (!bill.paypal.enabled || !bill.paypal.clientId) return <>{children}</>;
  const sandbox = bill.paypal.env === 'sandbox';
  return (
    <PayPalProvider
      clientId={bill.paypal.clientId}
      environment={sandbox ? 'sandbox' : 'production'}
      components={['paypal-payments', 'paypal-guest-payments', 'paypal-subscriptions']}
      pageType="checkout"
      {...(sandbox ? { testBuyerCountry: 'US' } : {})}
    >
      {children}
    </PayPalProvider>
  );
}

interface WalletProps {
  token: string;
  amountCents: number;
  /** Set when paying part; null pays the full remaining balance. */
  partCents: number | null;
  disabled: boolean;
  onPaid: Props['onPaid'];
  onError: (message: string | null) => void;
}

function WalletButtons({ token, amountCents, partCents, disabled, onPaid, onError }: WalletProps) {
  const { loadingStatus } = usePayPal();
  const payload = useMemo(
    () => ({
      amount: (amountCents / 100).toFixed(2),
      currencyCode: 'USD',
      paymentFlow: 'ONE_TIME_PAYMENT' as const,
    }),
    [amountCents],
  );
  const { eligiblePaymentMethods, isLoading } = useEligibleMethods({ payload });

  const handlers = (fundingSource: string) => ({
    createOrder: async () => {
      onError(null);
      const { orderId } = await payApi.createOrder(token, {
        fundingSource,
        ...(partCents !== null ? { amountCents: partCents } : {}),
      });
      return { orderId };
    },
    onApprove: async ({ orderId }: { orderId: string }) => {
      try {
        onPaid(await payApi.captureOrder(token, orderId), 'payment');
      } catch (err) {
        onError(message(err));
      }
    },
    onCancel: () => onError(null),
    onError: () => onError('PayPal could not finish. Please try again.'),
  });

  if (loadingStatus === INSTANCE_LOADING_STATE.REJECTED) {
    return <p className="pay-error">PayPal didn’t load. Check your connection and refresh.</p>;
  }
  if (loadingStatus === INSTANCE_LOADING_STATE.PENDING || isLoading) {
    return (
      <div className="pay-button-slot pay-button-loading" aria-live="polite">
        Loading PayPal…
      </div>
    );
  }
  return (
    <div className="pay-buttons">
      <div className="pay-button-slot">
        <PayPalOneTimePaymentButton type="pay" disabled={disabled} {...handlers('paypal')} />
      </div>
      {eligiblePaymentMethods?.isEligible('paylater') && (
        <div className="pay-button-slot">
          <PayLaterOneTimePaymentButton disabled={disabled} {...handlers('paylater')} />
        </div>
      )}
      {eligiblePaymentMethods?.isEligible('card') && (
        <div className="pay-button-slot">
          <PayPalGuestPaymentButton disabled={disabled} {...handlers('card')} />
        </div>
      )}
    </div>
  );
}
