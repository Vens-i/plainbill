/**
 * Patient pay links and sessions.
 *
 * The link carries an unguessable token, but the token alone shows nothing: the patient confirms
 * last name + date of birth, and gets a short-lived, HMAC-signed, HttpOnly session cookie bound to
 * that one invoice.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'pb_pay';
const SESSION_TTL_MS = 30 * 60_000;

/** 24 random bytes → 32 URL-safe characters. */
export function newPayToken(): string {
  return randomBytes(24).toString('base64url');
}

export function payUrl(appBaseUrl: string, token: string): string {
  return `${appBaseUrl}/pay/${token}`;
}

export class PatientSessions {
  private readonly secret: Buffer;

  constructor(
    secret: string | null,
    readonly secureCookies: boolean,
    private readonly ttlMs = SESSION_TTL_MS,
  ) {
    // Without a configured secret, sessions simply don't survive a restart.
    this.secret = secret ? Buffer.from(secret) : randomBytes(32);
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  issue(invoiceId: number, now = Date.now()): { value: string; maxAgeSeconds: number } {
    const payload = `${invoiceId}.${now + this.ttlMs}`;
    return {
      value: `${payload}.${this.sign(payload)}`,
      maxAgeSeconds: Math.floor(this.ttlMs / 1000),
    };
  }

  /** The invoice id the cookie grants access to, or null if missing, forged or expired. */
  read(value: string | undefined, now = Date.now()): number | null {
    const parts = value?.split('.');
    if (!parts || parts.length !== 3) return null;
    const [id, exp, sig] = parts as [string, string, string];
    const expected = Buffer.from(this.sign(`${id}.${exp}`));
    const given = Buffer.from(sig);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    if (!(Number(exp) > now)) return null;
    const invoiceId = Number(id);
    return Number.isSafeInteger(invoiceId) ? invoiceId : null;
  }

  cookieHeader(value: string, maxAgeSeconds: number): string {
    return [
      `${SESSION_COOKIE}=${value}`,
      'Path=/api/pay',
      `Max-Age=${maxAgeSeconds}`,
      'HttpOnly',
      'SameSite=Lax',
      ...(this.secureCookies ? ['Secure'] : []),
    ].join('; ');
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

/** "O'Neil-Reyes" and "oneil reyes" match; accents don't matter. */
export function normalizeLastName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}
