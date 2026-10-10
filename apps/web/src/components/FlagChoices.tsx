/**
 * The readings for one AI-flagged field, each marked with whether the claim adds up with it.
 * The math comes from @plainbill/core on the server; this only lets staff pick.
 */
import { useState, type FormEvent } from 'react';
import type { IntakeFlagView } from '@plainbill/api/contract';

interface Props {
  flag: IntakeFlagView;
  busy?: boolean;
  onChoose: (value: string) => void;
}

export function FlagChoices({ flag, busy, onChoose }: Props) {
  const [custom, setCustom] = useState('');
  const options = [flag.current, ...flag.alternatives];
  const anyReconciles = options.some((o) => o.reconciles);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (custom.trim()) onChoose(custom.trim());
  };

  return (
    <div className="flag-choices">
      <div className="flag-choices-head">
        <span className="flag-q" aria-hidden="true">
          ?
        </span>
        <div>
          <div className="flag-choices-title">{flag.label}</div>
          <div className="flag-choices-note">
            {flag.problem ?? flag.note ?? 'The AI was not sure about this field.'} · confidence{' '}
            {Math.round(flag.confidence * 100)}%
          </div>
        </div>
      </div>
      <ul className="flag-options">
        {options.map((o, i) => (
          <li key={`${o.value}-${i}`} className={o.reconciles ? 'adds-up' : 'no-add'}>
            <span className="flag-option-value">{o.display}</span>
            <span className="flag-option-tag">
              {o.reconciles ? '✓ adds up' : '✗ doesn’t add up'}
            </span>
            <button
              type="button"
              className="btn btn-small"
              disabled={busy}
              onClick={() => onChoose(o.value)}
            >
              {i === 0 ? 'Confirm' : 'Use this'}
            </button>
          </li>
        ))}
      </ul>
      {flag.kind === 'money' && !anyReconciles && (
        <p className="flag-choices-warn">
          None of these readings make the claim add up. Check the EOB and type the amount.
        </p>
      )}
      <form className="flag-custom" onSubmit={submit}>
        <label className="visually-hidden" htmlFor={`custom-${flag.path}`}>
          Type a different value
        </label>
        <input
          id={`custom-${flag.path}`}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder={
            flag.kind === 'money' ? 'Type the amount, e.g. 260.00' : 'Type what the EOB says'
          }
        />
        <button type="submit" className="btn btn-small" disabled={busy || !custom.trim()}>
          Use
        </button>
      </form>
    </div>
  );
}
