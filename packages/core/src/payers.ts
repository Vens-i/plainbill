/**
 * Payer display names. 835 files carry whatever the payer typed into N1*PR ("BLUECROSS
 * BLUESHIELD"); the UI wants a consistent name and a short form for tight spaces (charts).
 */
export interface PayerInfo {
  id: string;
  name: string;
  shortName: string;
  kind: 'insurance' | 'self-pay';
}

export const SELF_PAY: PayerInfo = {
  id: 'SELF',
  name: 'Self-pay',
  shortName: 'Self-pay',
  kind: 'self-pay',
};

const KNOWN: Array<{ match: RegExp; info: PayerInfo }> = [
  {
    match: /\bblue\s*cross\b|\bbcbs\b/i,
    info: { id: 'BCBS', name: 'BlueCross BlueShield', shortName: 'BlueCross', kind: 'insurance' },
  },
  {
    match: /\bunited\s*health|\buhc\b/i,
    info: { id: 'UHC', name: 'UnitedHealthcare', shortName: 'UnitedHealth', kind: 'insurance' },
  },
  {
    match: /\baetna\b/i,
    info: { id: 'AETNA', name: 'Aetna', shortName: 'Aetna', kind: 'insurance' },
  },
];

export function titleCase(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/(^|[\s'-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

export function normalizePayer(rawName: string): PayerInfo {
  if (/^self[\s-]?pay$/i.test(rawName.trim())) return SELF_PAY;
  const known = KNOWN.find((k) => k.match.test(rawName));
  if (known) return known.info;
  const name = titleCase(rawName);
  return { id: rawName.trim().toUpperCase(), name, shortName: name, kind: 'insurance' };
}
