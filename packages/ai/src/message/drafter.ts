/**
 * Patient message drafting. Claude writes from MessageFacts only; the guard rejects any draft
 * that mentions a figure the core didn't compute (or a medical code). One retry with the
 * problems spelled out, then the deterministic template takes over.
 */
import Anthropic from '@anthropic-ai/sdk';
import { formatMoney, formatMonthDay } from '@plainbill/core';
import type { MessageFacts, MessageVariant } from './facts';
import { checkMessage, type GuardIssue } from './guard';
import { templateMessage } from './template';

export interface DraftResult {
  text: string;
  variant: MessageVariant;
  source: 'ai' | 'template';
  model: string | null;
  /** Why the template was used, if it was. */
  notes: string[];
}

export interface MessageDrafter {
  draft(facts: MessageFacts, variant: MessageVariant): Promise<DraftResult>;
}

export class TemplateMessageDrafter implements MessageDrafter {
  async draft(facts: MessageFacts, variant: MessageVariant): Promise<DraftResult> {
    return {
      text: templateMessage(facts, variant),
      variant,
      source: 'template',
      model: null,
      notes: [],
    };
  }
}

const SYSTEM_PROMPT = `You write short billing messages from a small medical practice to its patients.

Write warmly and plainly, like a kind front-desk person. Explain why the patient owes what they owe, using only the figures in FACTS, written exactly as given (for example "$240"). Never calculate a new figure, and never mention a dollar amount that is not in FACTS.

Privacy rules: mention only the visit date, the provider's name and the amounts. Do not mention services, tests, diagnoses, procedure codes or insurance ID numbers.

Reply with the message text only: no subject line, no sign-off, no placeholders. Keep it under 90 words.`;

const VARIANT_INSTRUCTIONS: Record<MessageVariant, string> = {
  default: 'Write the message in English.',
  simpler:
    'Write the message in very simple English: short sentences, everyday words, under 50 words.',
  spanish: 'Write the message in warm, natural Spanish (Latin American), with the same rules.',
};

function factsBlock(f: MessageFacts): string {
  const $ = (c: number) => formatMoney(c).replace('.00', '');
  const lines = [
    `Patient first name: ${f.patientFirstName}`,
    `Practice: ${f.practiceName}`,
    `Provider: ${f.providerName ?? 'not named'}`,
    `Visit date: ${formatMonthDay(f.visitDate)}`,
    f.selfPay ? 'Insurance: none (self-pay rate)' : `Insurance plan: ${f.payerShortName}`,
    `Billed: ${$(f.billedCents)}`,
  ];
  if (!f.selfPay) {
    lines.push(
      `Insurance discount (contract rate): ${$(f.discountCents)}`,
      `Amount the plan allowed: ${$(f.billedCents - f.discountCents)}`,
      `Insurance paid: ${$(f.insurancePaidCents)}`,
    );
    if (f.deductibleCents)
      lines.push(
        `Of what the patient owes, toward their yearly deductible: ${$(f.deductibleCents)}`,
      );
    if (f.coinsuranceCents)
      lines.push(
        `Of what the patient owes, coinsurance (their share of the cost): ${$(f.coinsuranceCents)}`,
      );
    if (f.copayCents) lines.push(`Of what the patient owes, copay: ${$(f.copayCents)}`);
    if (f.otherPatientCents)
      lines.push(`Of what the patient owes, not covered by the plan: ${$(f.otherPatientCents)}`);
  }
  lines.push(`Patient owes: ${$(f.owesCents)}`);
  if (f.plan) {
    lines.push(
      f.plan.firstCents === f.plan.regularCents
        ? `Payment plan offered: ${f.plan.months} payments of ${$(f.plan.regularCents)}, no interest or fees`
        : `Payment plan offered: ${f.plan.months} payments, first ${$(f.plan.firstCents)} then ${$(f.plan.regularCents)} a month, no interest or fees`,
    );
  }
  if (f.partialMinimumCents)
    lines.push(`Partial payments allowed, minimum ${$(f.partialMinimumCents)}`);
  return lines.join('\n');
}

export interface ClaudeMessageDrafterOptions {
  client: Anthropic;
  model: string;
}

export class ClaudeMessageDrafter implements MessageDrafter {
  constructor(private readonly options: ClaudeMessageDrafterOptions) {}

  private async ask(
    facts: MessageFacts,
    variant: MessageVariant,
    issues: GuardIssue[],
  ): Promise<string | null> {
    const correction = issues.length
      ? `\n\nYour previous draft had problems; fix them:\n${issues.map((i) => `- ${i.detail}`).join('\n')}`
      : '';
    const response = await this.options.client.beta.messages.create({
      model: this.options.model,
      max_tokens: 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `FACTS\n${factsBlock(facts)}\n\n${VARIANT_INSTRUCTIONS[variant]}${correction}`,
        },
      ],
    });
    if (response.stop_reason === 'refusal') return null;
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return text || null;
  }

  async draft(facts: MessageFacts, variant: MessageVariant): Promise<DraftResult> {
    const notes: string[] = [];
    let issues: GuardIssue[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      let text: string | null;
      try {
        text = await this.ask(facts, variant, issues);
      } catch (err) {
        notes.push(
          `AI unavailable (${err instanceof Anthropic.APIError ? `HTTP ${err.status}` : (err as Error).message}).`,
        );
        break;
      }
      if (text === null) {
        notes.push('The model declined to write this message.');
        break;
      }
      issues = checkMessage(text, facts);
      if (issues.length === 0) {
        return { text, variant, source: 'ai', model: this.options.model, notes };
      }
      notes.push(`Draft ${attempt + 1} rejected: ${issues.map((i) => i.detail).join(' ')}`);
    }
    return {
      text: templateMessage(facts, variant),
      variant,
      source: 'template',
      model: null,
      notes,
    };
  }
}
