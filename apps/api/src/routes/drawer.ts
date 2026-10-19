/**
 * Review & Send drawer routes. "Send" creates and sends the PayPal invoice, then emails the
 * patient (services/send.ts).
 */
import type { FastifyInstance } from 'fastify';
import { noteLanguage } from '@plainbill/core';
import type {
  DraftMessageResult,
  DrawerData,
  EmailPreview,
  MessageVariant,
  ReminderResult,
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
import { emailPreview, sendBalanceInvoice, sendReminder } from '../services/send';
import { statementFileName, statementPreview } from '../services/statement';
import { renderStatementPdf } from '../services/statement-pdf';
import { refreshSuggestions, type RefreshResult } from '../services/suggestions';
import { publishChanged, type RouteContext } from './context';

const VARIANTS: readonly MessageVariant[] = ['default', 'simpler'];

/** A NOTE_LANGUAGES code, or null when missing; anything else is refused. */
function parseLang(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const lang = noteLanguage(typeof value === 'string' ? value : null);
  if (!lang) throw new DrawerError(`Unknown language ${JSON.stringify(value)}.`);
  return lang.code;
}

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
    | Partial<{
        message: unknown;
        messageSource: unknown;
        messageLang: unknown;
        paymentOption: unknown;
      }>
    | undefined;
  if (typeof b?.message !== 'string' || !b.message.trim())
    throw new DrawerError('The message is empty.');
  const source =
    b.messageSource === 'ai' || b.messageSource === 'template' ? b.messageSource : 'edited';
  return {
    message: b.message,
    messageSource: source,
    messageLang: parseLang(b.messageLang),
    paymentOption: parseOption(b.paymentOption),
  };
}

export function registerDrawerRoutes(api: FastifyInstance, ctx: RouteContext): void {
  const id = (raw: string) => {
    const n = Number(raw);
    if (!Number.isInteger(n)) throw new DrawerError('Balance id must be a number.');
    return n;
  };
  const drawer = (balanceId: number): DrawerData =>
    getDrawerData(ctx.db, balanceId, ctx.today(), {
      available: ctx.ai.available,
      model: ctx.ai.model,
    });

  api.get<{ Params: { id: string } }>('/balances/:id/drawer', async (request) =>
    drawer(id(request.params.id)),
  );

  api.post<{
    Params: { id: string };
    Body: { variant?: unknown; lang?: unknown; paymentOption?: unknown };
  }>('/balances/:id/message', async (request): Promise<DraftMessageResult> => {
    const body = request.body;
    // "spanish" was a variant before any language could be chosen; still accepted.
    const legacySpanish = body?.variant === 'spanish';
    const variant = VARIANTS.find((v) => v === body?.variant) ?? 'default';
    const lang = parseLang(body?.lang) ?? (legacySpanish ? 'es' : 'en');
    const result = await draftMessage(
      ctx.db,
      id(request.params.id),
      ctx.today(),
      ctx.ai.drafter,
      { variant, lang },
      parseOption(body?.paymentOption),
    );
    return {
      text: result.text,
      variant: result.variant,
      lang: result.lang,
      requestedLang: result.requestedLang,
      source: result.source,
      notes: result.notes,
    };
  });

  api.put<{ Params: { id: string } }>('/balances/:id/draft', async (request) => {
    const balanceId = id(request.params.id);
    saveDraft(ctx.db, balanceId, ctx.today(), parseDraft(request.body));
    // The row's detail panel shows the draft's language.
    publishChanged(ctx, [balanceId]);
    return drawer(balanceId);
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

  /** "✦ Refresh suggestions": rewrite the AI suggests column for every open row. */
  api.post('/suggestions/refresh', async (): Promise<RefreshResult> => refreshSuggestions(ctx));

  /** One-click reminder from AI suggests (optionally offering a plan). */
  api.post<{ Params: { id: string }; Body: { offerPlanMonths?: unknown } }>(
    '/balances/:id/remind',
    async (request): Promise<ReminderResult> => {
      const balanceId = id(request.params.id);
      const months = request.body?.offerPlanMonths;
      const result = await sendReminder(ctx, balanceId, {
        ...(months === 3 || months === 6 ? { offerPlanMonths: months } : {}),
      });
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

  /** "Preview statement (PDF)": works before sending, with a placeholder statement ID. */
  api.get<{ Params: { id: string } }>('/balances/:id/statement.pdf', async (request, reply) => {
    const balanceId = id(request.params.id);
    const { model, layout } = statementPreview(
      ctx,
      balanceId,
      drawer(balanceId).draft.paymentOption,
    );
    const { name } = model.input.practice;
    const statementId = model.input.statementId;
    const pdf = await renderStatementPdf(layout, {
      title: `${name} statement ${statementId}`,
      date: model.input.statementDate,
    });
    return reply
      .type('application/pdf')
      .header('cache-control', 'no-store')
      .header('content-disposition', `inline; filename="${statementFileName(name, statementId)}"`)
      .send(Buffer.from(pdf));
  });

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
