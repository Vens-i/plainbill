/**
 * Desktop (≥ 1200 px): notes | statement | notes. Each card sits beside its line (sorted by the
 * line's height on the page, pushed apart to keep a 24 px gap) and an arrow runs from the card to
 * the line. Cards are measured before they're placed, all in one layout effect, and placed again
 * whenever the section resizes or the fonts finish loading.
 *
 * The notes are one <ol> in note order (1…n); only their positions split them into two columns.
 * Each note starts with a visually hidden button (shown on keyboard focus) that brings its card
 * forward and pulses its mark.
 */
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { StatementLayout, StatementNote } from '@plainbill/api/contract';
import { Arrows, type ArrowSpec } from './Arrows';
import { attachPoint, pinPositions, placeCards } from './geometry';
import { Highlights } from './Highlights';
import { NoteCard } from './NoteCard';
import { StatementSvg } from './StatementSvg';

const GAP = 24;

interface Props {
  layout: StatementLayout | null;
  /** Null while loading. */
  notes: StatementNote[] | null;
  notesFailed: boolean;
  label: string;
  phone: string;
  chipLabel: string;
  unavailable: string;
  noteLabel: (n: number, title: string | null) => string;
  showMarks: boolean;
  pulse: string | null;
  onPulse: (anchorId: string) => void;
  caption: ReactNode;
  footnote: ReactNode;
  loading: ReactNode;
}

interface Placed {
  positions: Record<string, { left: number; top: number; width: number }>;
  arrows: ArrowSpec[];
  width: number;
  height: number;
}

export function DesktopStatement({
  layout,
  notes,
  notesFailed,
  label,
  phone,
  chipLabel,
  unavailable,
  noteLabel,
  showMarks,
  pulse,
  onPulse,
  caption,
  footnote,
  loading,
}: Props) {
  const deskRef = useRef<HTMLDivElement>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLLIElement>());
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [paperWidth, setPaperWidth] = useState(0);

  const measure = useCallback(() => {
    const desk = deskRef.current;
    const paper = paperRef.current;
    if (!desk || !paper || !leftRef.current || !rightRef.current || !layout) return;
    const d = desk.getBoundingClientRect();
    const p = paper.getBoundingClientRect();
    setPaperWidth(p.width);
    if (!notes?.length) {
      setPlaced(null);
      return;
    }
    const scale = p.width / layout.width;
    const box = { left: p.left - d.left, top: p.top - d.top };
    const cols = {
      left: leftRef.current.getBoundingClientRect(),
      right: rightRef.current.getBoundingClientRect(),
    };
    const anchors = new Map(layout.anchors.map((a) => [a.id, a]));

    // Size every card to its column first, so its height is the real one.
    const heights = new Map<string, number>();
    for (const note of notes) {
      const li = cardRefs.current.get(note.anchorId);
      const anchor = anchors.get(note.anchorId);
      if (!li || !anchor) continue;
      li.style.width = `${cols[anchor.side].width}px`;
      heights.set(note.anchorId, li.offsetHeight);
    }

    const positions: Placed['positions'] = {};
    const arrows: ArrowSpec[] = [];
    let bottom = d.height;
    for (const side of ['left', 'right'] as const) {
      const col = cols[side];
      const mine = notes
        .map((n) => anchors.get(n.anchorId))
        .filter((a): a is NonNullable<typeof a> => !!a && a.side === side);
      const tops = placeCards(
        mine.map((a) => ({
          id: a.id,
          desiredCenter: box.top + (a.rect.y + a.rect.h / 2) * scale,
          height: heights.get(a.id) ?? 0,
        })),
        GAP,
        box.top + p.height,
      );
      for (const a of mine) {
        const top = tops.get(a.id) ?? 0;
        const h = heights.get(a.id) ?? 0;
        const left = col.left - d.left;
        positions[a.id] = { left, top, width: col.width };
        bottom = Math.max(bottom, top + h);
        const tip = attachPoint(a);
        arrows.push({
          id: a.id,
          from: { x: side === 'left' ? left + col.width + 6 : left - 6, y: top + h / 2 },
          to: { x: box.left + tip.x * scale, y: box.top + tip.y * scale },
          attach: a.attach,
        });
      }
    }
    // Arrows in note order, so they draw in sequence.
    const order = new Map(notes.map((n, i) => [n.anchorId, i]));
    arrows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    setPlaced({ positions, arrows, width: d.width, height: Math.ceil(bottom) });
  }, [layout, notes]);

  useLayoutEffect(() => {
    measure();
    const desk = deskRef.current;
    if (!desk) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(desk);
    let live = true;
    void document.fonts?.ready.then(() => live && measure());
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [measure]);

  const focusNote = (id: string) => {
    const li = cardRefs.current.get(id);
    const card = li?.querySelector<HTMLElement>('.st-card');
    card?.focus({ preventScroll: true });
    li?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    onPulse(id);
  };

  // When the notes can't load: numbered pins on the paper, and a plain message.
  const pins =
    layout && notesFailed && paperWidth
      ? pinPositions(layout.anchors, paperWidth / layout.width, [0, 0, 612, 792])
      : null;

  return (
    <div
      ref={deskRef}
      className={`st-desk${placed ? ' is-placed' : ''}`}
      style={placed ? { minHeight: placed.height } : undefined}
    >
      <div className="st-desk-caption">{caption}</div>
      <div ref={leftRef} className="st-desk-col is-left">
        {notes === null && !notesFailed && <SkeletonCard />}
        {notesFailed && <p className="st-unavailable">{unavailable}</p>}
      </div>
      {layout ? (
        <div ref={paperRef} className="st-paper-wrap">
          <StatementSvg layout={layout} label={label}>
            {showMarks && (
              <Highlights anchors={layout.anchors} pulse={pulse} onSelect={focusNote} />
            )}
          </StatementSvg>
          {pins &&
            layout.anchors.map((a, i) => {
              const at = pins.get(a.id);
              return at ? (
                <span
                  key={a.id}
                  className="st-pin is-static"
                  style={{ left: at.x, top: at.y }}
                  aria-hidden="true"
                >
                  {i + 1}
                </span>
              ) : null;
            })}
        </div>
      ) : (
        <div ref={paperRef} className="st-desk-paper">
          {loading}
        </div>
      )}
      <div ref={rightRef} className="st-desk-col is-right">
        {notes === null && !notesFailed && (
          <>
            <SkeletonCard />
            <SkeletonCard />
          </>
        )}
      </div>
      <div className="st-desk-footnote">{footnote}</div>

      {showMarks && placed && (
        <Arrows arrows={placed.arrows} width={placed.width} height={placed.height} />
      )}

      {notes && notes.length > 0 && (
        <ol className="st-notes-desk">
          {notes.map((note) => {
            const pos = placed?.positions[note.anchorId];
            return (
              <li
                key={note.anchorId}
                ref={(el) => {
                  if (el) cardRefs.current.set(note.anchorId, el);
                  else cardRefs.current.delete(note.anchorId);
                }}
                style={
                  pos
                    ? { left: pos.left, top: pos.top, width: pos.width }
                    : { visibility: 'hidden' }
                }
              >
                <button type="button" className="st-twin" onClick={() => focusNote(note.anchorId)}>
                  {noteLabel(note.n, note.title)}
                </button>
                <NoteCard
                  note={note}
                  phone={phone}
                  chipLabel={chipLabel}
                  pulsing={pulse === note.anchorId}
                  onSelect={() => onPulse(note.anchorId)}
                />
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="st-card st-card-skeleton" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}
