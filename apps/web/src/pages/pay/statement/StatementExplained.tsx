/**
 * "The bill you got in the mail, explained": the practice's own statement, drawn from the same
 * layout as the PDF, with highlighter marks on the lines that matter.
 */
import './statement.css';
import { useEffect, useState } from 'react';
import type { PatientBill, PatientStatement } from '@plainbill/api/contract';
import { formatMoney } from '@plainbill/core';
import { payApi } from '../../../lib/api';
import { Highlights } from './Highlights';
import { StatementSvg } from './StatementSvg';

interface Props {
  token: string;
  bill: PatientBill;
}

export function StatementExplained({ token, bill }: Props) {
  const [statement, setStatement] = useState<PatientStatement | null>(null);
  const [failed, setFailed] = useState(false);

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

  if (failed) return null;
  const label = `Your itemized statement from ${bill.practice.name}, amount due ${formatMoney(bill.amounts.remainingCents)}`;

  return (
    <section id="statement" className="st-section" aria-labelledby="st-title">
      <div className="st-caption">
        <h2 id="st-title" className="st-caption-title">
          The bill you got in the mail, explained
        </h2>
      </div>
      {statement ? (
        <div className="st-paper-wrap">
          <StatementSvg layout={statement.layout} label={label}>
            <Highlights anchors={statement.layout.anchors} />
          </StatementSvg>
        </div>
      ) : (
        <div
          className="st-paper-wrap st-skeleton"
          aria-busy="true"
          aria-label="Loading your statement"
        />
      )}
    </section>
  );
}
