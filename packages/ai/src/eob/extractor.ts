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
import {
  EobModelOutputSchema,
  toExtraction,
  type EobExtraction,
  type EobModelOutput,
} from './schema';

export interface EobExtractor {
  readonly name: string;
  /** Returns the per-field extraction plus the raw model output it came from. */
  extract(
    pdf: Uint8Array,
    fileName: string,
  ): Promise<{ extraction: EobExtraction; raw: EobModelOutput }>;
}

export class AiExtractionError extends Error {
  override name = 'AiExtractionError';
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const SYSTEM_PROMPT = `You transcribe Explanation of Benefits (EOB) documents for a medical practice's billing staff.

Transcribe exactly what is printed. Do not calculate, infer, or correct any figure: if a printed total looks inconsistent with the lines, transcribe it anyway. The practice's own software does all the arithmetic and will catch inconsistencies.

Scans are often blurry, skewed or smudged. Put your best reading of every field in the main structure, then list in \`uncertain_fields\` every field you are less than 95% sure of: its dot path (for example "claims.0.insurance_paid" or "claims.0.adjustments.1.reason_code"), your confidence from 0 to 1, a few words on what is unclear, and the other plausible readings, most likely first. Leave out fields you read cleanly. Never invent a value that is not on the page: use null where the schema allows it.`;

export interface ClaudeEobExtractorOptions {
  client: Anthropic;
  model: string;
}

export class ClaudeEobExtractor implements EobExtractor {
  readonly name = 'claude';

  constructor(private readonly options: ClaudeEobExtractorOptions) {}

  async extract(
    pdf: Uint8Array,
    fileName: string,
  ): Promise<{ extraction: EobExtraction; raw: EobModelOutput }> {
    const response = await this.options.client.beta.messages.parse({
      model: this.options.model,
      max_tokens: 16000,
      // Re-run on Anthropic's recommended fallback model if a safety classifier declines.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'high', format: betaZodOutputFormat(EobModelOutputSchema) },
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
    return { extraction: toExtraction(response.parsed_output), raw: response.parsed_output };
  }
}

export interface EobRecording {
  fileName: string;
  sha256: string;
  model: string;
  recordedAt: string;
  /** The model's raw structured output. */
  output: EobModelOutput;
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

  async extract(
    pdf: Uint8Array,
    fileName: string,
  ): Promise<{ extraction: EobExtraction; raw: EobModelOutput }> {
    const file = this.path(pdf);
    if (!existsSync(file)) {
      throw new AiExtractionError(
        `No recorded extraction for ${fileName}. Set ANTHROPIC_API_KEY to read new EOBs live, or run \`pnpm ai:record\`.`,
      );
    }
    const recording = JSON.parse(readFileSync(file, 'utf8')) as EobRecording;
    const raw = EobModelOutputSchema.parse(recording.output);
    return { extraction: toExtraction(raw), raw };
  }
}

/** Prefer a recording when one exists (seed files), otherwise read live. */
export class RecordedThenLiveExtractor implements EobExtractor {
  readonly name = 'recorded-then-live';

  constructor(
    private readonly recorded: RecordedEobExtractor,
    private readonly live: EobExtractor | null,
  ) {}

  extract(
    pdf: Uint8Array,
    fileName: string,
  ): Promise<{ extraction: EobExtraction; raw: EobModelOutput }> {
    if (this.recorded.has(pdf) || !this.live) return this.recorded.extract(pdf, fileName);
    return this.live.extract(pdf, fileName);
  }
}
