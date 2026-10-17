/**
 * "How this works": the five steps and three guardrails behind the notes (from the design's
 * how-it-works board), in plain words, in a modal dialog.
 */
import { useRef } from 'react';
import type { StatementNotes } from '@plainbill/api/contract';
import { useI18n, type I18nKey } from '../i18n';

const STEPS: Array<[I18nKey, I18nKey]> = [
  ['how1Title', 'how1Body'],
  ['how2Title', 'how2Body'],
  ['how3Title', 'how3Body'],
  ['how4Title', 'how4Body'],
  ['how5Title', 'how5Body'],
];
const GUARDS: I18nKey[] = ['guard1', 'guard2', 'guard3'];

export function HowItWorks() {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button type="button" className="st-link" onClick={() => dialog.current?.showModal()}>
        {t('howItWorks')}
      </button>
      <dialog
        ref={dialog}
        className="st-how"
        aria-labelledby="st-how-title"
        onClick={(e) => {
          // A click on the backdrop (the dialog element itself) closes it.
          if (e.target === dialog.current) dialog.current.close();
        }}
      >
        <div className="st-how-inner">
          <h2 id="st-how-title" className="st-how-title">
            {t('howTitle')}
          </h2>
          <p className="st-how-lede">{t('howLede')}</p>
          <ol className="st-how-steps">
            {STEPS.map(([title, body], i) => (
              <li key={title}>
                <h3>
                  {i + 1} · {t(title)}
                </h3>
                <p>{t(body)}</p>
              </li>
            ))}
          </ol>
          <ul className="st-how-guards">
            {GUARDS.map((g) => (
              <li key={g}>
                <span aria-hidden="true">✓</span> {t(g)}
              </li>
            ))}
          </ul>
          <form method="dialog">
            <button type="submit" className="pay-btn-outline st-how-close">
              {t('close')}
            </button>
          </form>
        </div>
      </dialog>
    </>
  );
}

/**
 * "Notes written by AI and checked by code. How this works" under the statement. A div, not a
 * <p>: the How it works dialog inside it has headings and lists, which a <p> can't contain
 * (React warned about it on every patient page).
 */
export function NotesSourceLine({ source }: { source: StatementNotes['source'] }) {
  const { t } = useI18n();
  return (
    <div className="st-footnote-line">
      {source === 'template' ? t('footnoteTemplate') : t('footnoteAi')} <HowItWorks />
    </div>
  );
}
