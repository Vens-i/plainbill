/**
 * "AI suggests" on the staff dashboard: refresh every open row's next action (Claude, checked
 * row by row, or the rules), and the reminder the sent/partial rows' one-click button sends.
 */
import { eq } from 'drizzle-orm';
import type { RowSituation } from '@plainbill/ai';
import { daysBetween, PLAN_MONTHS, planOption, type IsoDate } from '@plainbill/core';
import type { BalanceRow } from '../contract';
import { balances } from '../db/schema';
import { getBalanceRows } from '../queries/rows';
import { publishChanged, type RouteContext } from '../routes/context';

type Ctx = Pick<RouteContext, 'db' | 'bus' | 'today' | 'ai' | 'log'>;

export function rowSituation(r: BalanceRow, today: IsoDate): RowSituation | null {
  if (r.status === 'paid') return null;
  return {
    id: r.id,
    status: r.status,
    selfPay: r.payerKind === 'self-pay',
    daysSinceVisit: daysBetween(r.visitDate, today),
    owesCents: r.remainingCents,
    paidCents: r.patientPaidCents,
    reviewReason: r.reviewReason,
    denialReason: r.denialReason,
    invoice:
      r.invoice?.sentOn && (r.status === 'sent' || r.status === 'partial')
        ? { daysSinceSent: daysBetween(r.invoice.sentOn, today), openCount: r.invoice.openCount }
        : null,
    plans:
      r.status === 'denied'
        ? []
        : PLAN_MONTHS.map((m) => planOption(r.remainingCents, m))
            .filter((p) => p.eligible)
            .map((p) => ({ months: p.months, regularCents: p.regularCents })),
    activePlan: r.activePlan?.status === 'active',
  };
}

export interface RefreshResult {
  via: 'claude' | 'rules';
  model: string | null;
  updated: number;
}

export async function refreshSuggestions(ctx: Ctx): Promise<RefreshResult> {
  const today = ctx.today();
  const rows = getBalanceRows(ctx.db, today)
    .map((r) => rowSituation(r, today))
    .filter((r): r is RowSituation => r !== null);
  const batch = await ctx.ai.suggester.suggest(rows);
  if (batch.notes.length) ctx.log.info(`AI suggests notes: ${batch.notes.join(' | ')}`);
  const now = new Date().toISOString();
  ctx.db.transaction((tx) => {
    for (const s of batch.suggestions) {
      tx.update(balances)
        .set({
          aiSuggestion: s.action === 'none' && !s.label ? null : s.label,
          aiAction: s.action,
          aiSuggestionBy: batch.via,
          updatedAt: now,
        })
        .where(eq(balances.id, s.id))
        .run();
    }
  });
  publishChanged(
    ctx,
    batch.suggestions.map((s) => s.id),
  );
  return { via: batch.via, model: batch.model, updated: batch.suggestions.length };
}
