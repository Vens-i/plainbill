import Anthropic from '@anthropic-ai/sdk';

/** SDK client; with no key argument it resolves credentials from the environment. */
export function createClaudeClient(apiKey?: string): Anthropic {
  return new Anthropic(apiKey ? { apiKey } : {});
}

/** Fields extracted below this confidence are flagged for a human on the Intake screen. */
export const CONFIDENCE_THRESHOLD = 0.85;

/** Model id from ANTHROPIC_MODEL (read by the API at startup and passed in). */
export function resolveModel(env: Record<string, string | undefined>): string {
  const model = env.ANTHROPIC_MODEL?.trim();
  if (!model) throw new Error('ANTHROPIC_MODEL is not set.');
  return model;
}
