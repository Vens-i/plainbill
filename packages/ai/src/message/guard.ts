/**
 * Checks a drafted message before staff ever see it: every dollar figure must be one the core
 * computed, and nothing that looks like a procedure or diagnosis code may appear.
 */
import { findDollarAmounts, formatMoney } from '@plainbill/core';
import { allowedAmounts, type MessageFacts } from './facts';

export interface GuardIssue {
  kind: 'unknown-amount' | 'medical-code' | 'empty' | 'too-long';
  detail: string;
}

/** Five-digit procedure codes (CPT) and ICD-10-looking codes. */
export const CODE_RES = [/\b\d{5}\b/, /\b[A-TV-Z]\d{2}\.\d{1,4}\b/];
const MAX_WORDS = 140;

/** Every dollar figure in a text, in cents (the same finder the core's own tests use). */
export const findAmounts = findDollarAmounts;

export function checkMessage(text: string, facts: MessageFacts): GuardIssue[] {
  const issues: GuardIssue[] = [];
  const trimmed = text.trim();
  if (!trimmed) return [{ kind: 'empty', detail: 'The message is empty.' }];

  const allowed = allowedAmounts(facts);
  for (const amount of new Set(findAmounts(trimmed))) {
    if (!allowed.has(amount)) {
      issues.push({
        kind: 'unknown-amount',
        detail: `${formatMoney(amount)} is not one of this bill's figures.`,
      });
    }
  }
  for (const re of CODE_RES) {
    const match = re.exec(trimmed);
    if (match)
      issues.push({ kind: 'medical-code', detail: `"${match[0]}" looks like a medical code.` });
  }
  const words = trimmed.split(/\s+/).length;
  if (words > MAX_WORDS)
    issues.push({ kind: 'too-long', detail: `${words} words (keep it under ${MAX_WORDS}).` });
  return issues;
}
