/**
 * Rehearse the hero moment: mark a balance paid via the dev-only endpoint.
 *
 *   pnpm simulate:payment "Samuel Ortiz"
 *   pnpm simulate:payment 12
 */
import type { BalanceRow } from '../src/contract';
import { loadConfig } from '../src/env';

const target = process.argv.slice(2).join(' ').trim();
if (!target) {
  console.error('Usage: pnpm simulate:payment "<patient name>" | <balance id>');
  process.exit(1);
}

const config = loadConfig();
const base = process.env.API_URL ?? `http://127.0.0.1:${config.port}/api`;
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const rows = (await (await fetch(`${base}/balances`)).json()) as BalanceRow[];
const row = /^\d+$/.test(target)
  ? rows.find((r) => r.id === Number(target))
  : rows.find((r) => fold(r.patientName) === fold(target));
if (!row) {
  console.error(`No balance matches "${target}". Is the API running and seeded?`);
  process.exit(1);
}

const res = await fetch(`${base}/dev/simulate-payment/${row.id}`, { method: 'POST' });
const body = (await res.json()) as { message?: string; balance?: BalanceRow };
if (!res.ok) {
  console.error(`Simulate payment failed (${res.status}): ${body.message ?? 'unknown error'}`);
  process.exit(1);
}
console.log(
  `✓ ${row.patientName} (balance ${row.id}) marked paid via PayPal — watch the dashboard flash.`,
);
