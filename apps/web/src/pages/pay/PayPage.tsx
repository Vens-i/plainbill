/**
 * The patient's page (/pay/:token, mobile-first): verify (1e) → the bill (1f) → confirmation
 * (1g, 1h). Everything shown comes from the API; amounts are computed server-side.
 */
import './pay.css';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router';
import type { PatientBill, PayLinkInfo, PayResult } from '@plainbill/api/contract';
import { ApiError, payApi } from '../../lib/api';
import { BillStep } from './BillStep';
import { Confirmation } from './Confirmation';
import { VerifyStep } from './VerifyStep';

export interface Paid {
  kind: 'payment' | 'plan';
  paymentId: number | null;
  pending: boolean;
}

export function PayPage() {
  const { token = '' } = useParams();
  const [info, setInfo] = useState<PayLinkInfo | null>(null);
  const [bill, setBill] = useState<PatientBill | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [paid, setPaid] = useState<Paid | null>(null);

  useEffect(() => {
    document.title = 'Your bill';
    payApi
      .link(token)
      .then(async (i) => {
        setInfo(i);
        document.title = `Your bill · ${i.practice.name}`;
        if (i.verified) setBill(await payApi.bill(token));
      })
      .catch((err: unknown) =>
        setInvalid(err instanceof ApiError ? err.message : 'This page could not be loaded.'),
      );
  }, [token]);

  const onPaid = useCallback((result: PayResult, kind: Paid['kind']) => {
    setBill(result.bill);
    setPaid({ kind, paymentId: result.paymentId, pending: result.pending });
    window.scrollTo({ top: 0 });
  }, []);

  // A payment PayPal hasn't settled yet: check back until it lands.
  useEffect(() => {
    if (!paid?.pending) return;
    const timer = setInterval(async () => {
      const next = await payApi.bill(token).catch(() => null);
      if (!next) return;
      const newest = next.payments.at(-1);
      const settled =
        paid.kind === 'plan'
          ? next.plan && next.plan.paidCount > 0
          : newest && newest.id !== bill?.payments.at(-1)?.id;
      if (settled) {
        setBill(next);
        setPaid({ ...paid, pending: false, paymentId: newest?.id ?? null });
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [paid, token, bill]);

  return (
    <div className="pay-page">
      <main className="pay-main">
        <div className="pay-brand">{info?.practice.name ?? ''}</div>
        {invalid ? (
          <section className="pay-card pay-invalid">
            <h1>This link isn’t working</h1>
            <p>{invalid}</p>
            <p>If you got this link by email, please call the office and we’ll help.</p>
          </section>
        ) : !info ? (
          <div className="pay-loading" aria-live="polite">
            Loading…
          </div>
        ) : !bill ? (
          <VerifyStep token={token} practice={info.practice} onVerified={setBill} />
        ) : paid ? (
          <Confirmation bill={bill} paid={paid} onBack={() => setPaid(null)} />
        ) : (
          <BillStep token={token} bill={bill} onPaid={onPaid} />
        )}
      </main>
    </div>
  );
}
