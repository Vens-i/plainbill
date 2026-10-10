/**
 * "Ask about your bill" (artboard 1f). Answers come from the server (Claude, checked against
 * the bill, or the rule-based helper). Payment suggestions arrive as cards: the patient taps
 * Confirm, the server creates the PayPal order or subscription (through PayPal's Agent
 * Toolkit), and PayPal's own button appears for that exact amount.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  PayPalOneTimePaymentButton,
  PayPalSubscriptionButton,
} from '@paypal/react-paypal-js/sdk-v6';
import type {
  AssistantCard,
  AssistantConfirmResult,
  PatientBill,
  PayResult,
} from '@plainbill/api/contract';
import { formatMoneyShort } from '@plainbill/core';
import { ApiError, payApi } from '../../lib/api';
import type { Paid } from './PayPage';

interface Props {
  token: string;
  bill: PatientBill;
  onPaid: (result: PayResult, kind: Paid['kind']) => void;
}

interface Turn {
  role: 'patient' | 'assistant';
  text: string;
  source?: string;
  cards?: AssistantCard[];
}

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';

export function AskAboutBill({ token, bill, onPaid }: Props) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const owes = formatMoneyShort(bill.amounts.remainingCents);
  const canSplit = bill.options.plans.length > 0 || bill.options.partialMinimumCents !== null;
  const chips = [
    turns.length === 0 && bill.amounts.remainingCents > 0 ? `Why do I owe ${owes}?` : null,
    canSplit ? 'Can I pay over time?' : null,
    'Is this right?',
  ].filter((c): c is string => c !== null);

  useEffect(() => {
    if (turns.length) end.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [turns]);

  const ask = async (question: string) => {
    const message = question.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    setDraft('');
    const history = turns.map(({ role, text }) => ({ role, text }));
    setTurns((t) => [...t, { role: 'patient', text: message }]);
    try {
      const answer = await payApi.ask(token, message, history);
      setTurns((t) => [
        ...t,
        { role: 'assistant', text: answer.text, source: answer.source, cards: answer.cards },
      ]);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void ask(draft);
  };

  return (
    <section className="pay-card pay-ask" aria-labelledby="pay-ask-title">
      <div className="pay-ask-head">
        <h2 id="pay-ask-title" className="pay-h2">
          Ask about your bill
        </h2>
        <span className="pay-ai-chip">✦ AI helper</span>
      </div>

      {turns.length > 0 && (
        <div className="pay-chat" aria-live="polite">
          {turns.map((t, i) =>
            t.role === 'patient' ? (
              <div key={i} className="pay-bubble is-patient">
                {t.text}
              </div>
            ) : (
              <div key={i} className="pay-answer">
                <div className="pay-bubble is-helper">
                  {t.text}
                  {t.source && <div className="pay-source">{t.source}</div>}
                </div>
                {t.cards?.map((card, j) => (
                  <ActionCard
                    key={card.id ?? `${i}-${j}`}
                    token={token}
                    bill={bill}
                    card={card}
                    onPaid={onPaid}
                  />
                ))}
              </div>
            ),
          )}
          {busy && (
            <div className="pay-bubble is-helper is-typing" aria-label="The helper is typing">
              <span />
              <span />
              <span />
            </div>
          )}
          <div ref={end} />
        </div>
      )}

      {chips.length > 0 && (
        <div className="pay-chips">
          {chips.map((c) => (
            <button
              key={c}
              type="button"
              className="pay-chip"
              disabled={busy}
              onClick={() => ask(c)}
            >
              {c}
            </button>
          ))}
        </div>
      )}

      <form className="pay-ask-form" onSubmit={submit}>
        <label htmlFor="pay-ask-input" className="visually-hidden">
          Your question
        </label>
        <input
          id="pay-ask-input"
          className="pay-input"
          placeholder="Type a question…"
          maxLength={600}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="submit"
          className="pay-send"
          aria-label="Send question"
          disabled={busy || !draft.trim()}
        >
          ↑
        </button>
      </form>
      {error && (
        <p className="pay-error" role="alert">
          {error}
        </p>
      )}
      <p className="pay-fine pay-left">
        Prefer a person? Call{' '}
        <a href={`tel:${bill.practice.phone.replace(/\D/g, '')}`}>{bill.practice.phone}</a>
      </p>
    </section>
  );
}

function ActionCard({
  token,
  bill,
  card,
  onPaid,
}: {
  token: string;
  bill: PatientBill;
  card: AssistantCard;
  onPaid: Props['onPaid'];
}) {
  const [confirmed, setConfirmed] = useState<AssistantConfirmResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (card.kind === 'phone_call') {
    return (
      <div className="pay-action">
        <div className="pay-action-title">{card.title}</div>
        <a className="pay-action-phone" href={`tel:${bill.practice.phone.replace(/\D/g, '')}`}>
          {card.detail[0]}
        </a>
        {card.detail.slice(1).map((d) => (
          <div key={d} className="pay-action-line">
            {d}
          </div>
        ))}
      </div>
    );
  }

  const confirm = async () => {
    if (!card.id) return;
    setBusy(true);
    setError(null);
    try {
      setConfirmed(await payApi.confirmAction(token, card.id));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pay-action">
      <div className="pay-action-title">{card.title}</div>
      {card.detail.map((d) => (
        <div key={d} className="pay-action-line">
          {d}
        </div>
      ))}
      {!bill.paypal.enabled ? (
        <p className="pay-action-line">Online payment isn’t set up yet. Please call the office.</p>
      ) : !confirmed ? (
        <button
          type="button"
          className="pay-btn-primary pay-action-confirm"
          disabled={busy}
          onClick={confirm}
        >
          {busy ? 'Setting it up…' : card.confirmLabel}
        </button>
      ) : (
        <div className="pay-button-slot pay-action-paypal">
          {confirmed.subscriptionId ? (
            <PayPalSubscriptionButton
              type="subscribe"
              createSubscription={async () => ({ subscriptionId: confirmed.subscriptionId! })}
              onApprove={async ({ subscriptionId }) => {
                try {
                  onPaid(await payApi.confirmPlan(token, subscriptionId), 'plan');
                } catch (err) {
                  setError(errorText(err));
                }
              }}
              onError={() => setError('PayPal could not start the plan. Please try again.')}
            />
          ) : confirmed.orderId ? (
            <PayPalOneTimePaymentButton
              type="pay"
              orderId={confirmed.orderId}
              onApprove={async ({ orderId }) => {
                try {
                  onPaid(await payApi.captureOrder(token, orderId), 'payment');
                } catch (err) {
                  setError(errorText(err));
                }
              }}
              onError={() => setError('PayPal could not finish. Please try again.')}
            />
          ) : null}
        </div>
      )}
      {error && <p className="pay-error">{error}</p>}
    </div>
  );
}
