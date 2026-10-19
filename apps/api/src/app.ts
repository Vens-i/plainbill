import { join, sep } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { asc } from 'drizzle-orm';
import {
  OfflineStudioRunner,
  RecordedEobExtractor,
  RuleBillAssistant,
  RuleSuggester,
  TemplateStatementAnnotator,
  TemplateMessageDrafter,
} from '@plainbill/ai';
import {
  claimsFrom835,
  InvalidTransitionError,
  ReconciliationError,
  todayIso,
  X12ParseError,
  type IsoDate,
} from '@plainbill/core';
import type { IntakeResult, PatientNamesMode, PracticeInfo } from './contract';
import type { Db } from './db/client';
import { practices } from './db/schema';
import { REPO_ROOT } from './env';
import { EventBus, streamEvents } from './events';
import { computeAgingChart, computeDenialsChart, computeKpis } from './queries/dashboard';
import { getPatients, matchesPatient } from './queries/patients';
import { getBalanceRows } from './queries/rows';
import { DuplicateClaimError, ingestClaim } from './services/ingest';
import { PaymentError, recordPayment } from './services/payments';
import { DrawerError } from './services/drawer';
import { OutboxMailer } from './services/email';
import { IntakeError } from './services/intake';
import { PatientError } from './services/patient';
import { PatientSessions } from './services/sessions';
import { PayPalError } from './paypal/client';
import { syncOpenItems } from './services/paypal-sync';
import {
  SerialQueue,
  type AiServices,
  type EmailServices,
  type PayPalServices,
  type RouteContext,
} from './routes/context';
import { registerDrawerRoutes } from './routes/drawer';
import { registerInsightsRoutes } from './routes/insights';
import { registerIntakeRoutes } from './routes/intake';
import { registerPatientRoutes } from './routes/patient';
import { registerWebhookRoutes } from './routes/webhooks';

export const DEFAULT_SAMPLE_DIR = join(REPO_ROOT, 'seed', 'data');
export const DEFAULT_RECORDINGS_DIR = join(DEFAULT_SAMPLE_DIR, 'eob-recordings');

/** Offline AI: recorded EOB extractions, template messages, the rule-based bill helper. */
export function offlineAi(recordingsDir = DEFAULT_RECORDINGS_DIR): AiServices {
  return {
    extractor: new RecordedEobExtractor(recordingsDir),
    drafter: new TemplateMessageDrafter(),
    assistant: new RuleBillAssistant(),
    suggester: new RuleSuggester(),
    annotator: new TemplateStatementAnnotator(),
    studio: new OfflineStudioRunner(),
    available: false,
    model: null,
  };
}

export interface AppOptions {
  db: Db;
  /** Pinned demo date, or null for the real date. */
  demoToday?: IsoDate | null;
  devRoutes?: boolean;
  bus?: EventBus;
  logger?: boolean;
  /** Defaults to offline AI (recorded extractions + templates). */
  ai?: AiServices;
  /** Where dev routes read sample files (defaults to seed/data). */
  sampleDir?: string;
  /** Patient names in Practice insights: full (default), initials or off. */
  insights?: { patientNames: PatientNamesMode };
  /** Defaults to "not configured": sends stay local, patient pages can't take payments. */
  paypal?: PayPalServices;
  /** Defaults to the outbox (emails are stored and previewable, not delivered). */
  email?: EmailServices;
  /** Public base URL for patient links (defaults to the Vite dev server). */
  appBaseUrl?: string;
  /** Patient session signing. Defaults to a random secret and non-Secure cookies. */
  sessions?: PatientSessions;
  /** Serve this built web app (apps/web/dist) from the same origin, with an SPA fallback. */
  webDist?: string | null;
}

export const NO_PAYPAL: PayPalServices = {
  api: null,
  clientId: null,
  env: 'sandbox',
  webhookId: null,
};

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export function buildApp(options: AppOptions): {
  app: FastifyInstance;
  bus: EventBus;
  ctx: RouteContext;
} {
  const { db } = options;
  const bus = options.bus ?? new EventBus();
  const today = () => todayIso(options.demoToday ?? null);
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: MAX_UPLOAD_BYTES });

  // 835 files arrive as raw text.
  app.addContentTypeParser(
    ['text/plain', 'application/edi-x12', 'application/octet-stream'],
    { parseAs: 'string' },
    (_req, body, done) => done(null, body),
  );

  app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 10 } });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    // Pay links carry a token: never send the full URL to other sites as a referrer.
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('x-frame-options', 'DENY');
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof PatientError) {
      return reply
        .code(error.status)
        .send({ error: error.code, message: error.message, ...error.extra });
    }
    if (error instanceof PayPalError) {
      app.log.error(
        `PayPal ${error.status} ${error.code} ${error.issue ?? ''} debug_id=${error.debugId}`,
      );
      return reply.code(502).send({
        error: 'paypal',
        message: 'PayPal could not complete that request. Please try again in a moment.',
      });
    }
    if (error instanceof IntakeError || error instanceof DrawerError) {
      return reply.code(error.status).send({
        error: error instanceof IntakeError ? 'intake' : 'drawer',
        message: error.message,
        ...(error instanceof DrawerError && error.details ? { details: error.details } : {}),
      });
    }
    if (error instanceof X12ParseError)
      return reply.code(400).send({ error: 'invalid_835', message: error.message });
    if (error instanceof ReconciliationError) {
      return reply
        .code(422)
        .send({ error: 'does_not_reconcile', message: error.message, claimId: error.claimId });
    }
    if (error instanceof InvalidTransitionError)
      return reply.code(409).send({ error: 'invalid_transition', message: error.message });
    if (error instanceof PaymentError)
      return reply.code(400).send({ error: 'invalid_payment', message: error.message });
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(error);
    return reply.code(status).send({ error: 'error', message: (error as Error).message });
  });

  const practice = () => db.select().from(practices).orderBy(asc(practices.id)).get();
  const ctx: RouteContext = {
    db,
    bus,
    ai: options.ai ?? offlineAi(),
    paypal: options.paypal ?? NO_PAYPAL,
    email: options.email ?? { mailer: new OutboxMailer(), toOverride: null },
    sessions: options.sessions ?? new PatientSessions(null, false),
    queue: new SerialQueue(),
    today,
    practiceId: () => practice()!.id,
    appBaseUrl: options.appBaseUrl ?? 'http://localhost:5173',
    sampleDir: options.sampleDir ?? DEFAULT_SAMPLE_DIR,
    insights: options.insights ?? { patientNames: 'full' },
    log: {
      info: (msg) => app.log.info(msg),
      warn: (msg) => app.log.warn(msg),
      error: (msg) => app.log.error(msg),
    },
  };

  app.register(
    async (api) => {
      api.addHook('onRequest', async (request, reply) => {
        if (request.url.endsWith('/health')) return;
        if (!practice()) {
          return reply
            .code(503)
            .send({ error: 'not_seeded', message: 'The database is empty. Run `pnpm seed`.' });
        }
      });

      api.get('/health', async () => ({ ok: true, today: today() }));

      api.get('/practice', async (): Promise<PracticeInfo> => {
        const p = practice()!;
        return {
          name: p.name,
          phone: p.phone,
          address: [p.addressLine1, p.addressLine2].filter(Boolean).join(', '),
          user: { name: p.staffName, firstName: p.staffFirstName, initials: p.staffInitials },
          today: today(),
        };
      });

      api.get('/balances', async () => getBalanceRows(db, today()));

      api.get<{ Params: { id: string } }>('/balances/:id', async (request, reply) => {
        const [row] = getBalanceRows(db, today(), [Number(request.params.id)]);
        return row ?? reply.code(404).send({ error: 'not_found', message: 'No such balance.' });
      });

      api.get('/kpis', async () => computeKpis(db, getBalanceRows(db, today()), today()));
      /** One row per patient; `q` narrows by name or date of birth ("bel", "04/17/1984"). */
      api.get<{ Querystring: { q?: string } }>('/patients', async (request) => {
        const all = getPatients(db, getBalanceRows(db, today()), today());
        const q = request.query.q ?? '';
        return all.filter((p) => matchesPatient(p, q));
      });
      api.get('/charts/aging', async () => computeAgingChart(getBalanceRows(db, today())));
      api.get('/charts/denials-by-payer', async () =>
        computeDenialsChart(getBalanceRows(db, today()), today()),
      );

      api.get('/events', (request, reply) => streamEvents(bus, request, reply));

      registerIntakeRoutes(api, ctx, options.devRoutes ?? false);
      registerDrawerRoutes(api, ctx);
      registerPatientRoutes(api, ctx);
      registerWebhookRoutes(api, ctx);
      registerInsightsRoutes(api, ctx);

      api.post<{ Querystring: { fileName?: string }; Body: string }>(
        '/intake/835',
        async (request, reply) => {
          if (typeof request.body !== 'string' || request.body.trim() === '') {
            return reply.code(400).send({
              error: 'empty_body',
              message: 'Send the 835 file as the request body (text/plain).',
            });
          }
          const fileName = request.query.fileName ?? 'upload.835';
          const claims = claimsFrom835(request.body, { fileName });
          const practiceId = practice()!.id;
          const result: IntakeResult = { fileName, created: [], skipped: [] };
          // All-or-nothing: if any claim fails to reconcile, nothing from the file is stored.
          db.transaction((tx) => {
            for (const claim of claims) {
              try {
                const r = ingestClaim(tx, { practiceId, claim });
                result.created.push({
                  balanceId: r.balanceId,
                  claimId: claim.patientControlNumber,
                  patientName: '',
                  status: r.status,
                  owesCents: r.patientOwesCents,
                });
              } catch (err) {
                if (err instanceof DuplicateClaimError)
                  result.skipped.push({ claimId: err.claimId, reason: 'duplicate' });
                else throw err;
              }
            }
          });
          const rows = getBalanceRows(
            db,
            today(),
            result.created.map((c) => c.balanceId),
          );
          for (const c of result.created)
            c.patientName = rows.find((r) => r.id === c.balanceId)?.patientName ?? '';
          if (result.created.length) {
            bus.publish({
              type: 'balances.changed',
              data: { ids: result.created.map((c) => c.balanceId) },
            });
          }
          return reply.code(result.created.length ? 201 : 200).send(result);
        },
      );

      if (options.devRoutes) {
        /** Dev only: run one PayPal reconciliation pass now instead of waiting for the poll. */
        api.post('/dev/paypal/sync', async () => syncOpenItems(ctx));

        /**
         * Dev only: pretend PayPal just told us this balance was paid in full, so the live
         * flash can be rehearsed before the webhook exists.
         */
        api.post<{ Params: { balanceId: string } }>(
          '/dev/simulate-payment/:balanceId',
          async (request, reply) => {
            const balanceId = Number(request.params.balanceId);
            if (!Number.isInteger(balanceId))
              return reply
                .code(400)
                .send({ error: 'bad_id', message: 'Balance id must be a number.' });
            const receivedAt = new Date().toISOString();
            const result = recordPayment(db, balanceId, {
              method: 'paypal',
              source: 'simulated',
              postedOn: today(),
              receivedAt,
            });
            const [balance] = getBalanceRows(db, today(), [balanceId]);
            const payment = {
              id: result.paymentId,
              amountCents: result.amountCents,
              method: 'paypal',
              source: 'simulated',
              receivedAt,
            };
            bus.publish({ type: 'payment', data: { balance: balance!, payment } }, result.eventId);
            return { balance, payment };
          },
        );
      }
    },
    { prefix: '/api' },
  );

  if (options.webDist) {
    const webDist = options.webDist;
    app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
      setHeaders: (res, path) =>
        res.header(
          'cache-control',
          path.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
        ),
    });
    // Client-side routes (/dashboard, /pay/:token…) get the app shell; unknown API paths 404.
    app.setNotFoundHandler((request, reply) => {
      if (request.method !== 'GET' || request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not_found', message: 'Not found.' });
      }
      return reply.header('cache-control', 'no-cache').sendFile('index.html', webDist);
    });
  }

  return { app, bus, ctx };
}
