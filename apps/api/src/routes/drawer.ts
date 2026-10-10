/**
 * Review & Send drawer routes. "Send" creates and sends the PayPal invoice, then emails the
 * patient (services/send.ts).
 */
import type { FastifyInstance } from 'fastify';
import { templateMessage } from '@plainbill/ai';
import type {
  DraftMessageResult,
  DrawerData,
  EmailPreview,
  MessageVariant,
  PaymentOption,
  SendResult,
} from '../contract';
import {
  DrawerError,
  draftMessage,
  getDrawerData,
  markReady,
  resolveBalanceFlag,
  saveDraft,
  type DraftInput,
} from '../services/drawer';
import { emailPreview, sendBalanceInvoice } from '../services/send';
import { publishChanged, type RouteContext } from './context';

const VARIANTS: readonly MessageVariant[] = ['default', 'simpler', 'spanish'];

function parseOption(value: unknown): PaymentOption {
  const o = value as Partial<{ type: string; months: number; minimumCents: number }> | undefined;
  if (o?.type === 'full') return { type: 'full' };
  if (o?.type === 'partial' && typeof o.minimumCents === 'number')
    return { type: 'partial', minimumCents: o.minimumCents };
  if (o?.type === 'plan' && (o.months === 3 || o.months === 6))
    return { type: 'plan', months: o.months };
  throw new DrawerError(
    'paymentOption must be { type: "full" }, { type: "partial", minimumCents } or { type: "plan", months: 3 | 6 }.',
  );
}

function parseDraft(body: unknown): DraftInput {
  const b = body as
    Partial<{ message: unknown; messageSource: unknown; paymentOption: unknown }> | undefined;
  if (typeof b?.message !== 'string' || !b.message.trim())
    throw new DrawerError('The message is empty.');
  const source =
    b.messageSource === 'ai' || b.messageSource === 'template' ? b.messageSource : 'edited';
  return { message: b.message, messageSource: source, paymentOption: parseOption(b.paymentOption) };
}

export function registerDrawerRoutes(api: FastifyInstance, ctx: RouteContext): void {
  const id = (raw: string) => {
    const n = Number(raw);
    if (!Number.isInteger(n)) throw new DrawerError('Balance id must be a number.');
    return n;
  };
  const drawer = (balanceId: number): DrawerData =>
    getDrawerData(
      ctx.db,
      balanceId,
      ctx.today(),
      { available: ctx.ai.available, model: ctx.ai.model },
      templateMessage,
    );

  api.get<{ Params: { id: string } }>('/balances/:id/drawer', async (request) =>
    drawer(id(request.params.id)),
  );

  api.post<{ Params: { id: string }; Body: { variant?: unknown; paymentOption?: unknown } }>(
    '/balances/:id/message',
    async (request): Promise<DraftMessageResult> => {
      const variant = VARIANTS.find((v) => v === request.body?.variant) ?? 'default';
      const result = await draftMessage(
        ctx.db,
        id(request.params.id),
        ctx.today(),
        ctx.ai.drafter,
        variant,
        parseOption(request.body?.paymentOption),
      );
      return {
        text: result.text,
        variant: result.variant,
        source: result.source,
        notes: result.notes,
      };
    },
  );

  api.put<{ Params: { id: string } }>('/balances/:id/draft', async (request) => {
    saveDraft(ctx.db, id(request.params.id), ctx.today(), parseDraft(request.body));
    return drawer(id(request.params.id));
  });

  api.post<{ Params: { id: string } }>(
    '/balances/:id/send',
    async (request): Promise<SendResult> => {
      const balanceId = id(request.params.id);
      const result = await sendBalanceInvoice(ctx, balanceId, parseDraft(request.body));
      publishChanged(ctx, [balanceId]);
      return result;
    },
  );

  api.get<{ Params: { id: string } }>(
    '/balances/:id/email',
    async (request): Promise<EmailPreview> => {
      const balanceId = id(request.params.id);
      const { draft } = drawer(balanceId);
      return emailPreview(ctx, balanceId, draft);
    },
  );

  api.post<{ Params: { id: string }; Body: { path?: unknown; value?: unknown } }>(
    '/balances/:id/review/resolve',
    async (request) => {
      const { path, value } = request.body ?? {};
      if (typeof path !== 'string' || typeof value !== 'string' || !value.trim()) {
        throw new DrawerError('Send { path, value } for the field to confirm.');
      }
      const balanceId = id(request.params.id);
      resolveBalanceFlag(ctx.db, balanceId, ctx.today(), path, value);
      publishChanged(ctx, [balanceId]);
      return drawer(balanceId);
    },
  );

  api.post<{ Params: { id: string } }>('/balances/:id/review/ready', async (request) => {
    const balanceId = id(request.params.id);
    markReady(ctx.db, balanceId, ctx.today());
    publishChanged(ctx, [balanceId]);
    return drawer(balanceId);
  });
}
