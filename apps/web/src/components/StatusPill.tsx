import { STATUS_META, type BalanceStatus } from '@plainbill/core';
import { STATUS_COLORS } from '../theme';

/** Every status is icon + label + color, never color alone. */
export function StatusPill({ status }: { status: BalanceStatus }) {
  const meta = STATUS_META[status];
  const c = STATUS_COLORS[status];
  return (
    <span className="status-pill" style={{ background: c.bg, borderColor: c.border, color: c.fg }}>
      <span className="status-icon" style={{ background: c.fg }} aria-hidden="true">
        {meta.icon}
      </span>
      {meta.label}
    </span>
  );
}
