/**
 * Note bodies arrive as plain text. The page adds exactly two things, with no HTML from the
 * server or the model: dollar amounts in bold, and the practice's phone number as a tap-to-call
 * link.
 */
export type NotePart =
  | { kind: 'text'; text: string }
  | { kind: 'money'; text: string }
  | { kind: 'phone'; text: string; href: string };

const MONEY = String.raw`\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\$\s?\d+(?:\.\d{2})?`;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function noteParts(body: string, phone: string | null): NotePart[] {
  const pattern = new RegExp(`(${MONEY})${phone ? `|(${escape(phone)})` : ''}`, 'g');
  const parts: NotePart[] = [];
  let last = 0;
  for (const m of body.matchAll(pattern)) {
    if (m.index > last) parts.push({ kind: 'text', text: body.slice(last, m.index) });
    if (m[1]) parts.push({ kind: 'money', text: m[1] });
    else parts.push({ kind: 'phone', text: m[2]!, href: `tel:${m[2]!.replace(/\D/g, '')}` });
    last = m.index + m[0].length;
  }
  if (last < body.length) parts.push({ kind: 'text', text: body.slice(last) });
  return parts;
}
