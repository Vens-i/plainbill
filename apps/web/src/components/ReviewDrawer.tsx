/**
 * Review & Send drawer (artboard 1c). Review rows first confirm their AI-flagged fields; ready rows
 * get an AI-drafted message, payment options and "Send invoice". Every figure shown comes from
 * the server (computed by @plainbill/core); the AI only words the message.
 *
 * "Send invoice" creates and sends the PayPal invoice (PayPal's own emails off), then emails the
 * patient our breakdown with PayPal's button and the secure pay link.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatLongDate, formatMoney, formatMoneyShort } from '@plainbill/core';
import type {
  DrawerData,
  MessageVariant,
  PaymentOption,
  SendResult,
} from '@plainbill/api/contract';
import { api, ApiError } from '../lib/api';
import { FlagChoices } from './FlagChoices';
import { StatusPill } from './StatusPill';
import { toast } from './Toast';

interface Props {
  balanceId: number;
  onClose: () => void;
}

type Source = 'ai' | 'template' | 'edited';

const sameOption = (a: PaymentOption, b: PaymentOption) =>
  a.type === b.type && (a.type !== 'plan' || (b.type === 'plan' && a.months === b.months));

/** What happened, in one toast line. */
function sentToast(r: SendResult): string {
  const who = r.balance.patientFirstName;
  const invoice = r.paypal
    ? `PayPal invoice #${r.paypal.number ?? r.paypal.invoiceId}`
    : 'Invoice (PayPal not configured)';
  const email =
    r.email.status === 'sent'
      ? `bill emailed${r.email.deliveredTo ? ` to ${r.email.deliveredTo}` : ''}`
      : r.email.status === 'outbox'
        ? 'email kept in the outbox (no email provider set)'
        : `email failed: ${r.email.error ?? 'unknown error'}`;
  return `✓ Sent to ${who} · ${invoice} · ${email}`;
}

function shareLine(d: DrawerData): string {
  const s = d.balance.patientShare;
  const parts = [
    s.deductibleCents && `Deductible ${formatMoneyShort(s.deductibleCents)}`,
    s.coinsuranceCents && `coinsurance ${formatMoneyShort(s.coinsuranceCents)}`,
    s.copayCents && `copay ${formatMoneyShort(s.copayCents)}`,
    s.otherCents && `not covered ${formatMoneyShort(s.otherCents)}`,
  ].filter(Boolean) as string[];
  if (!parts.length)
    return d.balance.payerKind === 'self-pay' ? 'Self-pay balance' : 'Patient share';
  const line = parts.join(' + ');
  return line[0]!.toUpperCase() + line.slice(1);
}

export function ReviewDrawer({ balanceId, onClose }: Props) {
  const [data, setData] = useState<DrawerData | null>(null);
  const [message, setMessage] = useState('');
  const [source, setSource] = useState<Source>('template');
  const [variant, setVariant] = useState<MessageVariant>('default');
  const [lang, setLang] = useState('en');
  const [option, setOption] = useState<PaymentOption>({ type: 'full' });
  const [drafting, setDrafting] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; details: string[] } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const draftSeq = useRef(0);

  const draft = useCallback(
    async (v: MessageVariant, l: string, o: PaymentOption) => {
      const seq = ++draftSeq.current;
      setDrafting(true);
      setNotes([]);
      try {
        const r = await api.draftMessage(balanceId, { variant: v, lang: l }, o);
        if (seq !== draftSeq.current) return;
        setMessage(r.text);
        setSource(r.source);
        setVariant(r.variant);
        setLang(r.lang);
        setNotes(r.notes);
      } catch (e) {
        if (seq === draftSeq.current)
          setNotes([`Couldn’t draft a message: ${(e as Error).message}`]);
      } finally {
        if (seq === draftSeq.current) setDrafting(false);
      }
    },
    [balanceId],
  );

  const apply = useCallback(
    (d: DrawerData, { redraft }: { redraft: boolean }) => {
      setData(d);
      setMessage(d.draft.message);
      setSource(d.draft.messageSource);
      setOption(d.draft.paymentOption);
      setVariant('default');
      setLang(d.draft.lang);
      if (redraft && d.balance.status === 'ready' && !d.draft.saved && d.ai.available)
        void draft('default', d.draft.requestedLang, d.draft.paymentOption);
    },
    [draft],
  );

  useEffect(() => {
    api.drawer(balanceId).then(
      (d) => apply(d, { redraft: true }),
      (e: Error) => setError({ message: e.message, details: [] }),
    );
  }, [balanceId, apply]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    panel.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? { message: e.message, details: e.details }
          : { message: String(e), details: [] },
      );
    } finally {
      setBusy(false);
    }
  };

  const chooseOption = (o: PaymentOption) => {
    if (data && sameOption(o, option)) return;
    setOption(o);
    // Keep the wording in step with the option unless staff edited it by hand.
    if (source !== 'edited') void draft(variant, lang, o);
  };

  const resolveFlag = (path: string, value: string) =>
    run(async () => {
      const d = await api.resolveReviewFlag(balanceId, path, value);
      apply(d, { redraft: false });
    });

  const markReady = () =>
    run(async () => {
      const d = await api.markReady(balanceId);
      apply(d, { redraft: true });
      toast(`${d.balance.patientName} is ready to invoice`);
    });

  const saveDraft = () =>
    run(async () => {
      const d = await api.saveDraft(balanceId, {
        message,
        messageSource: source,
        messageLang: lang,
        paymentOption: option,
      });
      setData(d);
      toast('Draft saved');
    });

  const send = () =>
    run(async () => {
      const r = await api.send(balanceId, {
        message,
        messageSource: source,
        messageLang: lang,
        paymentOption: option,
      });
      toast(sentToast(r));
      onClose();
    });

  // The full preview renders the saved draft, so save what's on screen first.
  const openPreview = () =>
    run(async () => {
      const tab = window.open('', '_blank');
      const d = await api.saveDraft(balanceId, {
        message,
        messageSource: source,
        messageLang: lang,
        paymentOption: option,
      });
      setData(d);
      if (tab) tab.location.href = `/email-preview/${balanceId}`;
    });

  // The statement preview uses the saved draft's payment option, so save first too.
  const openStatement = () =>
    run(async () => {
      const tab = window.open('', '_blank');
      const d = await api.saveDraft(balanceId, {
        message,
        messageSource: source,
        messageLang: lang,
        paymentOption: option,
      });
      setData(d);
      if (tab) tab.location.href = `/api/balances/${balanceId}/statement.pdf`;
    });

  const b = data?.balance;
  const plan3 = data?.plans.find((p) => p.months === 3);
  const planMonths = option.type === 'plan' ? option.months : 3;
  const chosenPlan = data?.plans.find((p) => p.months === planMonths);
  const anyPlan = data?.plans.some((p) => p.eligible) ?? false;
  const reviewing = b?.status === 'review';
  const canSend = b?.status === 'ready';

  return (
    <div className="drawer-root" role="presentation">
      <div className="drawer-overlay" onClick={onClose} />
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        tabIndex={-1}
        ref={panel}
      >
        {!data || !b ? (
          <div className="drawer-loading">{error ? error.message : 'Loading…'}</div>
        ) : (
          <>
            <header className="drawer-head">
              <div style={{ flex: 1 }}>
                <StatusPill status={b.status} />
                <h2 id="drawer-title" className="drawer-name">
                  {b.patientName}
                </h2>
                <div className="drawer-meta">
                  Visit {formatLongDate(b.visitDate)}
                  {b.providerFullName ? ` · ${b.providerFullName}` : ''} · {b.payerName}
                </div>
              </div>
              <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
                ×
              </button>
            </header>

            <div className="drawer-body">
              {reviewing && data.review && (
                <section className="review-box" aria-label="Needs a quick check">
                  <h3>Needs a quick check</h3>
                  {data.review.flags.length > 0 ? (
                    data.review.flags.map((f) => (
                      <FlagChoices
                        key={f.path}
                        flag={f}
                        busy={busy}
                        onChoose={(v) => void resolveFlag(f.path, v)}
                      />
                    ))
                  ) : (
                    <p className="review-reason">
                      {data.review.reason ?? 'Check the details below.'}
                    </p>
                  )}
                  {data.review.resolved.map((r) => (
                    <p key={`${r.path}-${r.to}`} className="resolved-note">
                      ✓ {r.label}: {r.to}
                      {r.from !== r.to ? ` (read as ${r.from})` : ''}
                    </p>
                  ))}
                </section>
              )}

              <section className="owes-box">
                <div>
                  <div className="pb-owes-label">Patient owes</div>
                  <div className="owes-big">{formatMoney(b.remainingCents)}</div>
                </div>
                <div className="owes-rows">
                  <span>Billed</span>
                  <span className="pb-right">{formatMoney(b.billedCents)}</span>
                  {b.payerKind === 'insurance' && (
                    <>
                      <span>Insurance discount</span>
                      <span className="pb-right">{formatMoney(-b.contractualCents)}</span>
                      <span>Insurance paid</span>
                      <span className="pb-right">{formatMoney(-(b.insurancePaidCents ?? 0))}</span>
                    </>
                  )}
                  {b.patientPaidCents > 0 && (
                    <>
                      <span>Paid so far</span>
                      <span className="pb-right">{formatMoney(-b.patientPaidCents)}</span>
                    </>
                  )}
                  <b>{shareLine(data)}</b>
                  <b className="pb-right">{formatMoney(b.remainingCents)}</b>
                </div>
              </section>

              {canSend && (
                <>
                  <section>
                    <div className="msg-head">
                      <h3 className="drawer-h3">Message to {b.patientFirstName}</h3>
                      <span className={`msg-badge ${source}`}>
                        {source === 'ai'
                          ? '✦ AI draft'
                          : source === 'edited'
                            ? 'Edited'
                            : 'Template'}
                      </span>
                      <div style={{ flex: 1 }} />
                      {(['default', 'simpler', 'spanish'] as const)
                        .filter((v) => (v === 'spanish' ? lang !== 'es' : v !== variant))
                        .map((v) => (
                          <button
                            key={v}
                            type="button"
                            className="link-btn"
                            disabled={drafting}
                            onClick={() =>
                              void (v === 'spanish'
                                ? draft('default', 'es', option)
                                : draft(v, lang, option))
                            }
                          >
                            {v === 'default'
                              ? 'Original'
                              : v === 'simpler'
                                ? 'Make simpler'
                                : 'Spanish'}
                          </button>
                        ))}
                    </div>
                    <textarea
                      className="msg-text"
                      value={drafting ? '' : message}
                      placeholder={drafting ? '✦ Drafting…' : ''}
                      onChange={(e) => {
                        setMessage(e.target.value);
                        setSource('edited');
                      }}
                      aria-label={`Message to ${b.patientFirstName}`}
                      aria-busy={drafting}
                    />
                    <div className="msg-foot">
                      {data.messageProvenance}
                      {!data.ai.available &&
                        ' AI drafting is off (no API key), so this is the template.'}
                    </div>
                    {notes.map((n) => (
                      <div key={n} className="msg-note">
                        {n}
                      </div>
                    ))}
                  </section>

                  <section>
                    <h3 className="drawer-h3">Payment options</h3>
                    <div className="pay-options" role="radiogroup" aria-label="Payment options">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={option.type === 'full'}
                        className="pay-option"
                        onClick={() => chooseOption({ type: 'full' })}
                      >
                        <span className="pay-option-title">
                          <span className="radio-dot" />
                          Pay in full
                        </span>
                        <span className="pay-option-sub">
                          {formatMoneyShort(b.remainingCents)} today
                        </span>
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={option.type === 'partial'}
                        className="pay-option"
                        onClick={() =>
                          chooseOption({ type: 'partial', minimumCents: data.partialMinimumCents })
                        }
                      >
                        <span className="pay-option-title">
                          <span className="radio-dot" />
                          Allow partial
                        </span>
                        <span className="pay-option-sub">
                          Any amount, {formatMoneyShort(data.partialMinimumCents)} min
                        </span>
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={option.type === 'plan'}
                        className="pay-option"
                        disabled={!anyPlan}
                        onClick={() =>
                          chooseOption({ type: 'plan', months: plan3?.eligible ? 3 : 6 })
                        }
                      >
                        <span className="pay-option-title">
                          <span className="radio-dot" />
                          Payment plan
                        </span>
                        <span className="pay-option-sub">
                          {!anyPlan
                            ? 'Too small for a plan'
                            : chosenPlan && chosenPlan.firstCents === chosenPlan.regularCents
                              ? `${planMonths} × ${formatMoney(chosenPlan.regularCents)}`
                              : `${planMonths} payments`}
                        </span>
                      </button>
                    </div>
                    {option.type === 'plan' && (
                      <div className="plan-row">
                        <span>Split over</span>
                        <div className="segmented">
                          {data.plans.map((p) => (
                            <button
                              key={p.months}
                              type="button"
                              aria-pressed={option.months === p.months}
                              disabled={!p.eligible}
                              onClick={() => chooseOption({ type: 'plan', months: p.months })}
                            >
                              {p.months} months
                            </button>
                          ))}
                        </div>
                        <span>No interest or fees from Harborview</span>
                      </div>
                    )}
                  </section>

                  <section className="email-preview">
                    <div className="email-thumb" aria-hidden="true">
                      <div className="thumb-logo" />
                      <div className="thumb-card">
                        <div className="thumb-line" />
                        <div className="thumb-amount">{formatMoney(b.remainingCents)}</div>
                        <div className="thumb-bar">
                          <span
                            style={{ flex: b.contractualCents || 0.0001 }}
                            className="seg-discount"
                          />
                          <span
                            style={{ flex: b.insurancePaidCents || 0.0001 }}
                            className="seg-paid"
                          />
                          <span style={{ flex: b.remainingCents || 0.0001 }} className="seg-owes" />
                        </div>
                        <div className="thumb-button" />
                        <div className="thumb-line short" />
                      </div>
                    </div>
                    <div className="email-meta">
                      <b>Email preview</b>
                      <div>Subject: {data.email.subject}</div>
                      <div>
                        To {data.email.to} ·{' '}
                        <button type="button" className="link-button" onClick={openPreview}>
                          Open full preview
                        </button>
                      </div>
                      <div>
                        <button type="button" className="link-button" onClick={openStatement}>
                          Preview statement (PDF)
                        </button>
                      </div>
                    </div>
                  </section>
                </>
              )}

              {error && (
                <div className="banner" role="alert">
                  {error.message}
                  {error.details.length > 0 && (
                    <ul>
                      {error.details.map((d) => (
                        <li key={d}>{d}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

            <footer className="drawer-foot">
              {reviewing ? (
                <>
                  <div className="drawer-foot-note">
                    Once everything checks out, the balance moves to Ready to invoice.
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary btn-tall"
                    disabled={busy || !data.review?.canMarkReady}
                    onClick={markReady}
                  >
                    Mark ready →
                  </button>
                </>
              ) : canSend ? (
                <>
                  <div className="drawer-foot-note">
                    Pay link opens a secure page — patient verifies with last name + date of birth.
                  </div>
                  <button
                    type="button"
                    className="btn btn-tall"
                    disabled={busy || drafting}
                    onClick={saveDraft}
                  >
                    Save draft
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-tall"
                    disabled={busy || drafting || !message.trim()}
                    onClick={send}
                  >
                    Send invoice
                  </button>
                </>
              ) : (
                <div className="drawer-foot-note">
                  Reminders and receipts arrive in a later phase.
                </div>
              )}
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
