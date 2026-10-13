/**
 * What the statement annotator knows: the bill's computed facts (the same MessageFacts the
 * patient message is written from), the statement's anchors as code laid them out, and the
 * language to write in. Each anchor carries the figures a note about it may mention and the
 * deterministic English note, so the model knows what the line means without guessing.
 */
import {
  templateStatementNotes,
  type AnchorKind,
  type StatementLayout,
  type StatementModel,
  type StatementNoteText,
} from '@plainbill/core';
import type { MessageFacts } from '../message/facts';

export interface AnnotateAnchor {
  id: string;
  kind: AnchorKind;
  /** The printed line ("CO45 −400.00"), shown to the patient separately as a chip. */
  quote: string;
  amountsCents: number[];
}

export interface AnnotateFacts extends MessageFacts {
  practicePhone: string;
  anchors: AnnotateAnchor[];
  language: { code: string; name: string };
  /** Deterministic notes: the English reference, and the fallback for en/es. */
  templates: { en: StatementNoteText[]; es: StatementNoteText[] };
}

/** Facts for one statement and language, from the core's model and layout. */
export function annotateFactsFor(
  base: MessageFacts,
  statement: { model: StatementModel; layout: StatementLayout },
  language: { code: string; name: string },
): AnnotateFacts {
  const { model, layout } = statement;
  return {
    ...base,
    owesCents: model.totals.remainingCents,
    practicePhone: model.input.practice.phone,
    anchors: layout.anchors.map(({ id, kind, quote, amountsCents }) => ({
      id,
      kind,
      quote,
      amountsCents,
    })),
    language,
    templates: {
      en: templateStatementNotes(model, layout, 'en'),
      es: templateStatementNotes(model, layout, 'es'),
    },
  };
}
