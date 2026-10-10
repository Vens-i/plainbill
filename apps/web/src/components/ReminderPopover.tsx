/**
 * Confirm step for AI suggests' "Send friendly reminder" / "Offer 3-month plan": what will be
 * emailed, then one click. Plan amounts come from @plainbill/core, like everywhere else.
 */
import { useState } from 'react';
import type { BalanceRow } from '@plainbill/api/contract';
import { formatMoneyShort, planOption } from '@plainbill/core';
import { ApiError, api } from '../lib/api';
import { Popover } from './Popover';
import { toast } from './Toast';

interface Props {
  row: BalanceRow;
  anchor: HTMLElement;
  onClose: () => void;
}

export function ReminderPopover({ row, anchor, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offer = row.aiAction === 'offer_plan';
  const months: 3 | 6 = /6-month/i.test(row.aiSuggestion ?? '') ? 6 : 3;
  const plan = offer ? planOption(row.remainingCents, months) : null;
  const first = row.patientFirstName;

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.remind(row.id, offer ? months : undefined);
      toast(
        r.email.status === 'sent'
          ? `✓ Reminder emailed to ${first}${r.email.deliveredTo ? ` (${r.email.deliveredTo})` : ''}`
          : r.email.status === 'outbox'
            ? `✓ Reminder for ${first} saved to the outbox (no email provider set)`
            : `Reminder failed: ${r.email.error ?? 'unknown error'}`,
      );
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send the reminder.');
      setBusy(false);
    }
  };

  return (
    <Popover anchor={anchor} onClose={onClose} label={`Remind ${row.patientName}`}>
      <div className="reminder-pop">
        <div className="reminder-title">
          {offer ? `Offer ${first} a payment plan?` : `Send ${first} a friendly reminder?`}
        </div>
        <p>
          {offer && plan
            ? `Emails ${first} the bill again with ${months} payments of ${formatMoneyShort(plan.regularCents)} (no interest or fees) and turns plans on for their pay page.`
            : `Emails ${first} the bill again with their secure pay link. Balance ${formatMoneyShort(row.remainingCents)}.`}
        </p>
        {error && <p className="reminder-error">{error}</p>}
        <div className="reminder-actions">
          <button type="button" className="btn btn-small" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary btn-small"
            disabled={busy}
            onClick={send}
          >
            {busy ? 'Sending…' : offer ? 'Send plan offer' : 'Send reminder'}
          </button>
        </div>
      </div>
    </Popover>
  );
}
