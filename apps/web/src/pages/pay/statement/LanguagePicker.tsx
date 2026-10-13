/**
 * The notes' language. Desktop: "Notes in" + segmented buttons (English, Español, Kreyòl, 中文,
 * More ▾). Phone: a globe pill with the current language that opens a bottom sheet listing every
 * language. The choice is remembered on this device.
 */
import { useEffect, useRef, useState } from 'react';
import { NOTE_LANGUAGES } from '@plainbill/core';
import { useI18n } from '../i18n';
import { DESKTOP_QUERY, useMedia } from './useMedia';

const PRIMARY = ['en', 'es', 'ht', 'zh'];
const STORAGE_KEY = 'pb.statement.lang';

/** The saved language, if any (storage can be unavailable: private windows, blocked cookies). */
export function savedLanguage(): string | null {
  try {
    const code = localStorage.getItem(STORAGE_KEY);
    return NOTE_LANGUAGES.some((l) => l.code === code) ? code : null;
  } catch {
    return null;
  }
}

export function saveLanguage(code: string) {
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // Not remembered; the page still works.
  }
}

const native = (code: string) => NOTE_LANGUAGES.find((l) => l.code === code)?.native ?? code;

function GlobeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
    </svg>
  );
}

export function LanguagePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (code: string) => void;
}) {
  const { t } = useI18n();
  const desktop = useMedia(DESKTOP_QUERY);
  const [menuOpen, setMenuOpen] = useState(false);
  const sheet = useRef<HTMLDialogElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent
          ? e.key === 'Escape'
          : !menuRef.current?.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [menuOpen]);

  const pick = (code: string) => {
    setMenuOpen(false);
    sheet.current?.close();
    if (code !== value) onChange(code);
  };

  if (!desktop) {
    return (
      <>
        <button
          type="button"
          className="st-lang-pill"
          aria-haspopup="dialog"
          aria-label={`${t('language')}: ${native(value)}`}
          onClick={() => sheet.current?.showModal()}
        >
          <GlobeIcon />
          {native(value)}
        </button>
        <dialog
          ref={sheet}
          className="st-lang-sheet"
          aria-labelledby="st-lang-title"
          onClick={(e) => e.target === sheet.current && sheet.current.close()}
        >
          <fieldset className="st-lang-list">
            <legend id="st-lang-title">{t('chooseLanguage')}</legend>
            {NOTE_LANGUAGES.map((l) => (
              <label key={l.code} className={l.code === value ? 'is-on' : undefined} lang={l.code}>
                <input
                  type="radio"
                  name="st-lang"
                  value={l.code}
                  checked={l.code === value}
                  onChange={() => pick(l.code)}
                />
                {l.native}
              </label>
            ))}
          </fieldset>
          <form method="dialog">
            <button type="submit" className="pay-btn-outline st-lang-close">
              {t('close')}
            </button>
          </form>
        </dialog>
      </>
    );
  }

  const more = NOTE_LANGUAGES.filter((l) => !PRIMARY.includes(l.code));
  const moreSelected = more.find((l) => l.code === value);
  return (
    <div className="st-lang">
      <span className="st-lang-label" id="st-lang-label">
        {t('notesIn')}
      </span>
      <div className="st-lang-seg" role="group" aria-labelledby="st-lang-label">
        {PRIMARY.map((code) => (
          <button
            key={code}
            type="button"
            lang={code}
            className={code === value ? 'is-on' : undefined}
            aria-pressed={code === value}
            onClick={() => pick(code)}
          >
            {native(code)}
          </button>
        ))}
        <div className="st-lang-more" ref={menuRef}>
          <button
            type="button"
            className={moreSelected ? 'is-on' : undefined}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={() => setMenuOpen((o) => !o)}
          >
            {moreSelected ? moreSelected.native : t('more')} <span aria-hidden="true">▾</span>
          </button>
          {menuOpen && (
            <ul className="st-lang-menu" role="menu">
              {more.map((l) => (
                <li key={l.code} role="none">
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={l.code === value}
                    lang={l.code}
                    onClick={() => pick(l.code)}
                  >
                    {l.native}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
