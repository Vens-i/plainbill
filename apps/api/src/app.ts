import Fastify, { type FastifyInstance } from 'fastify';
import { asc } from 'drizzle-orm';
import {
  claimsFrom835,
  InvalidTransitionError,
  ReconciliationError,
  todayIso,
  X12ParseError,
  type IsoDate,
} from '@plainbill/core';
import type { IntakeResult, PracticeInfo } from './contract';
import type { Db } from './db/client';
import { practices } from './db/schema';
import { EventBus, streamEvents } from './events';
import { computeAgingChart, computeDenialsChart, computeKpis } from './queries/dashboard';
import { getBalanceRows } from './queries/rows';
import { DuplicateClaimError, ingestClaim } from './services/ingest';
import { PaymentError, recordPayment } from './services/payments';

export interface AppOptions {
  db: Db;
  /** Pinned demo date, or null for the real date. */
  demoToday?: IsoDate | null;
  devRoutes?: boolean;
  bus?: EventBus;
  logger?: boolean;
}

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export function buildApp(options: AppOptions): { app: FastifyInstance; bus: EventBus } {
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

  app.setErrorHandler((error, _request, reply) => {
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
      api.get('/charts/aging', async () => computeAgingChart(getBalanceRows(db, today())));
      api.get('/charts/denials-by-payer', async () =>
        computeDenialsChart(getBalanceRows(db, today()), today()),
      );

      api.get('/events', (request, reply) => streamEvents(bus, request, reply));

      api.post<{ Querystring: { fileName?: string }; Body: string }>(
        '/intake/835',
        async (request, reply) => {
          if (typeof request.body !== 'string' || request.body.trim() === '') {
            return reply
              .code(400)
              .send({
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

  return { app, bus };
}
