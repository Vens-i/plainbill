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
import { DesktopStatement } from './DesktopStatement';
import { Highlights } from './Highlights';
import { StatementSvg } from './StatementSvg';
import { DESKTOP_QUERY, useMedia } from './useMedia';

interface Props {
  token: string;
  bill: PatientBill;
}

export function StatementExplained({ token, bill }: Props) {
  const desktop = useMedia(DESKTOP_QUERY);
  const [statement, setStatement] = useState<PatientStatement | null>(null);
  const [failed, setFailed] = useState(false);
  const [notes, setNotes] = useState<StatementNotes | null>(null);
  const [pulse, setPulse] = useState<string | null>(null);
  const pulseTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lang = 'en';

  useEffect(() => {
    let live = true;
    payApi
      .statement(token)
      .then((s) => live && setStatement(s))
      .catch((err: unknown) => {
        // The waterfall below still explains the bill; just log it.
        console.warn('Statement unavailable', err);
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [token]);

  useEffect(() => {
    let live = true;
    payApi
      .statementNotes(token, lang)
      .then((n) => live && setNotes(n))
      .catch((err: unknown) => console.warn('Statement notes unavailable', err));
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
  const label = `Your itemized statement from ${bill.practice.name}, amount due ${formatMoney(bill.amounts.remainingCents)}`;

  return (
    <section id="statement" className="st-section" aria-labelledby="st-title">
      <div className="st-caption">
        <h2 id="st-title" className="st-caption-title">
          The bill you got in the mail, explained
        </h2>
      </div>
      {!statement ? (
        <div
          className="st-paper-wrap st-skeleton"
          aria-busy="true"
          aria-label="Loading your statement"
        />
      ) : desktop && notes ? (
        <DesktopStatement
          layout={statement.layout}
          notes={notes.notes}
          label={label}
          phone={bill.practice.phone}
          chipLabel="On your bill:"
          showMarks
          pulse={pulse}
          onPulse={onPulse}
        />
      ) : (
        <div className="st-paper-wrap">
          <StatementSvg layout={statement.layout} label={label}>
            <Highlights anchors={statement.layout.anchors} pulse={pulse} onSelect={onPulse} />
          </StatementSvg>
        </div>
      )}
    </section>
  );
}
