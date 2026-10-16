/**
 * Margin notes for the itemized statement ("Your statement, explained"). Claude writes one short
 * note per anchor, in the patient's language, from facts the core computed; code decides where
 * each note goes and what every number is. The guard checks every note; one retry with the
 * problems spelled out, then the template takes over note by note (English when the language
 * has no template).
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod/v4';
import {
  formatMoney,
  formatMoneyShort,
  formatMonthDay,
  type StatementNoteText,
} from '@plainbill/core';
import type { AnnotateFacts } from './facts';
import { checkNotes, type NoteDraft, type NoteIssue } from './guard';

export interface AnnotateResult {
  /** One note per anchor, in anchor order. */
  notes: StatementNoteText[];
  source: 'ai' | 'template' | 'mixed';
  /** True when some notes are English because the language had no template to fall back to. */
  fallback: boolean;
  model: string | null;
  /** Why notes fell back, if any did. */
  diagnostics: string[];
}

export interface StatementAnnotator {
  annotate(facts: AnnotateFacts): Promise<AnnotateResult>;
}

/** Template notes in the requested language, or English (flagged) when there is none. */
function templateNotes(facts: AnnotateFacts): { notes: StatementNoteText[]; fallback: boolean } {
  const code = facts.language.code;
  if (code === 'es') return { notes: facts.templates.es, fallback: false };
  return { notes: facts.templates.en, fallback: code !== 'en' };
}

export class TemplateStatementAnnotator implements StatementAnnotator {
  async annotate(facts: AnnotateFacts): Promise<AnnotateResult> {
    const { notes, fallback } = templateNotes(facts);
    return { notes, source: 'template', fallback, model: null, diagnostics: [] };
  }
}

const SYSTEM_PROMPT = `You write the short notes in the margins of a medical practice's itemized patient statement. The patient has verified who they are and is looking at their own bill. Each note points at one printed line and explains it.

Voice: a kind front-desk person. Reading level grade 5–6: short sentences, everyday words.

For every LINE, write exactly one note with:
- title: at most 5 words.
- body: at most 35 words.

Rules:
- Use only the figures listed for that line, written like "$240" or "$240.00". Never calculate, add or invent a figure.
- No procedure codes, adjustment codes, diagnoses or insurance ID numbers in the text (the patient sees the printed line separately).
- Write providers exactly as given (for example "Dr. Patel"); don't change the title or guess their gender.
- Never guess or name what a health concern was; the bill doesn't say.
- The MEANING of each line is a correct English explanation; keep to it. If you are unsure what a line means, write "Call the office to check this line." instead of guessing.
- Plain text only: no markdown, no emoji.`;

const $ = formatMoneyShort;

function factsBlock(f: AnnotateFacts): string {
  const lines = [
    `Patient first name: ${f.patientFirstName}`,
    `Practice: ${f.practiceName}, phone ${f.practicePhone}`,
    `Provider: ${f.providerName ?? 'not named'}`,
    `Visit date: ${formatMonthDay(f.visitDate)}`,
    f.selfPay ? 'Insurance: none (self-pay)' : `Insurance plan: ${f.payerShortName}`,
    `Patient owes now: ${formatMoney(f.owesCents)}`,
  ];
  return lines.join('\n');
}

function linesBlock(f: AnnotateFacts): string {
  const reference = new Map(f.templates.en.map((n) => [n.anchorId, n]));
  return f.anchors
    .map((a) => {
      const ref = reference.get(a.id);
      const figures = [...new Set([...a.amountsCents, f.owesCents])]
        .map((c) => `${$(c)} (or ${formatMoney(c)})`)
        .join(', ');
      return [
        `- id: ${a.id}`,
        `  printed line: ${a.quote}`,
        `  figures you may use: ${figures}`,
        ...(ref ? [`  MEANING: ${ref.title}. ${ref.body}`] : []),
      ].join('\n');
    })
    .join('\n');
}

export interface ClaudeStatementAnnotatorOptions {
  client: Anthropic;
  model: string;
}

export class ClaudeStatementAnnotator implements StatementAnnotator {
  constructor(private readonly options: ClaudeStatementAnnotatorOptions) {}

  private async ask(facts: AnnotateFacts, issues: NoteIssue[]): Promise<NoteDraft[] | null> {
    const ids = facts.anchors.map((a) => a.id) as [string, ...string[]];
    const schema = z.object({
      notes: z.array(
        z.object({
          anchorId: z.enum(ids),
          title: z.string().describe('At most 5 words.'),
          body: z.string().describe('At most 35 words.'),
        }),
      ),
    });
    const correction = issues.length
      ? `\n\nYour previous notes had problems; fix them:\n${issues.map((i) => `- ${i.detail}`).join('\n')}`
      : '';
    const response = await this.options.client.beta.messages.parse({
      model: this.options.model,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: betaZodOutputFormat(schema) },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `FACTS\n${factsBlock(facts)}\n\nLINES (in note order)\n${linesBlock(facts)}\n\nWrite one note per line, in ${facts.language.name}.${correction}`,
        },
      ],
    });
    if (response.stop_reason === 'refusal') return null;
    return response.parsed_output?.notes ?? null;
  }

  async annotate(facts: AnnotateFacts): Promise<AnnotateResult> {
    const diagnostics: string[] = [];
    let drafts: NoteDraft[] | null = null;
    let issues: NoteIssue[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        drafts = await this.ask(facts, issues);
      } catch (err) {
        diagnostics.push(
          `AI unavailable (${err instanceof Anthropic.APIError ? `HTTP ${err.status}` : (err as Error).message}).`,
        );
        drafts = null;
        break;
      }
      if (!drafts) {
        diagnostics.push('The model declined to write the notes.');
        break;
      }
      issues = checkNotes(drafts, facts);
      if (issues.length === 0) break;
      diagnostics.push(`Notes ${attempt + 1} rejected: ${issues.map((i) => i.detail).join(' ')}`);
    }

    const template = templateNotes(facts);
    if (!drafts) {
      return {
        notes: template.notes,
        source: 'template',
        fallback: template.fallback,
        model: null,
        diagnostics,
      };
    }
    // Keep each note that passed; replace the rest with the template note for that line.
    const failed = new Set(issues.map((i) => i.anchorId));
    let fromAi = 0;
    const notes = facts.anchors.map((anchor) => {
      const draft = drafts!.find((d) => d.anchorId === anchor.id);
      if (draft && !failed.has(anchor.id)) {
        fromAi++;
        return { anchorId: anchor.id, title: draft.title.trim(), body: draft.body.trim() };
      }
      return template.notes.find((n) => n.anchorId === anchor.id)!;
    });
    const all = fromAi === facts.anchors.length;
    return {
      notes,
      source: all ? 'ai' : fromAi === 0 ? 'template' : 'mixed',
      fallback: !all && template.fallback,
      model: fromAi ? this.options.model : null,
      diagnostics,
    };
  }
}
