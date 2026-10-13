import { useEffect, useRef, useState, type ReactNode } from 'react';
import { INSTANCE_LOADING_STATE, usePayPal } from '@paypal/react-paypal-js/sdk-v6';
import type { PayResult } from '@plainbill/api/contract';
import { ApiError, payApi } from '../../lib/api';
import { recoverCheckout, returnedOrder } from './checkout-return';

interface Props {
  token: string;
  onPaid: (result: PayResult, kind: 'payment') => void;
  children: ReactNode;
}

/** The return handler stays mounted even when a paid bill has no payment buttons. */
export function CheckoutReturn({ token, onPaid, children }: Props) {
  const { sdkInstance, loadingStatus } = usePayPal();
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Strict Mode replays effects. Share the operation instead of starting two SDK resumes.
  const operation = useRef<{
    sdk: typeof sdkInstance;
    token: string;
    attempt: number;
    promise: Promise<void>;
  } | null>(null);

  useEffect(() => {
    // Mobile browsers can restore the old React tree instead of reloading the return page.
    const restored = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      setError(null);
      setChecking(true);
      setAttempt((n) => n + 1);
    };
    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
  }, []);

  useEffect(() => {
    const directReturn = new URLSearchParams(window.location.search).has('checkout');
    if (!sdkInstance && !directReturn) return;
    let active = true;
    if (
      !operation.current ||
      (!directReturn && operation.current.sdk !== sdkInstance) ||
      operation.current.token !== token ||
      operation.current.attempt !== attempt
    ) {
      const approve = async ({ orderId }: { orderId: string }) => {
        const result = await payApi.captureOrder(token, orderId);
        // Preserve the exact order for refresh; the capture endpoint is idempotent.
        const url = new URL(window.location.href);
        url.searchParams.set('checkout', 'approved');
        url.searchParams.set('token', orderId);
        window.history.replaceState(window.history.state, '', url);
        onPaid(result, 'payment');
      };
      const recover = async () => {
        const search = window.location.search;
        const callbacks = {
          onApprove: approve,
          onCancel: () => {},
          onError: (err: unknown) => {
            throw err;
          },
        };
        await recoverCheckout(
          search,
          approve,
          sdkInstance
            ? [
                () => sdkInstance.createPayPalOneTimePaymentSession(callbacks),
                () => sdkInstance.createPayLaterOneTimePaymentSession(callbacks),
              ]
            : [],
        );
        if (new URLSearchParams(search).get('checkout') === 'cancelled') {
          const url = new URL(window.location.href);
          for (const key of ['checkout', 'token', 'PayerID']) url.searchParams.delete(key);
          window.history.replaceState(window.history.state, '', url);
        }
      };
      operation.current = { sdk: sdkInstance, token, attempt, promise: recover() };
    }
    operation.current.promise
      .catch((err: unknown) => {
        if (active) {
          setError(
            err instanceof ApiError
              ? err.message
              : 'We could not check your PayPal payment. Please try checking again.',
          );
        }
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [sdkInstance, token, attempt, onPaid]);

  if (loadingStatus === INSTANCE_LOADING_STATE.REJECTED && !returnedOrder(window.location.search)) {
    return (
      <p className="pay-error" role="alert">
        PayPal didn’t load. Check your connection and refresh.
      </p>
    );
  }
  if (checking) return <p aria-live="polite">Checking PayPal…</p>;
  if (error) {
    return (
      <section className="pay-card">
        <p className="pay-error" role="alert">
          {error}
        </p>
        <button
          className="pay-btn-outline"
          onClick={() => {
            setError(null);
            setChecking(true);
            setAttempt((n) => n + 1);
          }}
        >
          Check payment again
        </button>
      </section>
    );
  }
  return children;
}
