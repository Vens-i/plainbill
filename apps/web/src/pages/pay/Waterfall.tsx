/**
 * The "how we got to $240" waterfall: billed, then each amount taken off, then what's left. Bars
 * are buttons; the selected one explains itself below (copy from the API, amounts from the core).
 */
import { useState } from 'react';
import type { WaterfallStep } from '@plainbill/api/contract';
import { formatMoneyShort } from '@plainbill/core';

const CHART_PX = 200;

const FILL: Record<WaterfallStep['key'], string> = {
  billed: 'wf-billed',
  discount: 'wf-discount',
  insurance: 'wf-insurance',
  paid: 'wf-paid',
  owes: 'wf-owes',
};

export function Waterfall({ steps }: { steps: WaterfallStep[] }) {
  const [selected, setSelected] = useState(steps.length - 1);
  const top = Math.max(1, steps[0]?.amountCents ?? 1);
  const px = (cents: number) => Math.round((Math.abs(cents) / top) * CHART_PX);

  // Running level after each step: bars taken off float between the old and new level.
  let level = top;
  const bars = steps.map((s, i) => {
    if (i === 0 || s.key === 'owes') {
      return { bottom: 0, height: Math.max(2, px(s.amountCents)), connector: px(s.amountCents) };
    }
    const after = level + s.amountCents; // amountCents is negative here
    const bar = { bottom: px(after), height: Math.max(2, px(s.amountCents)), connector: px(after) };
    level = after;
    return bar;
  });
  const current = steps[selected]!;

  return (
    <div className="wf">
      <div className="wf-chart" role="group" aria-label="How the bill was calculated">
        {steps.map((s, i) => {
          const bar = bars[i]!;
          const last = i === steps.length - 1;
          return (
            <button
              key={s.key}
              type="button"
              className={`wf-col${i === selected ? ' is-selected' : ''}`}
              aria-pressed={i === selected}
              aria-label={s.title}
              onClick={() => setSelected(i)}
            >
              <span
                className="wf-value"
                style={{ bottom: bar.bottom + bar.height + 6 }}
                aria-hidden="true"
              >
                {s.amountCents < 0 ? '−' : ''}
                {formatMoneyShort(Math.abs(s.amountCents))}
              </span>
              <span
                className={`wf-bar ${FILL[s.key]}`}
                style={{ bottom: bar.bottom, height: bar.height }}
                aria-hidden="true"
              />
              {!last && (
                <span
                  className="wf-connector"
                  style={{ bottom: bar.connector - 1 }}
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
      </div>
      <div className="wf-labels" aria-hidden="true">
        {steps.map((s, i) => (
          <span key={s.key} className={i === steps.length - 1 ? 'wf-label-strong' : undefined}>
            {s.label}
          </span>
        ))}
      </div>
      <div className="wf-explain" aria-live="polite">
        <div className="wf-explain-title">{current.title}</div>
        <div className="wf-explain-body">{current.body}</div>
      </div>
    </div>
  );
}
