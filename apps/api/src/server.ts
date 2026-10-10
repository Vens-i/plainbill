import {
  ClaudeEobExtractor,
  ClaudeMessageDrafter,
  createClaudeClient,
  RecordedEobExtractor,
  RecordedThenLiveExtractor,
} from '@plainbill/ai';
import { buildApp, NO_PAYPAL, offlineAi } from './app';
import { openDatabase } from './db/client';
import { loadConfig, type Config } from './env';
import { PayPalClient } from './paypal/client';
import type { AiServices, EmailServices, PayPalServices } from './routes/context';
import { OutboxMailer, ResendMailer } from './services/email';
import { startPayPalSync } from './services/paypal-sync';
import { PatientSessions } from './services/sessions';

function aiServices(config: Config): AiServices {
  const { apiKeySet, model, eobMode, recordingsDir } = config.ai;
  if (!apiKeySet || !model || eobMode === 'recorded') return offlineAi(recordingsDir);
  const client = createClaudeClient();
  const live = new ClaudeEobExtractor({ client, model });
  return {
    // "auto" replays recorded extractions for the seed's sample EOBs (stable demos) and reads
    // anything else live.
    extractor:
      eobMode === 'live'
        ? live
        : new RecordedThenLiveExtractor(new RecordedEobExtractor(recordingsDir), live),
    drafter: new ClaudeMessageDrafter({ client, model }),
    available: true,
    model,
  };
}

function paypalServices(config: Config): PayPalServices {
  const { clientId, clientSecret, env, webhookId } = config.paypal;
  if (!clientId || !clientSecret) return NO_PAYPAL;
  return { api: new PayPalClient({ clientId, clientSecret, env }), clientId, env, webhookId };
}

function emailServices(config: Config): EmailServices {
  const { resendApiKey, from, toOverride } = config.email;
  return {
    mailer: resendApiKey ? new ResendMailer({ apiKey: resendApiKey, from }) : new OutboxMailer(),
    toOverride,
  };
}

const config = loadConfig();
const { db } = openDatabase(config.databasePath);
const ai = aiServices(config);
const paypal = paypalServices(config);
const email = emailServices(config);
const { app, ctx } = buildApp({
  db,
  demoToday: config.demoToday,
  devRoutes: config.devRoutes,
  logger: true,
  ai,
  paypal,
  email,
  appBaseUrl: config.appBaseUrl,
  sessions: new PatientSessions(config.sessionSecret, config.appBaseUrl.startsWith('https://')),
});

if (!config.sessionSecret && process.env.NODE_ENV === 'production') {
  app.log.warn('SESSION_SECRET is not set: patient sessions end whenever the server restarts.');
}

try {
  await app.listen({ port: config.port, host: config.host });
  startPayPalSync(ctx, config.paypal.syncSeconds);
  app.log.info(
    `Plainbill API on http://${config.host}:${config.port}/api · db ${config.databasePath} · today ${config.demoToday ?? 'real date'}` +
      ` · AI ${ai.available ? `${ai.model} (EOBs: ${config.ai.eobMode})` : 'offline (recorded + templates)'}` +
      ` · PayPal ${paypal.api ? `${paypal.env}${paypal.webhookId ? ' + webhooks' : ''}${config.paypal.syncSeconds ? `, sync every ${config.paypal.syncSeconds}s` : ''}` : 'off'}` +
      ` · email ${email.mailer.provider}${email.toOverride ? ' (demo inbox)' : ''}` +
      (config.devRoutes ? ' · dev routes on' : ''),
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
