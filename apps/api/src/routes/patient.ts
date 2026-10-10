/**
 * Patient pay page API (/api/pay/:token/…). The token alone reveals only the practice's name;
 * everything else needs the session cookie issued after last name + DOB verification, and the
 * cookie only opens the one bill it was issued for.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PayLinkInfo, PayResult, PatientBill } from '../contract';
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
import type { RouteContext } from './context';

type TokenParams = { Params: { token: string } };

const int = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v);

export function registerPatientRoutes(api: FastifyInstance, ctx: RouteContext): void {
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
