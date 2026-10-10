/**
 *   pnpm paypal:webhook [https://your-app.onrender.com]
 *
 * Registers (or updates) the PayPal webhook for <url>/api/webhooks/paypal with the events
 * Plainbill handles, and prints the webhook id to put in PAYPAL_WEBHOOK_ID. Defaults to
 * APP_BASE_URL. PayPal needs a public https URL, so this is run after deploying.
 */
import { loadConfig } from '../src/env';
import { PayPalClient } from '../src/paypal/client';
import { HANDLED_EVENTS } from '../src/services/paypal-sync';

const config = loadConfig();
const { clientId, clientSecret, env } = config.paypal;
if (!clientId || !clientSecret) {
  console.error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET first.');
  process.exit(1);
}
const base = (process.argv[2] ?? config.appBaseUrl).replace(/\/+$/, '');
const url = `${base}/api/webhooks/paypal`;
if (!url.startsWith('https://')) {
  console.error(
    `PayPal only delivers webhooks to https URLs (got ${url}). Pass your deployed URL.`,
  );
  process.exit(1);
}

const paypal = new PayPalClient({ clientId, clientSecret, env });
const existing = (await paypal.listWebhooks()).find((w) => w.url === url);
const hook = existing
  ? await paypal.updateWebhookEvents(existing.id, HANDLED_EVENTS)
  : await paypal.createWebhook(url, HANDLED_EVENTS);
console.log(`${existing ? 'Updated' : 'Created'} the ${env} webhook for ${url}`);
console.log(`Events: ${HANDLED_EVENTS.join(', ')}`);
console.log(
  `\nPAYPAL_WEBHOOK_ID=${hook.id}\n\nSet that in your environment (Render: Environment tab) and redeploy.`,
);
