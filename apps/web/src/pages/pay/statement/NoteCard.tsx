/**
 * One margin note: a cream card with a teal number badge, a handwritten (Caveat) title, the
 * plain-language body and the printed line it explains ("On your bill: CO45 −400.00").
 */
import { forwardRef, type CSSProperties, type ReactNode } from 'react';
import type { StatementNote } from '@plainbill/api/contract';
import { noteParts } from './format';

interface Props {
  note: StatementNote;
  phone: string;
  /** "On your bill:" in the page language. */
  chipLabel: string;
  active?: boolean;
  pulsing?: boolean;
  /** Tilt alternates by note number; off for the phone's single card. */
  tilt?: boolean;
  style?: CSSProperties;
  onSelect?: () => void;
  children?: ReactNode;
}

export function NoteBody({ text, phone }: { text: string; phone: string }) {
  return (
    <>
      {noteParts(text, phone).map((p, i) =>
        p.kind === 'money' ? (
          <b key={i}>{p.text}</b>
        ) : p.kind === 'phone' ? (
          <a key={i} href={p.href}>
            {p.text}
          </a>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

export const NoteCard = forwardRef<HTMLDivElement, Props>(function NoteCard(
  { note, phone, chipLabel, active, pulsing, tilt = true, style, onSelect, children },
  ref,
) {
  const angle = tilt ? (note.n % 2 ? -1 : 1) * (0.4 + ((note.n * 37) % 4) * 0.1) : 0;
  return (
    <div
      ref={ref}
      className={`st-card${active ? ' is-active' : ''}${pulsing ? ' is-pulsing' : ''}`}
      style={{ ...style, ['--tilt' as string]: `${angle}deg` }}
      onClick={onSelect}
    >
      <div className="st-card-head">
        <span className="st-badge" aria-hidden="true">
          {note.n}
        </span>
        <h3 className="st-card-title">{note.title}</h3>
      </div>
      <p className="st-card-body">
        <NoteBody text={note.body} phone={phone} />
      </p>
      <div className="st-chip">
        {chipLabel} {note.quote}
      </div>
      {children}
    </div>
  );
});
