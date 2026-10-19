/**
 * The drawer's message language: a globe button with the current language that opens a menu of
 * every language the patient's statement offers (NOTE_LANGUAGES), each in its own script with
 * the English name beside it. The patient's own choice, when known, is marked.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { NOTE_LANGUAGES, noteLanguage } from '@plainbill/core';

interface Props {
  value: string;
  /** The language the patient last read a statement in. */
  patientLang: string | null;
  disabled?: boolean;
  onChange: (code: string) => void;
}

function GlobeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path
        d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}

export function MessageLanguageMenu({ value, patientLang, disabled, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const current = noteLanguage(value) ?? NOTE_LANGUAGES[0]!;

  useEffect(() => {
    if (!open) return;
    items.current[NOTE_LANGUAGES.findIndex((l) => l.code === value)]?.focus();
    const outside = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open, value]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  const pick = (code: string) => {
    close();
    if (code !== value) onChange(code);
  };

  // Escape closes the menu, not the drawer; arrows move between languages.
  const onKey = (e: KeyboardEvent) => {
    if (!open) return;
    const i = items.current.findIndex((el) => el === document.activeElement);
    const go = (n: number) => {
      e.preventDefault();
      items.current[(n + NOTE_LANGUAGES.length) % NOTE_LANGUAGES.length]?.focus();
    };
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(NOTE_LANGUAGES.length - 1);
    else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <div className="lang-menu" ref={root} onKeyDown={onKey}>
      <button
        ref={button}
        type="button"
        className="lang-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Message language: ${current.name}`}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <GlobeIcon />
        <span lang={current.code}>{current.native}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <ul className="lang-menu-list" role="menu" aria-label="Message language">
          {NOTE_LANGUAGES.map((l, i) => (
            <li key={l.code} role="none">
              <button
                ref={(el) => {
                  items.current[i] = el;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={l.code === value}
                tabIndex={-1}
                onClick={() => pick(l.code)}
              >
                <span className="lang-menu-check" aria-hidden="true">
                  {l.code === value ? '✓' : ''}
                </span>
                <span lang={l.code} className="lang-menu-native">
                  {l.native}
                </span>
                {l.native !== l.name && <span className="lang-menu-name">{l.name}</span>}
                {l.code === patientLang && <span className="lang-menu-tag">Patient’s choice</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
