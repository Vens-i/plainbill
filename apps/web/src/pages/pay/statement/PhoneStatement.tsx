/**
 * Phone (< 1200 px): the statement as a full-width thumbnail with a numbered pin beside each
 * line, the active line highlighted, a zoom strip showing that line at 1.6×, and one note at a
 * time with Previous / "4 of 6" / Next. Tap a pin to jump to its note; swipe the card to step.
 */
import { useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import type { StatementLayout, StatementNote } from '@plainbill/api/contract';
import { dropArrow, PHONE_CROP, pinPositions, stripCrop } from './geometry';
import { Highlights } from './Highlights';
import { NoteCard } from './NoteCard';
import { StatementSvg } from './StatementSvg';

const STRIP_HEIGHT = 64;
/** The zoom strip draws the paper at 1.6 screen pixels per printed point (about 3 rows tall). */
const ZOOM = 1.6;

export interface PhoneStrings {
  chipLabel: string;
  previous: string;
  next: string;
  /** "4 of 6" */
  position: (n: number, total: number) => string;
  /** "Note 4: A discount, not a bill" */
  pinLabel: (n: number, title: string | null) => string;
  /** "Close-up of your bill: CO45 −400.00" */
  stripLabel: (quote: string) => string;
  unavailable: string;
}

interface Props {
  layout: StatementLayout;
  /** Null while loading; [] when the notes couldn't be loaded. */
  notes: StatementNote[] | null;
  label: string;
  phone: string;
  strings: PhoneStrings;
  showMarks: boolean;
  active: number;
  onActive: (index: number) => void;
  pulse: string | null;
  onPulse: (anchorId: string) => void;
  /** Under the pager (the "Ask about this bill" link). */
  below?: ReactNode;
}

export function PhoneStatement({
  layout,
  notes,
  label,
  phone,
  strings,
  showMarks,
  active,
  onActive,
  pulse,
  onPulse,
  below,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ thumb: DOMRect; strip: DOMRect; root: DOMRect } | null>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      if (!rootRef.current || !thumbRef.current || !stripRef.current) return;
      setSize({
        root: rootRef.current.getBoundingClientRect(),
        thumb: thumbRef.current.getBoundingClientRect(),
        strip: stripRef.current.getBoundingClientRect(),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (rootRef.current) observer.observe(rootRef.current);
    return () => observer.disconnect();
  }, []);

  const anchors = layout.anchors;
  const total = anchors.length;
  const index = Math.min(active, total - 1);
  const anchor = anchors[index]!;
  const note = notes?.find((n) => n.anchorId === anchor.id) ?? null;
  const scale = size ? size.thumb.width / PHONE_CROP[2] : 0;
  const pins = scale ? pinPositions(anchors, scale) : new Map();
  const stripScale = scale ? ZOOM : 0;
  const stripWidth = size ? size.strip.width - 4 : 0;
  const crop = stripScale
    ? stripCrop(anchor.rect, stripWidth / stripScale, STRIP_HEIGHT / stripScale)
    : null;

  // The short arrow from the active mark down into the zoom strip.
  let drop: { line: string; head: string } | null = null;
  if (size && scale && showMarks) {
    const offX = size.thumb.left - size.root.left;
    const offY = size.thumb.top - size.root.top;
    const r = anchor.rect;
    const from = {
      x: offX + (r.x + Math.min(r.w, 400) * 0.55 - PHONE_CROP[0]) * scale,
      y: offY + (r.y + r.h - PHONE_CROP[1]) * scale + 3,
    };
    const to = {
      x: size.strip.left - size.root.left + size.strip.width * 0.55,
      y: size.strip.top - size.root.top - 2,
    };
    // Only a short arrow: from a line far up the page it would cross the whole statement.
    if (to.y - from.y > 16 && to.y - from.y < 200) drop = dropArrow(from, to, anchor.id);
  }

  const go = (i: number) => onActive(Math.max(0, Math.min(total - 1, i)));
  const onPointerDown = (e: PointerEvent) => {
    swipe.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: PointerEvent) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start) return;
    const dx = e.clientX - start.x;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(e.clientY - start.y))
      go(index + (dx < 0 ? 1 : -1));
  };

  return (
    <div ref={rootRef} className="st-phone">
      <div ref={thumbRef} className="st-thumb">
        <div className="st-paper-wrap">
          <StatementSvg layout={layout} crop={PHONE_CROP} label={label}>
            {showMarks && <Highlights anchors={anchors} only={[anchor.id]} pulse={pulse} />}
          </StatementSvg>
        </div>
        {anchors.map((a, i) => {
          const at = pins.get(a.id);
          if (!at) return null;
          const n = i + 1;
          const title = notes?.find((x) => x.anchorId === a.id)?.title ?? null;
          return (
            <button
              key={a.id}
              type="button"
              className={`st-pin${i === index ? ' is-active' : ''}`}
              style={{ left: at.x, top: at.y }}
              aria-label={strings.pinLabel(n, title)}
              aria-pressed={i === index}
              onClick={() => {
                go(i);
                onPulse(a.id);
              }}
            >
              {n}
            </button>
          );
        })}
      </div>

      <div
        ref={stripRef}
        className="st-strip"
        role="img"
        aria-label={strings.stripLabel(anchor.quote)}
      >
        {crop && (
          <StatementSvg layout={layout} crop={crop} label="" decorative>
            {showMarks && <Highlights anchors={anchors} only={[anchor.id]} />}
          </StatementSvg>
        )}
      </div>

      {drop && size && (
        <svg
          className="st-drop"
          width={size.root.width}
          height={size.root.height}
          aria-hidden="true"
        >
          <path className="st-arrow-line" d={drop.line} />
          <path className="st-arrow-head" d={drop.head} />
        </svg>
      )}

      <div className="st-phone-card" onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
        {note ? (
          <ol className="st-phone-list" start={note.n}>
            <li>
              <NoteCard note={note} phone={phone} chipLabel={strings.chipLabel} tilt={false} />
            </li>
          </ol>
        ) : notes === null ? (
          <div className="st-card st-card-skeleton" aria-busy="true">
            <span />
            <span />
            <span />
          </div>
        ) : (
          <p className="st-unavailable">{strings.unavailable}</p>
        )}
        <div className="st-pager">
          <button
            type="button"
            className="st-pager-btn"
            onClick={() => go(index - 1)}
            disabled={index === 0}
          >
            {strings.previous}
          </button>
          <span className="st-pager-pos" aria-live="polite">
            {strings.position(index + 1, total)}
          </span>
          <button
            type="button"
            className="st-pager-btn is-next"
            onClick={() => go(index + 1)}
            disabled={index === total - 1}
          >
            {strings.next}
          </button>
        </div>
        {below}
      </div>
    </div>
  );
}
