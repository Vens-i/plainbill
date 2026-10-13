/**
 * "The bill you got in the mail, explained": the practice's own statement, drawn from the same
 * layout as the PDF, with highlighter marks on the lines that matter and a short note for each
 * one. Claude writes the notes (checked against the bill); code decides where they go.
 */
import './statement.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PatientBill, PatientStatement, StatementNotes } from '@plainbill/api/contract';
import { formatMoney } from '@plainbill/core';
import { payApi } from '../../../lib/api';
import { useI18n } from '../i18n';
import { DesktopStatement } from './DesktopStatement';
import { HowItWorks } from './HowItWorks';
import { PhoneStatement, type PhoneStrings } from './PhoneStatement';
import { DESKTOP_QUERY, useMedia } from './useMedia';

interface Props {
  token: string;
  bill: PatientBill;
  /** Scroll to "Ask about your bill" and focus its input. */
  onAsk: () => void;
}

export function StatementExplained({ token, bill, onAsk }: Props) {
  const { lang, t } = useI18n();
  const desktop = useMedia(DESKTOP_QUERY);
  const [statement, setStatement] = useState<PatientStatement | null>(null);
  const [failed, setFailed] = useState(false);
  const [notes, setNotes] = useState<StatementNotes | null>(null);
  const [notesFailed, setNotesFailed] = useState(false);
  const [showMarks, setShowMarks] = useState(true);
  const [active, setActive] = useState(0);
  const [pulse, setPulse] = useState<string | null>(null);
  const pulseTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    let live = true;
    payApi
      .statement(token)
      .then((s) => live && setStatement(s))
      .catch((err: unknown) => {
        // The short version below still explains the bill; just log it.
        console.warn('Statement unavailable', err);
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [token]);

  useEffect(() => {
    let live = true;
    setNotes(null);
    setNotesFailed(false);
    payApi
      .statementNotes(token, lang)
      .then((n) => live && setNotes(n))
      .catch((err: unknown) => {
        console.warn('Statement notes unavailable', err);
        if (live) setNotesFailed(true);
      });
    return () => {
      live = false;
    };
  }, [token, lang]);

  const onPulse = useCallback((id: string) => {
    setPulse(id);
    clearTimeout(pulseTimer.current);
    pulseTimer.current = setTimeout(() => setPulse(null), 900);
  }, []);

  if (failed) return null;
  const notesLang = notes && !notes.fallback ? notes.lang : undefined;
  const label = t('statementLabel', {
    practice: bill.practice.name,
    amount: formatMoney(bill.amounts.remainingCents),
  });
  const strings: PhoneStrings = {
    chipLabel: t('chip'),
    previous: t('previous'),
    next: t('next'),
    position: (n, total) => t('position', { n, total }),
    pinLabel: (n, title) => (title ? t('noteLabel', { n, title }) : t('noteLabelBare', { n })),
    stripLabel: (quote) => t('stripLabel', { quote }),
    unavailable: t('unavailable'),
  };

  const caption = (
    <div className="st-caption">
      <h2 id="st-title" className="st-caption-title">
        {t('captionTitle')}
      </h2>
      <div className="st-caption-tools">
        <button
          type="button"
          className="st-toggle"
          aria-pressed={showMarks}
          onClick={() => setShowMarks((on) => !on)}
        >
          <span className="st-toggle-swatch" aria-hidden="true" />
          {showMarks ? t('highlightsOn') : t('highlightsOff')}
        </button>
        {statement && (
          <a className="st-link" href={statement.pdfPath} target="_blank" rel="noopener">
            {t('download')}
          </a>
        )}
      </div>
    </div>
  );

  const footnote = (
    <div className="st-footnote">
      {notes?.fallback && (
        <p className="st-banner" role="status">
          {t('fallbackBanner', { phone: bill.practice.phone })}
        </p>
      )}
      {notes && (
        <p>
          {notes.source === 'template' ? t('footnoteTemplate') : t('footnoteAi')} <HowItWorks />
        </p>
      )}
      <p>{t('synthetic')}</p>
    </div>
  );

  const loadingPaper = (
    <div
      className="st-paper-wrap st-skeleton"
      aria-busy="true"
      aria-label={t('loadingStatement')}
    />
  );

  return (
    <section id="statement" className="st-section" aria-labelledby="st-title">
      {desktop ? (
        <DesktopStatement
          layout={statement?.layout ?? null}
          notes={notes?.notes ?? null}
          notesFailed={notesFailed}
          label={label}
          phone={bill.practice.phone}
          chipLabel={t('chip')}
          unavailable={t('unavailable')}
          noteLabel={strings.pinLabel}
          showMarks={showMarks}
          pulse={pulse}
          onPulse={onPulse}
          caption={caption}
          footnote={footnote}
          loading={loadingPaper}
          notesLang={notesLang}
        />
      ) : (
        <>
          {caption}
          {statement ? (
            <PhoneStatement
              layout={statement.layout}
              notes={notes ? notes.notes : notesFailed ? [] : null}
              label={label}
              phone={bill.practice.phone}
              strings={strings}
              showMarks={showMarks}
              active={active}
              onActive={setActive}
              pulse={pulse}
              onPulse={onPulse}
              notesLang={notesLang}
              below={
                <button type="button" className="st-link st-ask-link" onClick={onAsk}>
                  {t('askButton')}
                </button>
              }
            />
          ) : (
            loadingPaper
          )}
          {footnote}
        </>
      )}
    </section>
  );
}
