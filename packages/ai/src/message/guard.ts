/**
 * Checks a drafted message before staff ever see it: every dollar figure must be one the core
 * computed, and nothing that looks like a procedure or diagnosis code may appear.
 */
import { findDollarAmounts, formatMoney, PLAN_MONTHS } from '@plainbill/core';
import { allowedAmounts, type MessageFacts } from './facts';

export interface GuardIssue {
  kind: 'unknown-amount' | 'unknown-number' | 'medical-code' | 'empty' | 'too-long';
  detail: string;
}

/** Five-digit procedure codes (CPT) and ICD-10-looking codes. */
export const CODE_RES = [/\b\d{5}\b/, /\b[A-TV-Z]\d{2}\.\d{1,4}\b/];
const MAX_WORDS = 140;

/** Every dollar figure in a text, in cents (the same finder the core's own tests use). */
export const findAmounts = findDollarAmounts;

/** [year, month, day] of each date the message may mention. */
function dates(f: MessageFacts): number[][] {
  return [f.visitDate, f.dueDate]
    .filter((d): d is string => Boolean(d))
    .map((d) => d.split('-').map(Number));
}

/** "3.10", "03.10.2026", "10.3" or "2026.10.03": one of the bill's dates, written with dots. */
function isDottedDate(token: string, f: MessageFacts): boolean {
  if (!/^\d+(?:\.\d+){1,2}$/.test(token)) return false;
  const parts = token.split('.').map(Number).join('-');
  return dates(f).some(([y, m, d]) =>
    [
      [d, m],
      [d, m, y],
      [m, d],
      [m, d, y],
      [y, m, d],
    ].some((form) => form.join('-') === parts),
  );
}

/** A number as written, read with US ("1,850.50") and European ("1.850,50") separators, in cents. */
function readingsInCents(token: string): number[] {
  const us = Number(token.replaceAll(',', ''));
  const eu = Number(token.replaceAll('.', '').replace(',', '.'));
  return [us, eu].filter(Number.isFinite).map((n) => Math.round(n * 100));
}

/**
 * Bare numbers (no "$" in front). In English the "$" rule is enough, but other languages write
 * money as "240 $", "240 đô la" or "240美元", which the dollar finder can't see. So every number
 * must be one of the bill's figures, part of one of its dates, or a plan's number of payments.
 */
function numberIssues(text: string, f: MessageFacts): GuardIssue[] {
  const allowed = allowedAmounts(f);
  const plain = new Set<number>([
    ...dates(f).flat(),
    ...PLAN_MONTHS,
    ...(f.plan ? [f.plan.months] : []),
  ]);
  const issues: GuardIssue[] = [];
  const seen = new Set<string>();
  for (const [token] of text.matchAll(/\d+(?:[.,]\d+)*/g)) {
    if (seen.has(token)) continue;
    seen.add(token);
    const cents = readingsInCents(token);
    const ok =
      cents.some((c) => allowed.has(c)) ||
      (/^\d+$/.test(token) && plain.has(Number(token))) ||
      isDottedDate(token, f);
    if (!ok)
      issues.push({
        kind: 'unknown-number',
        detail: `"${token}" is not one of this bill's figures.`,
      });
  }
  return issues;
}

export interface CheckOptions {
  /**
   * Also check numbers written without "$" (see numberIssues). On for drafts in languages other
   * than English.
   */
  strictNumbers?: boolean;
}

export function checkMessage(
  text: string,
  facts: MessageFacts,
  options: CheckOptions = {},
): GuardIssue[] {
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
  if (options.strictNumbers) {
    // "$240" was checked above; strip it so its digits aren't read twice.
    const bare = trimmed.replace(/\$\s?(\d{1,3}(?:,\d{3})*|\d+)(\.\d{1,2})?/g, ' ');
    issues.push(...numberIssues(bare, facts));
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
