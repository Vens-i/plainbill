/**
 * The practice's statement, drawn on screen from the same operations as the PDF (PDF points,
 * top-left origin), so highlights and arrows line up with the paper by construction. Pass a
 * `crop` to show part of the page (the phone's zoom strip). Children render inside the same
 * coordinate space, on top of the paper.
 */
import { memo, type ReactNode } from 'react';
import type { Op, StatementLayout } from '@plainbill/api/contract';

const SANS = "Helvetica, Arial, 'Liberation Sans', sans-serif";
// 'Courier New' first: on Windows, plain "Courier" is an old raster font. Same metrics either way.
const MONO = "'Courier New', Courier, 'Liberation Mono', monospace";
const ANCHOR = { left: 'start', right: 'end', center: 'middle' } as const;

function OpElement({ op }: { op: Op }) {
  switch (op.t) {
    case 'text':
      return (
        <text
          x={op.x}
          y={op.y}
          fontFamily={op.font.startsWith('mono') ? MONO : SANS}
          fontWeight={op.font.endsWith('bold') ? 700 : 400}
          fontSize={op.size}
          textAnchor={ANCHOR[op.align ?? 'left']}
          fill={op.color ?? '#1b1d1f'}
        >
          {op.s}
        </text>
      );
    case 'rect':
      return (
        <rect
          x={op.x}
          y={op.y}
          width={op.w}
          height={op.h}
          fill={op.fill ?? 'none'}
          stroke={op.stroke ?? 'none'}
          strokeWidth={op.lineWidth ?? 0.6}
        />
      );
    case 'line':
      return (
        <line
          x1={op.x1}
          y1={op.y1}
          x2={op.x2}
          y2={op.y2}
          stroke={op.color ?? '#1b1d1f'}
          strokeWidth={op.lineWidth ?? 0.6}
          strokeDasharray={op.dash?.join(' ')}
        />
      );
    case 'poly':
      return <polygon points={op.points.map((p) => p.join(',')).join(' ')} fill={op.fill} />;
  }
}

/** The paper itself: hundreds of elements that never change, so render them once. */
const Paper = memo(function Paper({ ops }: { ops: Op[] }) {
  return (
    <g className="st-paper">
      <rect x={0} y={0} width={612} height={792} fill="#fff" />
      {ops.map((op, i) => (
        <OpElement key={i} op={op} />
      ))}
    </g>
  );
});

interface Props {
  layout: StatementLayout;
  /** [x, y, width, height] in PDF points; defaults to the whole page. */
  crop?: [number, number, number, number];
  label: string;
  /** Hide from assistive tech (the zoom strip's copy has its own label elsewhere). */
  decorative?: boolean;
  className?: string;
  children?: ReactNode;
}

export const StatementSvg = function StatementSvg({
  layout,
  crop,
  label,
  decorative,
  className,
  children,
}: Props) {
  const box = crop ?? [0, 0, layout.width, layout.height];
  return (
    <svg
      className={`st-svg${className ? ` ${className}` : ''}`}
      viewBox={box.join(' ')}
      preserveAspectRatio="xMidYMin meet"
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
    >
      <Paper ops={layout.ops} />
      {children}
    </svg>
  );
};
