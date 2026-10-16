/**
 * Practice insights (AG Studio): the data the office manager's dashboard is built from, and the
 * bridge between Studio's agent and Claude.
 *
 * Studio's query results are sent to the model, so this data has balance ids and payer names
 * but no patient names; the Still owed widget looks names up itself from /api/balances. Every
 * amount comes from the same computed rows as the grid, converted to dollars only here.
 */
import { inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { StudioTurnRequest } from '@plainbill/ai';
import type { BalanceStatus } from '@plainbill/core';
import type { InsightsData } from '../contract';
import { payments, visits } from '../db/schema';
import { getBalanceRows } from '../queries/rows';
import type { RouteContext } from './context';

export const STATUS_LABEL: Record<BalanceStatus, string> = {
  review: 'Needs review',
  denied: 'Denied',
  ready: 'Ready to invoice',
  sent: 'Sent',
  partial: 'Partially paid',
  paid: 'Paid',
};

const AGING_LABEL = {
  '0-30': '0–30 days',
  '31-60': '31–60 days',
  '61-90': '61–90 days',
  '90+': '90+ days',
} as const;

const dollars = (cents: number | null | undefined) => Math.round(cents ?? 0) / 100;

const METHOD: Record<string, string> = { paypal: 'PayPal', card: 'Card', cash: 'Cash' };

export function insightsData(ctx: Pick<RouteContext, 'db' | 'today'>): InsightsData {
  const rows = getBalanceRows(ctx.db, ctx.today());
  const byId = new Map(rows.map((r) => [r.id, r]));
  const visitDates = new Map(
    ctx.db
      .select({ claimId: visits.claimId, paymentDate: visits.paymentDate })
      .from(visits)
      .all()
      .map((v) => [v.claimId, v.paymentDate]),
  );

  const balances = rows.map((r) => ({
    balanceId: r.id,
    status: STATUS_LABEL[r.status],
    payer: r.payerKind === 'self-pay' ? 'Self-pay' : r.payerShortName,
    provider: r.provider ?? 'Unassigned',
    visitDate: r.visitDate,
    billed: dollars(r.billedCents),
    insuranceDiscount: dollars(r.contractualCents),
    insurancePaid: dollars(r.insurancePaidCents),
    patientShare: dollars(r.patientResponsibilityCents),
    patientPaid: dollars(r.patientPaidCents),
    stillOwed: r.status === 'denied' ? 0 : dollars(r.remainingCents),
    daysOut: r.daysOut ?? 0,
    aging: r.agingBucket ? AGING_LABEL[r.agingBucket] : 'Settled',
    invoiceOpened: r.invoice ? r.invoice.openCount > 0 : false,
    onPlan: r.activePlan?.status === 'active',
    splitVisit: Boolean(r.splitVisit),
  }));

  const paymentRows = rows.length
    ? ctx.db
        .select()
        .from(payments)
        .where(
          inArray(
            payments.balanceId,
            rows.map((r) => r.id),
          ),
        )
        .all()
    : [];
  const paid = paymentRows.map((p) => {
    const r = byId.get(p.balanceId)!;
    return {
      paymentId: p.id,
      balanceId: p.balanceId,
      paidOn: p.postedOn,
      amount: dollars(p.amountCents),
      method: p.planId ? 'Payment plan' : (METHOD[p.method] ?? p.method),
      payer: r.payerKind === 'self-pay' ? 'Self-pay' : r.payerShortName,
    };
  });

  const adjustments = rows.flatMap((r) =>
    r.adjustments
      .filter((a) => (a.kind === 'writeoff' || a.kind === 'patient') && a.amountCents !== null)
      .map((a) => ({
        balanceId: r.id,
        payer: r.payerShortName,
        date: visitDates.get(r.claimId) ?? r.visitDate,
        code: a.code,
        reason: a.label,
        whoPays: a.kind === 'patient' ? ('Patient' as const) : ('Written off' as const),
        amount: dollars(Math.abs(a.amountCents!)),
        denied: r.status === 'denied',
      })),
  );

  return { today: ctx.today(), balances, payments: paid, adjustments };
}

/** Caps agent turns so the page can't be used to run up model costs. */
export class TurnLimiter {
  private hits: number[] = [];
  constructor(
    private readonly max = 300,
    private readonly windowMs = 60 * 60_000,
  ) {}
  allow(now = Date.now()): boolean {
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }
}

function isTurnRequest(body: unknown): body is StudioTurnRequest {
  const b = body as StudioTurnRequest | null;
  return (
    !!b &&
    typeof b === 'object' &&
    Array.isArray(b.input) &&
    (b.tools === undefined || Array.isArray(b.tools)) &&
    (b.instructions === undefined || typeof b.instructions === 'string')
  );
}

export function registerInsightsRoutes(api: FastifyInstance, ctx: RouteContext): void {
  const limiter = new TurnLimiter();

  api.get('/insights/data', async () => insightsData(ctx));

  api.post<{ Body: unknown }>('/studio/llm', async (request, reply) => {
    if (!isTurnRequest(request.body)) {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'Expected an AG Studio turn request.' });
    }
    if (!limiter.allow()) {
      return reply
        .code(429)
        .send({ error: 'rate_limited', message: 'Too many questions this hour. Try again later.' });
    }
    const abort = new AbortController();
    request.raw.on('close', () => {
      if (!reply.raw.writableEnded) abort.abort();
    });
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    for await (const line of ctx.ai.studio.run(request.body, { signal: abort.signal })) {
      if (abort.signal.aborted) break;
      reply.raw.write(`${JSON.stringify(line)}\n`);
    }
    reply.raw.end();
  });
}
