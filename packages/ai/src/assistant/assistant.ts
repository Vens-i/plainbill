/**
 * "Ask about your bill" (artboard 1f). Claude answers from BillFacts only and can *propose*
 * payment actions through tools. A proposal is just a card on the page, built by code with
 * code-computed amounts; nothing happens until the patient taps Confirm (and then approves in
 * PayPal). Answers go through the same kind of guard as messages: unknown dollar figures or
 * code-like strings get one retry, then a deterministic answer.
 */
import Anthropic from '@anthropic-ai/sdk';
import { formatMoneyShort, parseDecimalToCents } from '@plainbill/core';
import {
  checkAnswer,
  explainOwes,
  explainSplitVisit,
  factsBlock,
  shortName,
  sourceLine,
  type AnswerIssue,
  type BillFacts,
  type ProposalCard,
} from './facts';

export interface ChatTurn {
  role: 'patient' | 'assistant';
  text: string;
}

export type ProposalInput =
  | { kind: 'pay_in_full' }
  | { kind: 'payment_plan'; months: 3 | 6 }
  | { kind: 'partial_payment'; amountCents: number }
  | { kind: 'phone_call' };

export type ProposalOutcome =
  | {
      ok: true;
      card: ProposalCard;
      summary: string;
      /** Figures shown on the card, which the answer may repeat. */
      amounts?: number[];
    }
  | { ok: false; reason: string };

/** Implemented by the API: validates the request and stores a pending action. */
export interface ProposalHandler {
  propose(input: ProposalInput): Promise<ProposalOutcome>;
}

export interface AssistantReply {
  text: string;
  /** "Based on BlueCross's statement for your Oct 3 visit" */
  source: string;
  cards: ProposalCard[];
  via: 'claude' | 'rules';
  model: string | null;
  notes: string[];
}

export interface AssistantRequest {
  facts: BillFacts;
  history: ChatTurn[];
  message: string;
  handler: ProposalHandler;
  /** The language the patient picked on the page (the notes' language). */
  language?: { code: string; name: string };
}

export interface BillAssistant {
  reply(request: AssistantRequest): Promise<AssistantReply>;
}

// ── Deterministic helper (offline, and the fallback) ───────────────────────

const $ = formatMoneyShort;

/** "call Harborview at (555) 014-2290 (Mon–Fri 8–5)" */
function callUs(f: BillFacts): string {
  return `call ${shortName(f.practice.name)} at ${f.practice.phone}${f.practice.hours ? ` (${f.practice.hours})` : ''}`;
}

/** Keyword rules over the same facts and proposal handler. */
export class RuleBillAssistant implements BillAssistant {
  async reply({ facts: f, message, handler }: AssistantRequest): Promise<AssistantReply> {
    const q = message.toLowerCase();
    const cards: ProposalCard[] = [];
    const propose = async (input: ProposalInput) => {
      const outcome = await handler.propose(input);
      if (outcome.ok) cards.push(outcome.card);
      return outcome.ok;
    };
    let text: string;

    if (/\b(person|human|someone|call|phone|talk|speak)\b/.test(q)) {
      await propose({ kind: 'phone_call' });
      text = `Of course — ${callUs(f)}. They can go over the bill with you.`;
    } else if (/over time|plan|split|install|monthly|afford|smaller|cuotas|plazos/.test(q)) {
      const plan = f.options.plans[0];
      if (plan && (await propose({ kind: 'payment_plan', months: plan.months }))) {
        text =
          plan.firstCents === plan.regularCents
            ? `Yes. ${shortName(f.practice.name)} offers ${plan.months} payments of ${$(plan.regularCents)}, with no interest or fees. The first payment is today through PayPal. Tap Confirm below to set it up.`
            : `Yes. ${shortName(f.practice.name)} offers ${plan.months} monthly payments: ${$(plan.firstCents)} today, then ${$(plan.regularCents)}, with no interest or fees. Tap Confirm below to set it up.`;
      } else if (f.options.partialMinimumCents) {
        text = `You can pay part now (at least ${$(f.options.partialMinimumCents)}) and the rest by the due date. Choose "Pay part now" in the payment section below.`;
      } else {
        await propose({ kind: 'phone_call' });
        text = `This bill is due in full. If that's hard right now, ${callUs(f)} — they can help.`;
      }
    } else if (
      f.splitVisit &&
      /check-?up|physical|preventive|wellness|annual|yearly|free|chequeo|gratis|(second|extra|another|separate) (charge|bill|visit)/.test(
        q,
      )
    ) {
      text = `Good question! ${explainSplitVisit(f)}`;
    } else if (/\b(pay|paypal|card)\b/.test(q) && f.remainingCents > 0) {
      await propose({ kind: 'pay_in_full' });
      text = `You can pay ${$(f.remainingCents)} with PayPal, Pay Later or a card. Tap Confirm below and PayPal will open.`;
    } else if (/right|wrong|mistake|error|correct|too much|overcharg/.test(q)) {
      await propose({ kind: 'phone_call' });
      text = `Here's how it was worked out: ${explainOwes(f)} If something still looks off, ${callUs(f)}.`;
    } else if (/why|how|owe|explain|mean|deductible|coinsurance|copay|discount|allowed/.test(q)) {
      text = `Good question! ${explainOwes(f)}`;
    } else {
      text = `I can help with this bill: why you owe ${$(f.remainingCents)}, what the terms mean, or how to pay. For anything else, ${callUs(f)}.`;
    }
    return { text, source: sourceLine(f), cards, via: 'rules', model: null, notes: [] };
  }
}

// ── Claude ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the billing helper on a small medical practice's bill page. The patient has already verified who they are. Help them understand and pay this one bill.

Answer only from BILL FACTS. Rules:
- Every dollar amount you write must appear in BILL FACTS, written the same way (for example "$240"). Never calculate a new amount. You may show how listed amounts add up (for example "$200 + $40 = $240") when every number is listed.
- If the answer is not in BILL FACTS (coverage questions, appeals, medical questions, anything about other visits), say you don't know and use offer_phone_call so they can reach the office.
- No medical advice. Don't guess whether the bill is wrong; explain how the amount was worked out and offer a call.
- If BILL FACTS show a split visit and the patient asks why their checkup or physical wasn't free (or why there's an extra charge), explain it: the checkup itself was covered in full; another concern discussed during it was billed as its own office visit, and their share comes from that visit. Never guess or name what the concern was.
- Payments: you cannot take payments. To help someone pay, use a propose_ tool: it shows the patient a confirmation card with the exact amounts. Never say a payment was made or a plan was set up; say they can confirm below.
- Plain, warm language, short sentences, under 80 words, written as a chat reply: no markdown, headings or bullet lists. Don't mention procedure codes, adjustment codes or insurance ID numbers.
- Don't describe your tools or your own earlier attempts. When a card is shown, just tell the patient what it offers and that they can confirm it below.
- Reply in the language the patient writes in. Write providers exactly as given (for example "Dr. Kim").`;

/** The page's language, when the patient picked one other than English. */
function languageLine(language: AssistantRequest['language']): string | null {
  if (!language || language.code === 'en') return null;
  return `The patient chose ${language.name} on the page. Answer in ${language.name}, unless they write to you in another language.`;
}

type Tool = Anthropic.Beta.BetaTool;

function tools(f: BillFacts): Tool[] {
  const list: Tool[] = [
    {
      name: 'offer_phone_call',
      description:
        "Show the practice's phone number and hours so the patient can talk to a person. Use when they ask for a person, think the bill is wrong, or ask something BILL FACTS doesn't answer.",
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ];
  if (f.remainingCents > 0 && f.options.payInFull) {
    list.push({
      name: 'propose_pay_in_full',
      description:
        'Show a card to pay the full remaining balance with PayPal (PayPal, Pay Later or card). Nothing is charged until the patient confirms and approves in PayPal.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
    });
  }
  if (f.remainingCents > 0 && f.options.plans.length) {
    list.push({
      name: 'propose_payment_plan',
      description:
        'Show a card to start one of the interest-free payment plans listed in BILL FACTS (first payment today through PayPal). Nothing is charged until the patient confirms and approves in PayPal.',
      input_schema: {
        type: 'object',
        properties: {
          months: {
            type: 'integer',
            enum: f.options.plans.map((p) => p.months),
            description: 'Number of monthly payments.',
          },
        },
        required: ['months'],
        additionalProperties: false,
      },
    });
  }
  if (f.remainingCents > 0 && f.options.partialMinimumCents) {
    list.push({
      name: 'propose_partial_payment',
      description:
        'Show a card to pay part of the balance now, when the patient names an amount. Use the amount exactly as the patient said it.',
      input_schema: {
        type: 'object',
        properties: {
          amount: {
            type: 'string',
            description: 'Dollar amount the patient asked to pay, e.g. "50" or "75.50".',
          },
        },
        required: ['amount'],
        additionalProperties: false,
      },
    });
  }
  return list;
}

function toProposal(name: string, input: Record<string, unknown>): ProposalInput | string {
  switch (name) {
    case 'offer_phone_call':
      return { kind: 'phone_call' };
    case 'propose_pay_in_full':
      return { kind: 'pay_in_full' };
    case 'propose_payment_plan':
      return input.months === 3 || input.months === 6
        ? { kind: 'payment_plan', months: input.months }
        : 'months must be 3 or 6';
    case 'propose_partial_payment': {
      const raw = String(input.amount ?? '')
        .replace(/[$,\s]/g, '')
        .trim();
      try {
        return { kind: 'partial_payment', amountCents: parseDecimalToCents(raw) };
      } catch {
        return `"${String(input.amount)}" is not an amount`;
      }
    }
    default:
      return `unknown tool ${name}`;
  }
}

const MAX_HISTORY = 8;
const MAX_TURN_CHARS = 600;

export interface ClaudeBillAssistantOptions {
  client: Anthropic;
  model: string;
  fallback?: BillAssistant;
}

export class ClaudeBillAssistant implements BillAssistant {
  private readonly fallback: BillAssistant;

  constructor(private readonly options: ClaudeBillAssistantOptions) {
    this.fallback = options.fallback ?? new RuleBillAssistant();
  }

  /** One conversation pass: tool calls are answered by the handler, up to a few rounds. */
  private async converse(
    request: AssistantRequest,
    issues: AnswerIssue[],
  ): Promise<{ text: string | null; cards: ProposalCard[]; extraAmounts: number[] }> {
    const { facts, history, message } = request;
    const language = languageLine(request.language);
    const cards: ProposalCard[] = [];
    const extraAmounts: number[] = [];
    const turns: Anthropic.Beta.BetaMessageParam[] = history
      .slice(-MAX_HISTORY)
      .map((t) => ({
        role: t.role === 'patient' ? ('user' as const) : ('assistant' as const),
        content: t.text.slice(0, MAX_TURN_CHARS),
      }))
      // The API needs the conversation to start with the patient.
      .filter((_, i, all) => !(i === 0 && all[0]!.role === 'assistant'));
    const correction = issues.length
      ? `\n\n(Note for your reply, not to be mentioned: ${issues.map((i) => i.detail).join(' ')} Use only the figures in BILL FACTS.)`
      : '';
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      ...turns,
      { role: 'user', content: `${message.slice(0, MAX_TURN_CHARS)}${correction}` },
    ];

    for (let round = 0; round < 4; round++) {
      const response = await this.options.client.beta.messages.create({
        model: this.options.model,
        max_tokens: 1500,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low' },
        system: [
          { type: 'text', text: SYSTEM_PROMPT },
          { type: 'text', text: `BILL FACTS\n${factsBlock(facts)}` },
          ...(language ? [{ type: 'text' as const, text: language }] : []),
        ],
        tools: tools(facts),
        messages,
      });
      if (response.stop_reason === 'refusal') return { text: null, cards, extraAmounts };
      const toolUses = response.content.filter(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use',
      );
      if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
        const text = response.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim();
        return { text: text || null, cards, extraAmounts };
      }
      messages.push({ role: 'assistant', content: response.content });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const proposal = toProposal(use.name, (use.input ?? {}) as Record<string, unknown>);
        if (typeof proposal === 'string') {
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: proposal,
            is_error: true,
          });
          continue;
        }
        const outcome = await request.handler.propose(proposal);
        if (outcome.ok) {
          cards.push(outcome.card);
          extraAmounts.push(...(outcome.amounts ?? []));
          results.push({ type: 'tool_result', tool_use_id: use.id, content: outcome.summary });
        } else {
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: outcome.reason,
            is_error: true,
          });
        }
      }
      messages.push({ role: 'user', content: results });
    }
    return { text: null, cards, extraAmounts };
  }

  async reply(request: AssistantRequest): Promise<AssistantReply> {
    const notes: string[] = [];
    let issues: AnswerIssue[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      let pass;
      try {
        pass = await this.converse(request, issues);
      } catch (err) {
        notes.push(
          `AI unavailable (${err instanceof Anthropic.APIError ? `HTTP ${err.status}` : (err as Error).message}).`,
        );
        break;
      }
      if (pass.text === null) {
        notes.push('The model did not answer.');
        break;
      }
      issues = checkAnswer(pass.text, request.facts, pass.extraAmounts);
      if (issues.length === 0) {
        return {
          text: pass.text,
          source: sourceLine(request.facts),
          cards: dedupeCards(pass.cards),
          via: 'claude',
          model: this.options.model,
          notes,
        };
      }
      notes.push(`Answer ${attempt + 1} rejected: ${issues.map((i) => i.detail).join(' ')}`);
    }
    const fallback = await this.fallback.reply(request);
    return { ...fallback, notes: [...notes, ...fallback.notes] };
  }
}

/** Drop repeated cards (a retried tool call), keeping distinct offers such as 3- and 6-month plans. */
function dedupeCards(cards: ProposalCard[]): ProposalCard[] {
  const seen = new Map<string, ProposalCard>();
  for (const c of cards) seen.set(`${c.kind}:${c.title}`, c);
  return [...seen.values()];
}
