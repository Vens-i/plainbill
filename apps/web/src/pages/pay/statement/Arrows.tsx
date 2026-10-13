/**
 * Hand-drawn arrows from each note card to its line, in an overlay that covers the whole
 * section. The parent measures the cards and the statement and passes screen coordinates;
 * this layer only draws. Decorative (the notes list is the accessible content).
 */
import type { Anchor } from '@plainbill/api/contract';
import { arrowPath, type Point } from './geometry';

export interface ArrowSpec {
  id: string;
  from: Point;
  to: Point;
  attach: Anchor['attach'];
}

export function Arrows({
  arrows,
  width,
  height,
}: {
  arrows: ArrowSpec[];
  width: number;
  height: number;
}) {
  return (
    <svg
      className="st-arrows"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      {arrows.map((a, i) => {
        const { line, head } = arrowPath(a.from, a.to, a.attach, a.id);
        return (
          <g key={a.id} className="st-arrow" style={{ ['--i' as string]: i }}>
            <path className="st-arrow-line" d={line} pathLength={1} />
            <path className="st-arrow-head" d={head} pathLength={1} />
          </g>
        );
      })}
    </svg>
  );
}
