/**
 * EOB extractors. `ClaudeEobExtractor` reads a PDF with Claude (structured output, per-field
 * confidence). `RecordedEobExtractor` replays saved extractions keyed by the PDF's SHA-256, so
 * seeding and tests stay offline and deterministic; `pnpm ai:record` refreshes the recordings.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { EobExtractionSchema, type EobExtraction } from './schema';

export interface EobExtractor {
  readonly name: string;
  extract(pdf: Uint8Array, fileName: string): Promise<EobExtraction>;
}

export class AiExtractionError extends Error {
  override name = 'AiExtractionError';
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const SYSTEM_PROMPT = `You transcribe Explanation of Benefits (EOB) documents for a medical practice's billing staff.

Transcribe exactly what is printed. Do not calculate, infer, or correct any figure: if a printed total looks inconsistent with the lines, transcribe it anyway. The practice's own software does all the arithmetic and will catch inconsistencies.

Rate every field. Scans are often blurry, skewed or smudged. When a character could be read more than one way, give your best reading as \`value\`, list the other readings in \`alternatives\`, lower \`confidence\` accordingly, and say what is unclear in \`note\`. A field you can read cleanly should have high confidence, no alternatives, and a null note. Never invent a value that is not on the page: use null where the schema allows it.`;

export interface ClaudeEobExtractorOptions {
  client: Anthropic;
  model: string;
}

export class ClaudeEobExtractor implements EobExtractor {
  readonly name = 'claude';

  constructor(private readonly options: ClaudeEobExtractorOptions) {}

  async extract(pdf: Uint8Array, fileName: string): Promise<EobExtraction> {
    const response = await this.options.client.beta.messages.parse({
      model: this.options.model,
      max_tokens: 16000,
      // Re-run on Anthropic's recommended fallback model if a safety classifier declines.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'high', format: betaZodOutputFormat(EobExtractionSchema) },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: Buffer.from(pdf).toString('base64'),
              },
            },
            { type: 'text', text: `Transcribe this EOB (file: ${fileName}).` },
          ],
        },
      ],
    });

    if (response.stop_reason === 'refusal') {
      throw new AiExtractionError(`The model declined to read ${fileName}.`);
    }
    if (response.stop_reason === 'max_tokens') {
      throw new AiExtractionError(`The extraction of ${fileName} was cut off (max_tokens).`);
    }
    if (!response.parsed_output) {
      throw new AiExtractionError(
        `The model's answer for ${fileName} did not match the extraction schema.`,
      );
    }
    return response.parsed_output;
  }
}

export interface EobRecording {
  fileName: string;
  sha256: string;
  model: string;
  recordedAt: string;
  extraction: EobExtraction;
}

export class RecordedEobExtractor implements EobExtractor {
  readonly name = 'recorded';

  constructor(private readonly directory: string) {}

  path(pdf: Uint8Array): string {
    return join(this.directory, `${sha256(pdf)}.json`);
  }

  has(pdf: Uint8Array): boolean {
    return existsSync(this.path(pdf));
  }

  async extract(pdf: Uint8Array, fileName: string): Promise<EobExtraction> {
    const file = this.path(pdf);
    if (!existsSync(file)) {
      throw new AiExtractionError(
        `No recorded extraction for ${fileName}. Set ANTHROPIC_API_KEY to read new EOBs live, or run \`pnpm ai:record\`.`,
      );
    }
    const recording = JSON.parse(readFileSync(file, 'utf8')) as EobRecording;
    return EobExtractionSchema.parse(recording.extraction);
  }
}

/** Prefer a recording when one exists (seed files), otherwise read live. */
export class RecordedThenLiveExtractor implements EobExtractor {
  readonly name = 'recorded-then-live';

  constructor(
    private readonly recorded: RecordedEobExtractor,
    private readonly live: EobExtractor | null,
  ) {}

  extract(pdf: Uint8Array, fileName: string): Promise<EobExtraction> {
    if (this.recorded.has(pdf) || !this.live) return this.recorded.extract(pdf, fileName);
    return this.live.extract(pdf, fileName);
  }
}
