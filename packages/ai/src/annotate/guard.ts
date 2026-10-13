/**
 * Checks each AI-written statement note before a patient sees it: it must belong to a known
 * anchor, mention only that anchor's figures (or what the patient owes), contain nothing that
 * looks like a medical code, and stay short. A note that fails twice is replaced by the
 * template note for that line.
 */
import { formatMoney, NOTE_BODY_MAX_WORDS, NOTE_TITLE_MAX_WORDS } from '@plainbill/core';
import { CODE_RES, findAmounts } from '../message/guard';
import type { AnnotateAnchor, AnnotateFacts } from './facts';

export interface NoteDraft {
  anchorId: string;
  title: string;
  body: string;
}

export interface NoteIssue {
  anchorId: string;
  kind:
    'unknown-anchor' | 'missing-anchor' | 'unknown-amount' | 'medical-code' | 'empty' | 'too-long';
  detail: string;
}

/** Translations run a little longer than English; the prompt still asks for 5 / 35. */
const TITLE_LIMIT = NOTE_TITLE_MAX_WORDS + 2;
const BODY_LIMIT = NOTE_BODY_MAX_WORDS + 10;

/** Word count, or characters ÷ 3 for scripts written without spaces (Chinese). */
function length(text: string, lang: string): number {
  const t = text.trim();
  if (lang === 'zh') return Math.ceil([...t.replace(/\s/g, '')].length / 3);
  return t.split(/\s+/).filter(Boolean).length;
}

export function checkNote(
  note: NoteDraft,
  anchor: AnnotateAnchor | undefined,
  facts: AnnotateFacts,
): NoteIssue[] {
  const id = note.anchorId;
  if (!anchor) {
    return [{ anchorId: id, kind: 'unknown-anchor', detail: `"${id}" is not one of the lines.` }];
  }
  const issues: NoteIssue[] = [];
  const title = note.title.trim();
  const body = note.body.trim();
  if (!title || !body) {
    issues.push({ anchorId: id, kind: 'empty', detail: `The note for ${id} is empty.` });
  }
  const allowed = new Set([...anchor.amountsCents, facts.owesCents]);
  for (const amount of new Set(findAmounts(`${title} ${body}`))) {
    if (!allowed.has(amount)) {
      issues.push({
        anchorId: id,
        kind: 'unknown-amount',
        detail: `The ${id} note mentions ${formatMoney(amount)}, which is not one of that line's figures.`,
      });
    }
  }
  for (const re of CODE_RES) {
    const match = re.exec(`${title} ${body}`);
    if (match) {
      issues.push({
        anchorId: id,
        kind: 'medical-code',
        detail: `The ${id} note contains "${match[0]}", which looks like a medical code.`,
      });
    }
  }
  const lang = facts.language.code;
  if (length(title, lang) > TITLE_LIMIT || length(body, lang) > BODY_LIMIT) {
    issues.push({
      anchorId: id,
      kind: 'too-long',
      detail: `The ${id} note is too long (title up to ${NOTE_TITLE_MAX_WORDS} words, body up to ${NOTE_BODY_MAX_WORDS}).`,
    });
  }
  return issues;
}

/** Check a whole set: every note, plus anchors that got no note at all. */
export function checkNotes(notes: NoteDraft[], facts: AnnotateFacts): NoteIssue[] {
  const byId = new Map(facts.anchors.map((a) => [a.id, a]));
  const issues = notes.flatMap((n) => checkNote(n, byId.get(n.anchorId), facts));
  for (const anchor of facts.anchors) {
    if (!notes.some((n) => n.anchorId === anchor.id)) {
      issues.push({
        anchorId: anchor.id,
        kind: 'missing-anchor',
        detail: `There is no note for ${anchor.id}.`,
      });
    }
  }
  return issues;
}
