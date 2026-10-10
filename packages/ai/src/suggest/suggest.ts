/**
 * "AI suggests": one next action per balance on the staff dashboard.
 *
 * Claude picks an action from a fixed list and writes a short label (structured output). Code
 * checks every suggestion: the action must fit the row's status, the label must be short and
 * may only mention the row's own figures. Anything that fails falls back to the rule for that
 * row, so the column is never empty or wrong.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod/v4';
import { formatMoneyShort } from '@plainbill/core';
import { findAmounts } from '../message/guard';

export const SUGGESTION_ACTIONS = [
  'confirm_field',
  'check_duplicate',
  'apply_self_pay_rate',
  'review',
  'send_invoice',
  'send_invoice_with_plan',
  'send_reminder',
  'offer_plan',
  'resubmit_with_auth',
  'add_referral_resubmit',
  'resubmit',
  /** Nothing to do (a plan is running). */
  'none',
] as const;
export type SuggestionAction = (typeof SUGGESTION_ACTIONS)[number];

/** Which actions make sense for each status. */
const ALLOWED: Record<string, readonly SuggestionAction[]> = {
  review: ['confirm_field', 'check_duplicate', 'apply_self_pay_rate', 'review'],
  ready: ['send_invoice', 'send_invoice_with_plan'],
  sent: ['send_reminder', 'offer_plan', 'none'],
  partial: ['send_reminder', 'offer_plan', 'none'],
  denied: ['resubmit_with_auth', 'add_referral_resubmit', 'resubmit'],
};

/** What the suggester knows about a row: status, timing and amounts, no names. */
export interface RowSituation {
  id: number;
  status: 'review' | 'ready' | 'sent' | 'partial' | 'denied';
  selfPay: boolean;
  daysSinceVisit: number;
  owesCents: number;
  paidCents: number;
  /** "Confirm insurance paid amount", "Possible duplicate", "Apply self-pay rate". */
  reviewReason: string | null;
  /** "CO-197 prior auth missing" */
  denialReason: string | null;
  invoice: { daysSinceSent: number; openCount: number } | null;
  /** Interest-free plans this balance qualifies for. */
  plans: Array<{ months: 3 | 6; regularCents: number }>;
  activePlan: boolean;
}

export interface Suggestion {
  id: number;
  action: SuggestionAction;
  label: string;
}

export interface SuggestionBatch {
  suggestions: Suggestion[];
  via: 'claude' | 'rules';
  model: string | null;
  notes: string[];
}

export interface Suggester {
  suggest(rows: RowSituation[]): Promise<SuggestionBatch>;
}

const $ = formatMoneyShort;

/** The deterministic suggestion for one row (also the fallback for Claude's). */
export function ruleSuggestion(r: RowSituation): Suggestion {
  const plan3 = r.plans.find((p) => p.months === 3);
  const plan6 = r.plans.find((p) => p.months === 6);
  const s = (action: SuggestionAction, label: string): Suggestion => ({ id: r.id, action, label });
  switch (r.status) {
    case 'review': {
      const reason = r.reviewReason ?? '';
      if (/duplicate/i.test(reason)) return s('check_duplicate', 'Possible duplicate — compare');
      if (/self-pay rate/i.test(reason)) return s('apply_self_pay_rate', 'Apply self-pay rate');
      if (/paid/i.test(reason)) return s('confirm_field', 'Confirm insurance paid amount');
      if (/copay|coinsurance|code/i.test(reason))
        return s('confirm_field', 'Check copay vs. coinsurance');
      return s('review', 'Review and confirm');
    }
    case 'ready':
      // Self-pay prices are already discounted; plans stay available if the patient asks.
      return !r.selfPay && r.owesCents >= 20000 && plan3
        ? s('send_invoice_with_plan', 'Send invoice + 3-month plan')
        : s('send_invoice', 'Send invoice');
    case 'sent':
    case 'partial': {
      if (r.activePlan) return s('none', 'Plan on track');
      if (r.invoice && r.invoice.daysSinceSent < 7) return s('none', 'Sent recently');
      if (r.status === 'partial' && plan6) {
        return s('offer_plan', `Offer 6-month plan · ${$(plan6.regularCents)}/mo`);
      }
      if (r.invoice && r.invoice.openCount === 0 && r.invoice.daysSinceSent >= 14 && plan3) {
        return s('offer_plan', 'Offer 3-month plan');
      }
      return s('send_reminder', 'Send friendly reminder');
    }
    case 'denied': {
      const reason = r.denialReason ?? '';
      if (/CO-197|prior auth/i.test(reason))
        return s('resubmit_with_auth', 'Resubmit with auth number');
      if (/CO-16|referral/i.test(reason))
        return s('add_referral_resubmit', 'Add referral & resubmit');
      return s('resubmit', 'Fix & resubmit');
    }
  }
}

export class RuleSuggester implements Suggester {
  async suggest(rows: RowSituation[]): Promise<SuggestionBatch> {
    return { suggestions: rows.map(ruleSuggestion), via: 'rules', model: null, notes: [] };
  }
}

const MAX_LABEL = 40;

/** The action behind a label, for rows whose suggestion predates stored actions (the seed). */
export function inferAction(status: string, label: string): SuggestionAction | null {
  switch (status) {
    case 'review':
      return /duplicate/i.test(label)
        ? 'check_duplicate'
        : /self-pay/i.test(label)
          ? 'apply_self_pay_rate'
          : 'confirm_field';
    case 'ready':
      return /plan/i.test(label) ? 'send_invoice_with_plan' : 'send_invoice';
    case 'sent':
    case 'partial':
      return /on track|no action|reminder sent/i.test(label)
        ? 'none'
        : /plan/i.test(label)
          ? 'offer_plan'
          : 'send_reminder';
    case 'denied':
      return /auth/i.test(label)
        ? 'resubmit_with_auth'
        : /referral/i.test(label)
          ? 'add_referral_resubmit'
          : 'resubmit';
    default:
      return null;
  }
}

/** Why a model suggestion can't be used for this row, or null if it's fine. */
export function checkSuggestion(s: Suggestion, row: RowSituation): string | null {
  if (!ALLOWED[row.status]?.includes(s.action))
    return `"${s.action}" doesn't fit a ${row.status} row`;
  const label = s.label.trim();
  if (!label || label.length > MAX_LABEL) return `label must be 1–${MAX_LABEL} characters`;
  const figures = new Set([row.owesCents, row.paidCents, ...row.plans.map((p) => p.regularCents)]);
  for (const amount of findAmounts(label)) {
    if (!figures.has(amount)) return `${$(amount)} is not one of this row's figures`;
  }
  if (s.action === 'none' && !row.activePlan && !(row.invoice && row.invoice.daysSinceSent < 7)) {
    return 'an open bill a week or more old needs a next step';
  }
  if ((s.action === 'offer_plan' || s.action === 'send_invoice_with_plan') && !row.plans.length) {
    return 'this balance is too small for a plan';
  }
  return null;
}

const OutputSchema = z.object({
  suggestions: z.array(
    z.object({
      id: z.number().int(),
      action: z.enum(SUGGESTION_ACTIONS),
      label: z
        .string()
        .describe('Under 40 characters, plain words, imperative ("Send friendly reminder").'),
    }),
  ),
});

const SYSTEM_PROMPT = `You help the front desk of a small medical practice decide the single next action for each patient balance.

For every row in ROWS, return exactly one suggestion with its id, an action from the allowed list for that row's status, and a short label (under 40 characters, plain words, starting with a verb, like "Send friendly reminder" or "Resubmit with auth number").

Allowed actions by status:
- review: confirm_field (an AI-read field needs a human check), check_duplicate, apply_self_pay_rate, review
- ready: send_invoice, send_invoice_with_plan (only when a plan is listed for the row and the balance is $200 or more)
- sent / partial: send_reminder, offer_plan (only when a plan is listed), none (only when a plan is already running or the bill went out less than 7 days ago)
- denied: resubmit_with_auth (prior authorization missing), add_referral_resubmit (referral missing), resubmit

For review rows, say what to check in the same terms as reviewReason (for example "Check copay vs. coinsurance" when the question is copay or coinsurance). Guidance: a bill opened but unpaid for a week or more deserves a friendly reminder; a bill not opened for two weeks or more may do better with a plan offer; a partly paid balance can be offered a 6-month plan. A row with a plan already running needs no chasing. Only mention dollar amounts that appear in that row. Never invent facts.`;

export class ClaudeSuggester implements Suggester {
  constructor(private readonly options: { client: Anthropic; model: string }) {}

  async suggest(rows: RowSituation[]): Promise<SuggestionBatch> {
    const notes: string[] = [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const fallback = (reason: string): SuggestionBatch => ({
      suggestions: rows.map(ruleSuggestion),
      via: 'rules',
      model: null,
      notes: [...notes, reason],
    });
    if (!rows.length) return { suggestions: [], via: 'claude', model: this.options.model, notes };

    let parsed: z.infer<typeof OutputSchema> | null;
    try {
      const response = await this.options.client.beta.messages.parse({
        model: this.options.model,
        max_tokens: 4000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low', format: betaZodOutputFormat(OutputSchema) },
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `ROWS\n${JSON.stringify(rows.map(compact))}` }],
      });
      parsed = response.parsed_output ?? null;
    } catch (err) {
      return fallback(
        `AI unavailable (${err instanceof Anthropic.APIError ? `HTTP ${err.status}` : (err as Error).message}).`,
      );
    }
    if (!parsed) return fallback('The model returned no suggestions.');

    const out: Suggestion[] = [];
    for (const row of rows) {
      const s = parsed.suggestions.find((x) => x.id === row.id);
      const problem = s ? checkSuggestion(s, byId.get(row.id)!) : 'missing';
      if (s && !problem) out.push({ id: row.id, action: s.action, label: s.label.trim() });
      else {
        notes.push(`Row ${row.id}: ${problem}; used the rule instead.`);
        out.push(ruleSuggestion(row));
      }
    }
    return { suggestions: out, via: 'claude', model: this.options.model, notes };
  }
}

/** Dollars instead of cents, so the model reads amounts the way it will write them. */
function compact(r: RowSituation) {
  return {
    id: r.id,
    status: r.status,
    selfPay: r.selfPay,
    daysSinceVisit: r.daysSinceVisit,
    owes: $(r.owesCents),
    ...(r.paidCents ? { paidSoFar: $(r.paidCents) } : {}),
    ...(r.reviewReason ? { reviewReason: r.reviewReason } : {}),
    ...(r.denialReason ? { denialReason: r.denialReason } : {}),
    ...(r.invoice ? { invoice: r.invoice } : {}),
    plans: r.plans.map((p) => `${p.months} × ${$(p.regularCents)}`),
    ...(r.activePlan ? { planRunning: true } : {}),
  };
}
