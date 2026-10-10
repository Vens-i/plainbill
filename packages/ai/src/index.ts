/**
 * @plainbill/ai — the only package that talks to a model. Two rules from CLAUDE.md shape it:
 *
 * - The model never does money math. Extraction returns transcribed fields with confidence;
 *   every amount is parsed and reconciled by @plainbill/core. Drafted messages are checked so
 *   they only mention figures the core computed.
 * - Uncertainty is surfaced: fields below CONFIDENCE_THRESHOLD become flags for a human, each
 *   with the readings that do (and don't) make the claim add up.
 */
export { CONFIDENCE_THRESHOLD, resolveModel } from './config';
export * from './eob/schema';
export * from './eob/extractor';
export * from './eob/to-claims';
export * from './message/facts';
export * from './message/guard';
export * from './message/template';
export * from './message/drafter';
