/**
 * @plainbill/ai — Phase 1 placeholder. Phase 2 adds the Anthropic SDK and implements these
 * contracts. Two rules from CLAUDE.md shape them:
 *
 * - The model never does money math. Extraction returns raw fields with confidence; every
 *   amount a patient sees is recomputed by @plainbill/core.
 * - Uncertainty is surfaced: any field below CONFIDENCE_THRESHOLD is flagged for a human.
 */

/** Fields extracted below this confidence are flagged on the Intake screen. */
export const CONFIDENCE_THRESHOLD = 0.85;

export interface ExtractedField<T> {
  value: T;
  /** 0–1, from the model's structured output. */
  confidence: number;
  /** Why the model is unsure ("scan blurry: $260 or $280?"), and alternatives it considered. */
  note?: string;
  alternatives?: T[];
}

export interface EobExtraction {
  payerName: ExtractedField<string>;
  patientName: ExtractedField<string>;
  serviceDate: ExtractedField<string>;
  lines: Array<{
    procedureCode: ExtractedField<string>;
    billed: ExtractedField<string>;
    allowed: ExtractedField<string>;
    paid: ExtractedField<string>;
    adjustments: Array<{
      group: ExtractedField<string>;
      reason: ExtractedField<string>;
      amount: ExtractedField<string>;
    }>;
  }>;
}

export function isFlagged(field: ExtractedField<unknown>): boolean {
  return field.confidence < CONFIDENCE_THRESHOLD;
}

/** Model id from ANTHROPIC_MODEL (read by the API at startup and passed in). */
export function resolveModel(env: Record<string, string | undefined>): string {
  const model = env.ANTHROPIC_MODEL?.trim();
  if (!model) throw new Error('ANTHROPIC_MODEL is not set.');
  return model;
}
