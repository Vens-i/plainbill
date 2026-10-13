/**
 * Patient pay page API (/api/pay/:token/…). The token alone reveals only the practice's name;
 * everything else needs the session cookie issued after last name + DOB verification, and the
 * cookie only opens the one bill it was issued for.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ChatTurn } from '@plainbill/ai';
import { noteLanguage } from '@plainbill/core';
import type {
  AssistantAnswer,
  AssistantConfirmResult,
  PatientBill,
  PatientStatement,
  PayLinkInfo,
  PayResult,
  StatementNotes,
} from '../contract';
import { confirmAction, factsFor, proposalHandler, QuestionLimiter } from '../services/assistant';
import {
  captureCheckoutOrder,
  confirmPlan,
  createCheckoutOrder,
  invoiceForToken,
  PatientError,
  patientBill,
  payLinkInfo,
  startPlan,
  verifyPatient,
} from '../services/patient';
import { readCookie, SESSION_COOKIE } from '../services/sessions';
import { statementFileName, statementFor, statementIdFor } from '../services/statement';
import { renderStatementPdf } from '../services/statement-pdf';
import { recordStatementView, statementNotesFor } from '../services/statement-notes';
import type { RouteContext } from './context';

type TokenParams = { Params: { token: string } };

const int = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v);

function parseHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (t): t is ChatTurn =>
        !!t &&
        typeof t === 'object' &&
        ((t as ChatTurn).role === 'patient' || (t as ChatTurn).role === 'assistant') &&
        typeof (t as ChatTurn).text === 'string',
    )
    .slice(-8)
    .map((t) => ({ role: t.role, text: t.text.slice(0, 600) }));
}

export function registerPatientRoutes(api: FastifyInstance, ctx: RouteContext): void {
  const limiter = new QuestionLimiter();
  api.register(
    async (pay) => {
      // Bills are personal: never cache them anywhere.
      pay.addHook('onSend', async (_request, reply, payload) => {
        reply.header('cache-control', 'no-store');
        return payload;
      });

      const sessionFor = (request: FastifyRequest) =>
        ctx.sessions.read(readCookie(request.headers.cookie, SESSION_COOKIE));

      const verifiedInvoice = (request: FastifyRequest, token: string) => {
        const invoice = invoiceForToken(ctx, token);
        if (sessionFor(request) !== invoice.id) {
          throw new PatientError('Please confirm your details first.', 401, 'verify_required');
        }
        return invoice;
      };

      pay.get<TokenParams>('/:token', async (request): Promise<PayLinkInfo> => {
        const invoice = invoiceForToken(ctx, request.params.token);
        return payLinkInfo(ctx, sessionFor(request) === invoice.id);
      });

      pay.post<TokenParams & { Body: Record<string, unknown> }>(
        '/:token/verify',
        async (request, reply): Promise<PatientBill> => {
          const invoice = invoiceForToken(ctx, request.params.token);
          const b = request.body ?? {};
          verifyPatient(ctx, invoice, {
            lastName: typeof b.lastName === 'string' ? b.lastName : '',
            month: Number(int(b.month)),
            day: Number(int(b.day)),
            year: Number(int(b.year)),
          });
          const session = ctx.sessions.issue(invoice.id);
          reply.header(
            'set-cookie',
            ctx.sessions.cookieHeader(session.value, session.maxAgeSeconds),
          );
          return patientBill(ctx, invoice.id);
        },
      );

      pay.get<TokenParams>('/:token/bill', async (request): Promise<PatientBill> => {
        const invoice = verifiedInvoice(request, request.params.token);
        return patientBill(ctx, invoice.id);
      });

      /** The practice's itemized statement (codes included: only behind verification). */
      pay.get<TokenParams>('/:token/statement', async (request): Promise<PatientStatement> => {
        const invoice = verifiedInvoice(request, request.params.token);
        const { layout } = statementFor(ctx, invoice.id);
        return {
          layout,
          statementId: statementIdFor(invoice.id),
          pdfPath: `/api/pay/${request.params.token}/statement.pdf`,
        };
      });

      pay.get<TokenParams>('/:token/statement.pdf', async (request, reply) => {
        const invoice = verifiedInvoice(request, request.params.token);
        const { model, layout } = statementFor(ctx, invoice.id);
        const id = statementIdFor(invoice.id);
        const name = model.input.practice.name;
        const pdf = await renderStatementPdf(layout, {
          title: `${name} statement ${id}`,
          date: model.input.statementDate,
        });
        return reply
          .type('application/pdf')
          .header('content-disposition', `inline; filename="${statementFileName(name, id)}"`)
          .send(Buffer.from(pdf));
      });

      /** Margin notes for the statement, in the patient's language (?lang=es; default en). */
      pay.get<TokenParams & { Querystring: { lang?: string } }>(
        '/:token/statement/notes',
        async (request): Promise<StatementNotes> => {
          const invoice = verifiedInvoice(request, request.params.token);
          const notes = await statementNotesFor(ctx, invoice.id, request.query.lang || 'en');
          recordStatementView(ctx, invoice, notes.lang);
          return notes;
        },
      );

      pay.post<TokenParams & { Body: { amountCents?: unknown; fundingSource?: unknown } }>(
        '/:token/orders',
        async (request) => {
          const invoice = verifiedInvoice(request, request.params.token);
          const { amountCents, fundingSource } = request.body ?? {};
          return createCheckoutOrder(ctx, invoice, {
            ...(amountCents !== undefined && amountCents !== null
              ? { amountCents: Number(amountCents) }
              : {}),
            ...(typeof fundingSource === 'string' ? { fundingSource } : {}),
          });
        },
      );

      pay.post<{ Params: { token: string; orderId: string } }>(
        '/:token/orders/:orderId/capture',
        async (request): Promise<PayResult> => {
          const invoice = verifiedInvoice(request, request.params.token);
          const { paymentId, pending } = await captureCheckoutOrder(
            ctx,
            invoice,
            request.params.orderId,
          );
          return { bill: patientBill(ctx, invoice.id), paymentId, pending };
        },
      );

      pay.post<TokenParams & { Body: { months?: unknown } }>('/:token/plan', async (request) => {
        const invoice = verifiedInvoice(request, request.params.token);
        const months = Number(request.body?.months);
        if (months !== 3 && months !== 6) {
          throw new PatientError('Plans are 3 or 6 months.', 400, 'bad_plan');
        }
        return startPlan(ctx, invoice, months);
      });

      pay.post<TokenParams & { Body: { message?: unknown; history?: unknown; lang?: unknown } }>(
        '/:token/assistant',
        async (request): Promise<AssistantAnswer> => {
          const invoice = verifiedInvoice(request, request.params.token);
          const message =
            typeof request.body?.message === 'string' ? request.body.message.trim() : '';
          if (!message) throw new PatientError('Type a question first.', 400, 'empty');
          const language = noteLanguage(
            typeof request.body?.lang === 'string' ? request.body.lang : 'en',
          );
          if (!limiter.allow(invoice.id)) {
            throw new PatientError(
              'That’s a lot of questions for one bill. Please call the office for more help.',
              429,
              'too_many',
            );
          }
          const reply = await ctx.ai.assistant.reply({
            facts: factsFor(ctx, invoice),
            history: parseHistory(request.body?.history),
            message: message.slice(0, 600),
            handler: proposalHandler(ctx, invoice),
            ...(language ? { language: { code: language.code, name: language.name } } : {}),
          });
          if (reply.notes.length) ctx.log.info(`Bill helper notes: ${reply.notes.join(' | ')}`);
          return { text: reply.text, source: reply.source, cards: reply.cards, via: reply.via };
        },
      );

      pay.post<{ Params: { token: string; actionId: string } }>(
        '/:token/assistant/actions/:actionId/confirm',
        async (request): Promise<AssistantConfirmResult> => {
          const invoice = verifiedInvoice(request, request.params.token);
          return confirmAction(ctx, invoice, request.params.actionId);
        },
      );

      pay.post<TokenParams & { Body: { subscriptionId?: unknown } }>(
        '/:token/plan/confirm',
        async (request): Promise<PayResult> => {
          const invoice = verifiedInvoice(request, request.params.token);
          const id = request.body?.subscriptionId;
          if (typeof id !== 'string' || !id) {
            throw new PatientError('Missing subscription.', 400, 'bad_plan');
          }
          const { paymentId, pending } = await confirmPlan(ctx, invoice, id);
          return { bill: patientBill(ctx, invoice.id), paymentId, pending };
        },
      );
    },
    { prefix: '/pay' },
  );
}
