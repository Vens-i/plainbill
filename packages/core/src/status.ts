/**
 * Balance status machine.
 *
 *   review ──approve──▶ ready ──send──▶ sent ──payment──▶ partial ──payment──▶ paid
 *     │ ▲                 │  ▲            │                  ▲
 *     │ └──────flag───────┘  └─────────────┘(flag)            │
 *     ├──deny──▶ denied ──resubmit──▶ review                  │
 *     └ ready also accepts a front-desk payment ──────────────┘
 *
 * A payment moves to `paid` when nothing remains, otherwise to `partial`.
 */
export type BalanceStatus = 'review' | 'ready' | 'sent' | 'partial' | 'paid' | 'denied';

/** Group order on the dashboard, matching the design. */
export const STATUS_ORDER: readonly BalanceStatus[] = [
  'review',
  'denied',
  'ready',
  'sent',
  'partial',
  'paid',
];

/** Every status is icon + label (+ color in the UI), never color alone. */
export const STATUS_META: Record<BalanceStatus, { label: string; icon: string }> = {
  review: { label: 'Needs review', icon: '!' },
  denied: { label: 'Denied', icon: '×' },
  ready: { label: 'Ready to invoice', icon: '→' },
  sent: { label: 'Sent', icon: '↗' },
  partial: { label: 'Partially paid', icon: '◐' },
  paid: { label: 'Paid', icon: '✓' },
};

export type StatusEvent =
  | { type: 'approve' }
  | { type: 'flag' }
  | { type: 'deny' }
  | { type: 'resubmit' }
  | { type: 'send' }
  | { type: 'payment'; remainingCents: number };

export class InvalidTransitionError extends Error {
  override name = 'InvalidTransitionError';
  constructor(
    readonly from: BalanceStatus,
    readonly event: StatusEvent['type'],
  ) {
    super(`Cannot apply "${event}" to a balance that is "${from}".`);
  }
}

type Transition = (event: StatusEvent) => BalanceStatus | undefined;

const afterPayment = (event: StatusEvent): BalanceStatus => {
  if (event.type !== 'payment') throw new Error('unreachable');
  if (!Number.isInteger(event.remainingCents) || event.remainingCents < 0) {
    throw new RangeError(
      `remaining balance must be a non-negative integer, got ${event.remainingCents}`,
    );
  }
  return event.remainingCents === 0 ? 'paid' : 'partial';
};

const TRANSITIONS: Record<BalanceStatus, Transition> = {
  review: (e) => (e.type === 'approve' ? 'ready' : e.type === 'deny' ? 'denied' : undefined),
  ready: (e) =>
    e.type === 'send'
      ? 'sent'
      : e.type === 'flag'
        ? 'review'
        : e.type === 'payment'
          ? afterPayment(e)
          : undefined,
  sent: (e) => (e.type === 'payment' ? afterPayment(e) : e.type === 'flag' ? 'review' : undefined),
  partial: (e) => (e.type === 'payment' ? afterPayment(e) : undefined),
  denied: (e) => (e.type === 'resubmit' ? 'review' : undefined),
  paid: () => undefined,
};

export function nextStatus(from: BalanceStatus, event: StatusEvent): BalanceStatus {
  const to = TRANSITIONS[from](event);
  if (!to) throw new InvalidTransitionError(from, event.type);
  return to;
}

export function canTransition(from: BalanceStatus, event: StatusEvent): boolean {
  try {
    nextStatus(from, event);
    return true;
  } catch {
    return false;
  }
}

/** Where a freshly ingested balance starts. */
export function initialStatus(input: {
  denied: boolean;
  patientOwesCents: number;
  needsReview: boolean;
}): BalanceStatus {
  if (input.denied) return 'denied';
  if (input.needsReview) return 'review';
  // Insurance covered everything: nothing to bill, so it's settled.
  if (input.patientOwesCents === 0) return 'paid';
  return 'ready';
}

export function isBalanceStatus(value: string): value is BalanceStatus {
  return value in STATUS_META;
}
