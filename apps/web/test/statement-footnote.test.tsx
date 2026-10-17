import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NotesSourceLine } from '../src/pages/pay/statement/HowItWorks';

describe('statement footnote', () => {
  it('keeps the How it works dialog out of a <p> (no nested-<p> warning)', () => {
    // React warned on every patient page: "<p> cannot contain a nested <h2>", <ol>, <dialog>…
    const html = renderToStaticMarkup(<NotesSourceLine source="ai" />);
    expect(html).toContain('<dialog');
    expect(html.startsWith('<div class="st-footnote-line">')).toBe(true);
    expect(html).not.toMatch(/^<p[\s>]/);
  });
});
