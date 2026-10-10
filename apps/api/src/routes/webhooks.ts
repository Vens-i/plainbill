/**
 * POST /api/webhooks/paypal. Every delivery is checked with PayPal's verify-webhook-signature
 * API (using the raw body, byte for byte) before anything is trusted. Unverified, or with no
 * PAYPAL_WEBHOOK_ID configured, the event is refused.
 */
import type { FastifyInstance } from 'fastify';
import type { WebhookEvent, WebhookHeaders } from '../paypal/types';
import { handleWebhookEvent } from '../services/paypal-sync';
import type { RouteContext } from './context';

function webhookHeaders(h: Record<string, string | string[] | undefined>): WebhookHeaders | null {
  const get = (name: string) => {
    const v = h[name];
    return typeof v === 'string' && v ? v : null;
  };
  const authAlgo = get('paypal-auth-algo');
  const certUrl = get('paypal-cert-url');
  const transmissionId = get('paypal-transmission-id');
  const transmissionSig = get('paypal-transmission-sig');
  const transmissionTime = get('paypal-transmission-time');
  if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime)
    return null;
  return { authAlgo, certUrl, transmissionId, transmissionSig, transmissionTime };
}

export function registerWebhookRoutes(api: FastifyInstance, ctx: RouteContext): void {
  api.register(async (hooks) => {
    // Keep the body as the exact string PayPal sent; verification needs it unmodified.
    hooks.removeContentTypeParser('application/json');
    hooks.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) =>
      done(null, body),
    );

    hooks.post<{ Body: string }>('/webhooks/paypal', async (request, reply) => {
      const { api: paypal, webhookId } = ctx.paypal;
      if (!paypal || !webhookId) {
        return reply.code(503).send({
          error: 'webhooks_not_configured',
          message: 'Set PAYPAL_WEBHOOK_ID (and the PayPal app credentials) to accept webhooks.',
        });
      }
      const headers = webhookHeaders(request.headers);
      const raw = typeof request.body === 'string' ? request.body : '';
      if (!headers || !raw) {
        return reply
          .code(400)
          .send({ error: 'bad_webhook', message: 'Missing PayPal headers or body.' });
      }
      const genuine = await paypal.verifyWebhookSignature(headers, raw, webhookId);
      if (!genuine) {
        ctx.log.warn(`Rejected a PayPal webhook with a bad signature (${headers.transmissionId}).`);
        return reply
          .code(400)
          .send({ error: 'invalid_signature', message: 'Signature check failed.' });
      }
      let event: WebhookEvent;
      try {
        event = JSON.parse(raw) as WebhookEvent;
      } catch {
        return reply.code(400).send({ error: 'bad_webhook', message: 'Body is not JSON.' });
      }
      // A thrown error answers 500, so PayPal redelivers later.
      const outcome = await handleWebhookEvent(ctx, event);
      ctx.log.info(`PayPal webhook ${event.event_type} ${event.id}: ${outcome}`);
      return { status: outcome };
    });
  });
}
