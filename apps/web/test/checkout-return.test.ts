import { describe, expect, it, vi } from 'vitest';
import { recoverCheckout, resumeCheckout, returnedOrder } from '../src/pages/pay/checkout-return';

describe('PayPal checkout return', () => {
  it('reads the approved order without confusing it with the patient-link token', () => {
    expect(returnedOrder('?checkout=approved&token=ORDER-123&PayerID=BUYER')).toBe('ORDER-123');
    expect(returnedOrder('?checkout=cancelled&token=ORDER-123')).toBeNull();
    expect(returnedOrder('?token=ORDER-123')).toBeNull();
    expect(returnedOrder('?checkout=approved')).toBeNull();
  });

  it('resumes the returning session and awaits approval/capture before completing', async () => {
    const approve = vi.fn(async (_orderId: string) => {});
    const destroy = vi.fn();
    const unused = vi.fn();
    let finish!: () => void;
    const resumed = resumeCheckout([
      () => ({ hasReturned: () => false, resume: unused, destroy }),
      () => ({
        hasReturned: () => true,
        resume: async () => {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          await approve('ORDER-123');
        },
        destroy,
      }),
      unused,
    ]);
    expect(approve).not.toHaveBeenCalled();
    finish();
    expect(await resumed).toBe(true);
    expect(approve).toHaveBeenCalledExactlyOnceWith('ORDER-123');
    expect(unused).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it('does not resume or capture on an ordinary bill visit', async () => {
    const resume = vi.fn();
    const destroy = vi.fn();
    expect(await resumeCheckout([() => ({ hasReturned: () => false, resume, destroy })])).toBe(
      false,
    );
    expect(resume).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('recovers the exact returned order even without SDK sessions or payment buttons', async () => {
    const approve = vi.fn(async () => {});
    const createSession = vi.fn();
    await recoverCheckout('?checkout=approved&token=ORDER-123', approve, [createSession]);
    expect(approve).toHaveBeenCalledExactlyOnceWith({ orderId: 'ORDER-123' });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('lets cancellation finish without capture or SDK resumption', async () => {
    const approve = vi.fn();
    const createSession = vi.fn();
    await recoverCheckout('?checkout=cancelled&token=ORDER-123', approve, [createSession]);
    expect(approve).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it('reports an incomplete approved return instead of silently showing the bill', async () => {
    const approve = vi.fn();
    await expect(recoverCheckout('?checkout=approved', approve, [])).rejects.toThrow('order ID');
    expect(approve).not.toHaveBeenCalled();
  });

  it('surfaces capture failures for retry and releases the session', async () => {
    const destroy = vi.fn();
    const failure = new Error('Network unavailable');
    await expect(
      resumeCheckout([
        () => ({
          hasReturned: () => true,
          resume: async () => {
            throw failure;
          },
          destroy,
        }),
      ]),
    ).rejects.toBe(failure);
    expect(destroy).toHaveBeenCalledOnce();
  });
});
