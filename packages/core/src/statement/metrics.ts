/**
 * Text widths for the PDF standard fonts, so the layout can place and check text without a
 * font engine. Helvetica widths are Adobe's core-font metrics (per 1000 em, ASCII 32–126);
 * Courier is monospaced at 600. Browsers draw the on-screen copy with Helvetica/Arial, which
 * share these metrics.
 */
export type StatementFont = 'sans' | 'sans-bold' | 'mono' | 'mono-bold';

const HELVETICA =
  '278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584';
const HELVETICA_BOLD =
  '278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611 975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556 556 500 389 280 389 584';

const table = (s: string) => s.split(' ').map(Number);
const WIDTHS = { sans: table(HELVETICA), 'sans-bold': table(HELVETICA_BOLD) };
const EXTRA: Record<string, number> = { '·': 278, '–': 556, '—': 1000, '’': 250, '‘': 250 };

function charWidth(ch: string, widths: number[]): number {
  const code = ch.charCodeAt(0);
  if (code >= 32 && code <= 126) return widths[code - 32]!;
  if (ch in EXTRA) return EXTRA[ch]!;
  // Accented Latin letters are as wide as their base letter.
  const base = ch.normalize('NFD')[0]!;
  const baseCode = base.charCodeAt(0);
  return baseCode >= 32 && baseCode <= 126 ? widths[baseCode - 32]! : 556;
}

/** Width in points of `text` set in `font` at `size`. */
export function textWidth(text: string, font: StatementFont, size: number): number {
  if (font === 'mono' || font === 'mono-bold') return [...text].length * 0.6 * size;
  const widths = WIDTHS[font];
  let units = 0;
  for (const ch of text) units += charWidth(ch, widths);
  return (units / 1000) * size;
}

/** Characters outside Latin-1 that WinAnsi (the standard PDF fonts' encoding) can still draw. */
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

/**
 * The PDF's standard fonts can only draw WinAnsi characters. Anything else is reduced to its
 * base letter ("ễ" → "e") or replaced with "?", so a name never breaks the statement.
 */
export function winAnsi(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255) || WIN_ANSI_EXTRA.has(ch)) {
      out += ch;
      continue;
    }
    const base = ch.normalize('NFD')[0]!;
    const baseCode = base.codePointAt(0)!;
    out += baseCode >= 32 && baseCode <= 126 ? base : '?';
  }
  return out;
}
