/**
 * Highlighter marks and hand-drawn loops on the statement, one per anchor, drawn inside the
 * statement's SVG (same coordinates as the paper). Decorative: the notes list carries the
 * meaning, so this layer is hidden from assistive tech.
 */
import type { Anchor } from '@plainbill/api/contract';
import { highlightShape, loopPath } from './geometry';

interface Props {
  anchors: Anchor[];
  /** Only these anchors are marked (the phone marks just the active one). Default: all. */
  only?: string[];
  /** The anchor whose mark pulses (its note was just clicked). */
  pulse?: string | null;
  /** Called when a mark is clicked. */
  onSelect?: (id: string) => void;
}

export function Highlights({ anchors, only, pulse, onSelect }: Props) {
  return (
    <g className="st-marks" aria-hidden="true">
      {anchors.map((a, i) => {
        if (only && !only.includes(a.id)) return null;
        const pulsing = pulse === a.id ? ' is-pulsing' : '';
        if (a.style === 'loop') {
          return (
            <path
              key={a.id}
              className={`st-loop${pulsing}`}
              style={{ ['--i' as string]: i }}
              d={loopPath(a)}
              data-anchor={a.id}
              onClick={onSelect ? () => onSelect(a.id) : undefined}
            />
          );
        }
        const s = highlightShape(a);
        return (
          <rect
            key={a.id}
            className={`st-highlight${pulsing}`}
            style={{ ['--i' as string]: i }}
            x={s.x}
            y={s.y}
            width={s.w}
            height={s.h}
            rx={s.rx}
            ry={s.ry}
            transform={`rotate(${s.rotate} ${s.x + s.w / 2} ${s.y + s.h / 2})`}
            data-anchor={a.id}
            onClick={onSelect ? () => onSelect(a.id) : undefined}
          />
        );
      })}
    </g>
  );
}
