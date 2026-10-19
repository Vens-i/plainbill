/**
 * Patient bill email (artboard 1d): table-based HTML, inline styles, no JS or SVG, so it renders
 * in Gmail and Outlook. Amounts come from the computed balance; the message is the one staff
 * approved in the drawer (already checked for invented figures and medical codes).
 *
 * Minimal PHI: the visit date, the provider and amounts. No services, codes or insurance IDs,
 * and no attachment: the full breakdown and the itemized statement live behind the
 * verification page.
 */
import { formatLongDate, formatMoney, formatMonthDay, type IsoDate } from '@plainbill/core';

/** PayPal's own hosted button image, used as-is (never restyled). */
export const PAYPAL_BUTTON_IMAGE =
  'https://www.paypalobjects.com/webstatic/en_US/i/btn/png/gold-rect-paypal-60px.png';

export interface BillEmailData {
  practice: { name: string; phone: string; hours: string | null; address: string };
  patientFirstName: string;
  /** Staff-approved message (starts with the greeting). */
  message: string;
  /**
   * The message's language. Only the message is translated: the rest of the email (headings,
   * breakdown, buttons) is English for now, so the message paragraphs carry their own `lang`.
   */
  messageLang?: string | null;
  visitDate: IsoDate;
  dueDate: IsoDate;
  billedCents: number;
  discountCents: number;
  /** Null for self-pay visits. */
  insurancePaidCents: number | null;
  /** Patient payments already received (reminders). */
  alreadyPaidCents: number;
  amountDueCents: number;
  selfPay: boolean;
  /** Where the PayPal button goes: PayPal's invoice page, or our pay page without PayPal. */
  paypalUrl: string;
  /** The verification + breakdown page. */
  breakdownUrl: string;
  plansAvailable: boolean;
  partialMinimumCents: number | null;
  /** A reminder for a bill sent earlier (changes the subject line). */
  reminder?: boolean;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const COLORS = {
  discount: '#CFDDDA',
  insurance: '#7FA6A3',
  paid: '#A9D2B2',
  owes: '#1D5C5C',
};

export function billSubject(visitDate: IsoDate, amountDueCents: number, dueDate: IsoDate): string {
  return `Your ${formatMonthDay(visitDate)} visit — ${formatMoney(amountDueCents)} due ${formatMonthDay(dueDate)}`;
}

interface Segment {
  label: string;
  note?: string;
  cents: number;
  color: string;
  sign: '−' | '';
}

function segments(d: BillEmailData): Segment[] {
  const out: Segment[] = [];
  if (d.discountCents > 0) {
    out.push({
      label: d.selfPay ? 'Self-pay discount' : 'Insurance discount',
      note: 'you never pay this',
      cents: d.discountCents,
      color: COLORS.discount,
      sign: '−',
    });
  }
  if ((d.insurancePaidCents ?? 0) > 0) {
    out.push({
      label: 'Paid by your insurance',
      cents: d.insurancePaidCents!,
      color: COLORS.insurance,
      sign: '−',
    });
  }
  if (d.alreadyPaidCents > 0) {
    out.push({
      label: 'Already paid by you',
      cents: d.alreadyPaidCents,
      color: COLORS.paid,
      sign: '−',
    });
  }
  out.push({ label: 'You owe', cents: d.amountDueCents, color: COLORS.owes, sign: '' });
  return out;
}

/** Integer percentages that sum to 100, with every non-zero segment at least 3% wide. */
export function barWidths(cents: number[]): number[] {
  const total = cents.reduce((a, b) => a + b, 0);
  if (total <= 0) return cents.map(() => 0);
  const raw = cents.map((c) => (c / total) * 100);
  const widths = raw.map((r, i) => (cents[i]! > 0 ? Math.max(3, Math.floor(r)) : 0));
  let diff = 100 - widths.reduce((a, b) => a + b, 0);
  // Hand out (or take back) the rounding difference, largest remainders first.
  const order = raw
    .map((r, i) => ({ i, rem: r - Math.floor(r) }))
    .filter(({ i }) => cents[i]! > 0)
    .sort((a, b) => b.rem - a.rem);
  for (let k = 0; diff !== 0 && order.length; k++) {
    const { i } = order[k % order.length]!;
    if (diff > 0) {
      widths[i]! += 1;
      diff -= 1;
    } else if (widths[i]! > 3) {
      widths[i]! -= 1;
      diff += 1;
    }
  }
  return widths;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const paragraphs = (text: string) =>
  text
    .trim()
    .split(/\n{2,}/)
    .map((p) => esc(p).replace(/\n/g, '<br>'));

export function renderBillEmail(d: BillEmailData): RenderedEmail {
  const subject = d.reminder
    ? `Reminder: your ${formatMonthDay(d.visitDate)} visit — ${formatMoney(d.amountDueCents)} balance`
    : billSubject(d.visitDate, d.amountDueCents, d.dueDate);
  const segs = segments(d);
  // The practice's itemized statement lives behind verification on the pay page (never attached).
  const statementUrl = d.breakdownUrl === '#' ? '#' : `${d.breakdownUrl}#statement`;
  const widths = barWidths(segs.map((s) => s.cents));
  const owes = formatMoney(d.amountDueCents);
  const paras = paragraphs(d.message);
  const msgLang = d.messageLang && d.messageLang !== 'en' ? ` lang="${esc(d.messageLang)}"` : '';
  const extras = [
    d.plansAvailable ? 'payment plans available' : null,
    d.partialMinimumCents ? `pay part now (${formatMoney(d.partialMinimumCents)} minimum)` : null,
  ].filter(Boolean);
  const phoneLine = `Questions? Call ${esc(d.practice.name.split(' ')[0]!)} at ${esc(d.practice.phone)}${
    d.practice.hours ? `, ${esc(d.practice.hours)}` : ''
  }.`;

  const bar = segs
    .map((s, i) => {
      if (!widths[i]) return '';
      const first = i === segs.findIndex((_, j) => widths[j]! > 0);
      const last = i === segs.length - 1;
      const radius = `${first ? '6px' : '0'} ${last ? '6px 6px' : '0 0'} ${first ? '6px' : '0'}`;
      return `<td width="${widths[i]}%" style="height:28px;background:${s.color};${first ? '' : 'border-left:2px solid #ffffff;'}border-radius:${radius};font-size:0;line-height:0">&nbsp;</td>`;
    })
    .join('');

  const legend = segs
    .map((s, i) => {
      const total = i === segs.length - 1;
      const cell = `padding:${total ? '9px' : '7px'} 0;${total ? 'border-top:1px solid #E5E1D9;font-weight:700;' : ''}`;
      return `<tr>
<td style="${cell}width:20px"><div style="width:12px;height:12px;border-radius:3px;background:${s.color}"></div></td>
<td style="${cell}">${esc(s.label)}${s.note ? ` <span style="color:#5C6766;font-weight:400">— ${esc(s.note)}</span>` : ''}</td>
<td style="${cell}text-align:right">${s.sign}${formatMoney(s.cents)}</td>
</tr>`;
    })
    .join('');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#F2EFEA">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#F2EFEA"><tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" width="600" style="width:600px;max-width:100%;border-collapse:collapse;font-family:'Figtree',Helvetica,Arial,sans-serif;color:#1C2B2D">
<tr><td style="padding:28px 40px 18px;font-size:18px;font-weight:700;color:#1D5C5C;letter-spacing:-0.01em">${esc(d.practice.name)}</td></tr>
<tr><td style="padding:0 24px">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;background:#FFFFFF;border-radius:12px">
${paras
  .map(
    (p, i) =>
      `<tr><td style="padding:${i === 0 ? '32px' : '0'} 32px ${i === paras.length - 1 ? '24px' : '14px'};font-size:16px;line-height:1.55;color:#1C2B2D"${msgLang}>${p}</td></tr>`,
  )
  .join('\n')}
<tr><td style="padding:0 32px">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;background:#F3F8F7;border-radius:10px"><tr>
<td style="padding:20px 22px"><div style="font-size:14px;color:#3E4A4B">Amount due</div><div style="font-size:40px;font-weight:800;letter-spacing:-0.02em;line-height:1.1">${owes}</div></td>
<td style="padding:20px 22px;text-align:right;vertical-align:bottom"><div style="font-size:14px;color:#3E4A4B">Due by</div><div style="font-size:18px;font-weight:700">${esc(formatLongDate(d.dueDate))}</div></td>
</tr></table>
</td></tr>
<tr><td style="padding:28px 32px 8px;font-size:15px;font-weight:700">How we got to ${owes}</td></tr>
<tr><td style="padding:4px 32px 0">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:separate;border-spacing:0"><tr>${bar}</tr></table>
<div style="font-size:13px;color:#5C6766;margin-top:6px">Full bar = ${formatMoney(d.billedCents)} billed</div>
</td></tr>
<tr><td style="padding:14px 32px 0">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:15px">${legend}</table>
</td></tr>
<tr><td style="padding:28px 32px 10px" align="center">
<a href="${esc(d.paypalUrl)}" style="display:inline-block;text-decoration:none"><img src="${PAYPAL_BUTTON_IMAGE}" width="194" height="60" alt="Pay ${owes} with PayPal" style="display:block;border:0;outline:none"></a>
</td></tr>
<tr><td style="padding:4px 32px 28px;text-align:center;font-size:15px;line-height:1.5"><a href="${esc(d.breakdownUrl)}" style="color:#1D5C5C;font-weight:600">See full breakdown</a>${
    extras.length ? ` <span style="color:#5C6766">· ${esc(extras.join(' · '))}</span>` : ''
  }<br><a href="${esc(statementUrl)}" style="color:#1D5C5C">View your itemized statement</a></td></tr>
</table>
</td></tr>
<tr><td style="padding:20px 40px 32px;font-size:13px;line-height:1.55;color:#5C6766">${phoneLine} For your privacy, visit details are only shown after you verify on the secure page.<br>${esc(d.practice.name)} · ${esc(d.practice.address)}</td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = [
    d.message.trim(),
    '',
    `Amount due: ${owes} (due ${formatLongDate(d.dueDate)})`,
    '',
    `How we got to ${owes}:`,
    `  Billed: ${formatMoney(d.billedCents)}`,
    ...segs.map((s) => `  ${s.label}: ${s.sign}${formatMoney(s.cents)}`),
    '',
    `Pay with PayPal: ${d.paypalUrl}`,
    `See the full breakdown${extras.length ? ` (${extras.join(', ')})` : ''}: ${d.breakdownUrl}`,
    `View your itemized statement: ${statementUrl}`,
    '',
    `${phoneLine} For your privacy, visit details are only shown after you verify on the secure page.`,
    `${d.practice.name} · ${d.practice.address}`,
  ].join('\n');

  return { subject, html, text };
}

// ── Delivery ────────────────────────────────────────────────────────────────

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface Mailer {
  readonly provider: 'resend' | 'outbox';
  /** Returns the provider's message id. */
  send(email: OutgoingEmail): Promise<string | null>;
}

/** No email provider configured: the email is stored and viewable at /email-preview/:id. */
export class OutboxMailer implements Mailer {
  readonly provider = 'outbox' as const;
  async send(): Promise<string | null> {
    return null;
  }
}

export class EmailError extends Error {
  override name = 'EmailError';
}

/** Resend's REST API (https://resend.com/docs/api-reference/emails/send-email). */
export class ResendMailer implements Mailer {
  readonly provider = 'resend' as const;
  constructor(private readonly options: { apiKey: string; from: string; fetch?: typeof fetch }) {}

  async send(email: OutgoingEmail): Promise<string | null> {
    const res = await (this.options.fetch ?? fetch)('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.options.from,
        to: [email.to],
        subject: email.subject,
        html: email.html,
        text: email.text,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok) throw new EmailError(body.message ?? `Resend rejected the email (${res.status}).`);
    return body.id ?? null;
  }
}
