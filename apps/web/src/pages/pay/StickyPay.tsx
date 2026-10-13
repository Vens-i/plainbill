/**
 * Phone: a pay button that stays at the bottom of the screen ("Pay $240 or pay over time") and
 * scrolls to the payment section. It steps aside while that section is on screen, and isn't
 * shown once the bill is paid.
 */
import { useEffect, useState } from 'react';
import type { PatientBill } from '@plainbill/api/contract';
import { formatMoneyShort } from '@plainbill/core';
import { DESKTOP_QUERY, useMedia } from './statement/useMedia';

export function StickyPay({ bill, label }: { bill: PatientBill; label?: string }) {
  const desktop = useMedia(DESKTOP_QUERY);
  const [payVisible, setPayVisible] = useState(false);
  const owed = bill.amounts.remainingCents;

  useEffect(() => {
    const target = document.getElementById('pay');
    if (!target) return;
    const observer = new IntersectionObserver(([entry]) => setPayVisible(!!entry?.isIntersecting));
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  if (desktop || owed <= 0) return null;
  const text =
    label ??
    (bill.options.plans.length > 0
      ? `Pay ${formatMoneyShort(owed)} or pay over time`
      : `Pay ${formatMoneyShort(owed)}`);
  return (
    <div className={`pay-sticky${payVisible ? ' is-hidden' : ''}`}>
      <a
        className="pay-btn-primary"
        href="#pay"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('pay')?.scrollIntoView({ behavior: 'smooth' });
        }}
      >
        {text}
      </a>
    </div>
  );
}
