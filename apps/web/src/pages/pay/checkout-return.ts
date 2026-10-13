/** PayPal's `token` query parameter is an order ID, not our patient-link token. */
export function returnedOrder(search: string): string | null {
  const query = new URLSearchParams(search);
  if (query.get('checkout') !== 'approved') return null;
  return query.get('token') || null;
}

/** A return URL is only a hint; capture verifies ownership and PayPal approval server-side. */
export async function recoverCheckout(
  search: string,
  approve: (data: { orderId: string }) => Promise<void>,
  factories: Array<() => ReturnSession>,
): Promise<void> {
  const query = new URLSearchParams(search);
  if (query.get('checkout') === 'cancelled') return;
  const orderId = returnedOrder(search);
  if (orderId) {
    await approve({ orderId });
    return;
  }
  if (query.get('checkout') === 'approved') {
    throw new Error('PayPal did not return an order ID.');
  }
  await resumeCheckout(factories);
}

interface ReturnSession {
  hasReturned?(): boolean;
  resume?(): Promise<unknown>;
  destroy(): void;
}

/** Resume before rendering payment buttons, including when sync already paid the bill. */
export async function resumeCheckout(factories: Array<() => ReturnSession>): Promise<boolean> {
  for (const create of factories) {
    const session = create();
    try {
      if (session.hasReturned?.()) {
        if (!session.resume) throw new Error('PayPal cannot resume this checkout session.');
        await session.resume();
        return true;
      }
    } finally {
      session.destroy();
    }
  }
  return false;
}
