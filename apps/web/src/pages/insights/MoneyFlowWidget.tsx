/**
 * "Where every dollar went": the Practice insights focal point, a custom AG Studio widget.
 *
 * Every billed dollar flows left to right into where it ended up, with particles moving along
 * each stream in proportion to the money. It reads balances through Studio's data engine, so
 * page filters reshape it; clicking a stage (an age bucket, Denied) cross-filters the rest of
 * the report (the selection shows above the chart, with a way to clear it); hovering a stage or
 * stream traces it and dims the rest; and when a payment lands, the streams re-balance and a coin
 * travels from what was owed into Collected. Amounts are the core's, summed in cents (flow.ts);
 * nothing is estimated.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AgWidgetField, AgWidgetParams } from 'ag-studio';
import { formatMoneyShort } from '@plainbill/core';
import {
  bezierPoint,
  buildFlow,
  labelKeepOut,
  layoutFlow,
  particleCount,
  tweenFlow,
  type Box,
  type FlowLayout,
  type FlowModel,
  type FlowNode,
  type FlowNodeId,
  type FlowRow,
  type LinkShape,
  type NodeBox,
} from './flow';

const FIELDS = [
  'balanceId',
  'status',
  'billed',
  'insuranceDiscount',
  'insurancePaid',
  'patientShare',
  'patientPaid',
  'stillOwed',
  'aging',
] as const;

const TWEEN_MS = 900;
const TRIP_MS = 3400;
const $ = (cents: number) => formatMoneyShort(cents);

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      setSize({ width: Math.round(width), height: Math.round(height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

/** Deterministic pseudo-random in [0, 1) per stream and particle, so particles don't jump. */
function hash(text: string, i: number): number {
  let h = 2166136261 ^ i;
  for (let k = 0; k < text.length; k++) h = Math.imul(h ^ text.charCodeAt(k), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
}

/** What's being traced: a hovered stream, or a hovered, focused or selected stage. */
type Hot = { link: string } | { node: FlowNodeId } | null;

/** The streams a trace lights up: the stream itself, or every stream into and out of the stage. */
function hotLinks(hot: Hot, layout: FlowLayout | null): Set<string> {
  if (!hot || !layout) return new Set();
  if ('link' in hot) return new Set([hot.link]);
  return new Set(
    layout.links
      .filter((l) => l.link.from === hot.node || l.link.to === hot.node)
      .map((l) => l.link.id),
  );
}

const pct = (cents: number, of: number) => (of > 0 ? `${Math.round((cents / of) * 100)}%` : '');

interface Burst {
  key: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
  cents: number;
}

export function MoneyFlowWidget(params: AgWidgetParams) {
  const { widgetApi } = params;
  const clipId = useId().replace(/:/g, '');
  const [frame, size] = useSize<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [target, setTarget] = useState<FlowModel | null>(null);
  const [shown, setShown] = useState<FlowModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<{ text: string; x: number; y: number } | null>(null);
  const [selected, setSelected] = useState<FlowNodeId | null>(null);
  const [traced, setTraced] = useState<Hot>(null);
  const [burst, setBurst] = useState<Burst | null>(null);
  const fieldsRef = useRef<Map<string, AgWidgetField>>(new Map());
  const reduced = useMemo(prefersReducedMotion, []);

  // Load (and reload whenever Studio refreshes the widget: filters, data, layout).
  const load = useCallback(async () => {
    const table = widgetApi.getSchema().find((t) => t.id === 'balances');
    const fields = FIELDS.map((id) =>
      table?.fields.find((f) => String(f.fieldId) === `balances.${id}`),
    );
    if (fields.some((f) => !f)) {
      widgetApi.setDisplayState('incompleteDataMapping');
      return;
    }
    const found = fields as AgWidgetField[];
    fieldsRef.current = new Map(found.map((f) => [String(f.fieldId), f]));
    const result = await widgetApi.getData({ fields: found }, { queryId: 'money-flow' });
    const rows: FlowRow[] = result.results.rows.map((r) => {
      const get = (i: number) => r[found[i]!.key];
      return {
        balanceId: Number(get(0)),
        status: String(get(1)),
        billed: Number(get(2)),
        insuranceDiscount: Number(get(3)),
        insurancePaid: Number(get(4)),
        patientShare: Number(get(5)),
        patientPaid: Number(get(6)),
        stillOwed: Number(get(7)),
        aging: String(get(8)),
      };
    });
    try {
      const model = buildFlow(rows);
      setError(null);
      setTarget(model);
      widgetApi.setDisplayState(model.nodes.length ? 'displayed' : 'noData');
    } catch (err) {
      setError((err as Error).message);
    }
  }, [widgetApi]);

  useEffect(() => {
    void load();
    // Studio passes new params on every refresh (filters, data, layout): reload then.
  }, [load, params]);

  // Tween from what's on screen to the new numbers; spot a payment to animate.
  const previous = useRef<FlowModel | null>(null);
  useEffect(() => {
    if (!target) return;
    const from = previous.current;
    previous.current = target;
    if (!from || reduced) {
      setShown(target);
      return;
    }
    const collected = (m: FlowModel) => m.nodes.find((n) => n.id === 'collected')?.cents ?? 0;
    const delta = collected(target) - collected(from);
    if (delta > 0 && size.width > 0) {
      const before = layoutFlow(from, size);
      const after = layoutFlow(target, size);
      const owed = before.nodes
        .filter((b) => b.node.id.startsWith('owed'))
        .map((b) => ({
          b,
          drop: b.node.cents - (target.nodes.find((n) => n.id === b.node.id)?.cents ?? 0),
        }))
        .sort((x, y) => y.drop - x.drop)[0];
      const into = after.nodes.find((b) => b.node.id === 'collected');
      if (owed && owed.drop > 0 && into) {
        setBurst({
          key: Date.now(),
          from: { x: owed.b.x + owed.b.w / 2, y: owed.b.y + owed.b.h / 2 },
          to: { x: into.x + into.w / 2, y: into.y + into.h / 2 },
          cents: delta,
        });
      }
    }
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / TWEEN_MS);
      const eased = 1 - (1 - t) ** 3;
      setShown(t < 1 ? tweenFlow(from, target, eased) : target);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const layout: FlowLayout | null = useMemo(
    () => (shown && size.width > 0 && size.height > 0 ? layoutFlow(shown, size) : null),
    [shown, size],
  );

  // Where the labels are, so particles stay out of them (the canvas is drawn above the SVG).
  const keepOut = useRef<Box[]>([]);
  useLayoutEffect(() => {
    const labels = frame.current?.querySelectorAll<SVGTextElement>('.flow-label') ?? [];
    keepOut.current = labelKeepOut([...labels].map((t) => t.getBBox()));
  });

  // Hovering wins; otherwise the cross-filter selection stays traced.
  const hot: Hot = useMemo(
    () => traced ?? (selected ? { node: selected } : null),
    [traced, selected],
  );
  const lit = useMemo(() => hotLinks(hot, layout), [hot, layout]);

  // Particles on a canvas over the ribbons. The canvas only exists once there is a layout.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const litRef = useRef(lit);
  litRef.current = lit;
  const hasLayout = layout !== null;
  useEffect(() => {
    const el = canvas.current;
    if (!el || reduced) return;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    const draw = (now: number) => {
      const l = layoutRef.current;
      const dpr = window.devicePixelRatio || 1;
      if (l && (el.width !== l.width * dpr || el.height !== l.height * dpr)) {
        el.width = l.width * dpr;
        el.height = l.height * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, el.width, el.height);
      if (l) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, l.width, l.height);
        for (const b of keepOut.current) ctx.rect(b.x, b.y, b.width, b.height);
        ctx.clip('evenodd');
        const focus = litRef.current;
        for (const shape of l.links) {
          const dim = focus.size > 0 && !focus.has(shape.link.id);
          drawParticles(ctx, shape, now, dim ? 0.12 : 0.6);
        }
        ctx.restore();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [reduced, hasLayout]);

  const toggle = (node: FlowNode) => {
    if (!node.filter) return;
    const field = fieldsRef.current.get(node.filter.field);
    if (!field) return;
    widgetApi.toggleCrossFilter({ type: 'value', group: 0, field, value: node.filter.value });
    setSelected((s) => (s === node.id ? null : node.id));
  };
  const selectedNode = target?.nodes.find((n) => n.id === selected) ?? null;

  const settled = shown === target;
  const billedNow = shown?.nodes.find((n) => n.id === 'billed')?.cents ?? 0;
  const isLit = (id: FlowNodeId) =>
    hot !== null &&
    (('node' in hot && hot.node === id) ||
      (layout?.links.some((l) => lit.has(l.link.id) && (l.link.from === id || l.link.to === id)) ??
        false));
  const billed = target?.nodes.find((n) => n.id === 'billed')?.cents ?? 0;
  const collected = target?.nodes.find((n) => n.id === 'collected')?.cents ?? 0;
  const owed = (target?.nodes ?? [])
    .filter((n) => n.id.startsWith('owed'))
    .reduce((s, n) => s + n.cents, 0);

  return (
    <div className="flow">
      <p className="flow-summary">
        <strong>{$(billed)}</strong> billed · <strong className="flow-in">{$(collected)}</strong>{' '}
        collected · <strong className="flow-owed">{$(owed)}</strong> still owed
        {selectedNode ? (
          <span className="flow-filter" role="status">
            Filtered to <strong>{selectedNode.label}</strong>
            <button
              type="button"
              className="flow-filter-clear"
              onClick={() => toggle(selectedNode)}
            >
              Clear filter
            </button>
          </span>
        ) : (
          <span className="flow-hint">Hover to trace · click an age or Denied to filter</span>
        )}
      </p>
      <p className="flow-caption">
        Read left to right: every billed dollar ends in exactly one place.
      </p>
      <div className="flow-stage" ref={frame}>
        {error ? (
          <p className="flow-error" role="alert">
            {error}
          </p>
        ) : layout ? (
          <>
            <svg
              className={`flow-svg${reduced ? '' : ' flow-enter'}${lit.size ? ' flow-focus' : ''}`}
              width={layout.width}
              height={layout.height}
              role="img"
              aria-label={`Where every dollar went: ${$(billed)} billed, ${$(collected)} collected, ${$(owed)} still owed.`}
              onMouseLeave={() => {
                setHover(null);
                setTraced(null);
              }}
            >
              <defs>
                <clipPath id={clipId}>
                  <rect
                    className="flow-reveal"
                    x="0"
                    y="0"
                    width={layout.width}
                    height={layout.height}
                  />
                </clipPath>
              </defs>
              <g clipPath={`url(#${clipId})`}>
                {layout.links.map((l) => (
                  <path
                    key={l.link.id}
                    d={l.path}
                    className={`flow-link${lit.has(l.link.id) ? ' flow-hot' : ''}`}
                    style={{ '--tint': l.tint, '--color': l.color } as React.CSSProperties}
                    onMouseEnter={() => setTraced({ link: l.link.id })}
                    onMouseMove={(e) =>
                      setHover({
                        text: `${label(l.link.from, layout)} → ${label(l.link.to, layout)}: ${$(l.link.cents)} · ${pct(l.link.cents, billedNow)} of billed · ${l.link.visits} ${l.link.visits === 1 ? 'visit' : 'visits'}`,
                        x: e.nativeEvent.offsetX,
                        y: e.nativeEvent.offsetY,
                      })
                    }
                  />
                ))}
              </g>
              {layout.nodes.map((b) => (
                <g
                  key={b.node.id}
                  className={`flow-node${b.node.filter ? ' flow-clickable' : ''}${selected === b.node.id ? ' flow-selected' : ''}${isLit(b.node.id) ? ' flow-node-hot' : ''}`}
                  onClick={() => toggle(b.node)}
                  onMouseEnter={() => setTraced({ node: b.node.id })}
                  onFocus={() => setTraced({ node: b.node.id })}
                  onBlur={() => setTraced(null)}
                  onMouseMove={(e) =>
                    setHover({
                      text: `${b.node.label}: ${$(b.node.cents)}${b.node.column > 0 ? ` · ${pct(b.node.cents, billedNow)} of billed` : ''} · ${b.node.visits} ${b.node.visits === 1 ? 'visit' : 'visits'}${b.node.filter ? (selected === b.node.id ? ' · click to clear the filter' : ' · click to filter') : ''}`,
                      x: e.nativeEvent.offsetX,
                      y: e.nativeEvent.offsetY,
                    })
                  }
                  {...(b.node.filter
                    ? {
                        role: 'button',
                        tabIndex: 0,
                        'aria-pressed': selected === b.node.id,
                        'aria-label': `${b.node.label}, ${$(b.node.cents)}. Filter the report.`,
                        onKeyDown: (e: React.KeyboardEvent) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            toggle(b.node);
                          }
                        },
                      }
                    : {})}
                >
                  {b.node.filter && (
                    // Thin stages are hard to hit: the bar and its label are one target, 22px+ tall.
                    <rect
                      className="flow-hit"
                      x={b.x - 4}
                      y={b.y + b.h / 2 - Math.max(11, b.h / 2)}
                      width={b.w + 200}
                      height={Math.max(22, b.h)}
                      fill="transparent"
                    />
                  )}
                  <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={3} fill={b.node.color} />
                  <text className="flow-label" {...labelAt(b, layout)} dominantBaseline="middle">
                    <tspan className="flow-label-name" style={{ fill: b.node.ink }}>
                      {b.node.label}
                    </tspan>
                    <tspan className="flow-label-amount" dx="6">
                      {/* Whole dollars while streams are moving; exact once they settle. */}
                      {$(settled ? b.node.cents : Math.round(b.node.cents / 100) * 100)}
                    </tspan>
                    {b.node.column === 1 && (
                      <tspan className="flow-label-pct" dx="6">
                        {pct(b.node.cents, billedNow)}
                      </tspan>
                    )}
                  </text>
                </g>
              ))}
            </svg>
            <canvas
              ref={canvas}
              className="flow-particles"
              style={{ width: layout.width, height: layout.height }}
              aria-hidden="true"
            />
            {burst && (
              <span
                key={burst.key}
                className="flow-coin"
                style={
                  {
                    '--from-x': `${burst.from.x}px`,
                    '--from-y': `${burst.from.y}px`,
                    '--to-x': `${burst.to.x}px`,
                    '--to-y': `${burst.to.y}px`,
                  } as React.CSSProperties
                }
                onAnimationEnd={() => setBurst(null)}
              >
                <span className="flow-coin-label">+{$(burst.cents)} collected</span>
              </span>
            )}
            {hover && (
              <span className="flow-tip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
                {hover.text}
              </span>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Where a stage's label goes: left of Billed; right of the other stages, except a stage with
 * streams leaving it (the patient share), whose label sits just above it, clear of the streams.
 */
function labelAt(b: NodeBox, layout: FlowLayout) {
  if (b.node.column === 0) {
    return { x: b.x - 10, y: b.y + b.h / 2, textAnchor: 'end' as const };
  }
  if (layout.links.some((l) => l.link.from === b.node.id)) {
    return { x: b.x, y: b.y - 11, textAnchor: 'start' as const };
  }
  return { x: b.x + b.w + 8, y: b.y + b.h / 2, textAnchor: 'start' as const };
}

function label(id: FlowNodeId, layout: FlowLayout): string {
  return layout.nodes.find((b) => b.node.id === id)?.node.label ?? id;
}

function drawParticles(
  ctx: CanvasRenderingContext2D,
  shape: LinkShape,
  now: number,
  alpha: number,
) {
  const n = particleCount(shape.link);
  const spread = Math.max(0, shape.thickness / 2 - 2.5);
  ctx.fillStyle = shape.color;
  for (let i = 0; i < n; i++) {
    const phase = hash(shape.link.id, i);
    const lane = (hash(shape.link.id, i + 97) - 0.5) * 2 * spread * 0.85;
    const speed = 0.85 + hash(shape.link.id, i + 31) * 0.3;
    const t = ((now / TRIP_MS) * speed + phase) % 1;
    const p = bezierPoint(shape.curve, t);
    // Fade in and out at the ends so particles appear to come out of the nodes.
    ctx.globalAlpha = Math.min(1, t * 6, (1 - t) * 6) * alpha;
    ctx.beginPath();
    ctx.arc(p.x, p.y + lane, shape.thickness > 10 ? 2 : 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** The widget's registration with AG Studio. */
export const moneyFlowWidget = {
  id: 'money-flow',
  label: 'Where every dollar went',
  dataMapping: {},
  form: (params: { createDefaults: (p: object) => unknown }) =>
    params.createDefaults({ dataMappingItems: [] }),
  comp: MoneyFlowWidget,
  defaultSize: { width: 960, height: 380 },
  minSize: { width: 520, height: 260 },
};
