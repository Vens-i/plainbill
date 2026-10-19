/**
 * Calendar dates are ISO strings ("2026-10-03") with no time zone. All arithmetic happens in
 * UTC so day counts never shift with DST or the server's locale.
 */
export type IsoDate = string;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const MONTHS = MONTH_NAMES.map((name) => name.slice(0, 3));
const DAY_MS = 86_400_000;

function parts(date: IsoDate): [number, number, number] {
  const m = ISO_RE.exec(date);
  if (!m || !isIsoDate(date))
    throw new RangeError(`not an ISO calendar date: ${JSON.stringify(date)}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function toIso(y: number, m: number, d: number): IsoDate {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isIsoDate(value: string): boolean {
  const m = ISO_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

/** X12 CCYYMMDD → ISO. */
export function x12DateToIso(value: string): IsoDate {
  if (!/^\d{8}$/.test(value))
    throw new RangeError(`not an X12 date (CCYYMMDD): ${JSON.stringify(value)}`);
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  if (!isIsoDate(iso)) throw new RangeError(`not a real calendar date: ${JSON.stringify(value)}`);
  return iso;
}

/** ISO → X12 CCYYMMDD. */
export function isoToX12Date(date: IsoDate): string {
  parts(date);
  return date.replaceAll('-', '');
}

function epochDay(date: IsoDate): number {
  const [y, m, d] = parts(date);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

/** Whole days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return epochDay(to) - epochDay(from);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const t = new Date((epochDay(date) + days) * DAY_MS);
  return toIso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Add calendar months, clamping the day to the end of shorter months (Jan 31 + 1 → Feb 28). */
export function addMonths(date: IsoDate, months: number): IsoDate {
  const [y, m, d] = parts(date);
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return toIso(year, month, Math.min(d, daysInMonth(year, month)));
}

/** "2026-10" — used to bucket payments by month. */
export function monthKey(date: IsoDate): string {
  parts(date);
  return date.slice(0, 7);
}

/** "10/3/26", the grid's visit-date format. */
export function formatShortDate(date: IsoDate): string {
  const [y, m, d] = parts(date);
  return `${m}/${d}/${String(y).slice(-2)}`;
}

/** "Oct 3, 2026" */
export function formatLongDate(date: IsoDate): string {
  const [y, m, d] = parts(date);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** "04/17/1984", the way the front desk reads a date of birth. */
export function formatDob(date: IsoDate): string {
  const [y, m, d] = parts(date);
  return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;
}

/** Every way staff type a date of birth: "1984-04-17", "04/17/1984", "4/17/1984". */
export function dobSearchForms(date: IsoDate): string[] {
  const us = formatDob(date);
  return [date, us, us.replace(/(^|\/)0/g, '$1')];
}

/** Age in whole years on `today` (one less until this year's birthday). */
export function ageOn(dob: IsoDate, today: IsoDate): number {
  const [by, bm, bd] = parts(dob);
  const [ty, tm, td] = parts(today);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

/** "Oct 3" */
export function formatMonthDay(date: IsoDate): string {
  const [, m, d] = parts(date);
  return `${MONTHS[m - 1]} ${d}`;
}

/** "October" style month names for KPI copy ("vs. September"). */
export function monthName(key: string): string {
  const name = MONTH_NAMES[Number(key.slice(5, 7)) - 1];
  if (!name) throw new RangeError(`not a month key: ${JSON.stringify(key)}`);
  return name;
}

/** The month key before `key` ("2026-01" → "2025-12"). */
export function previousMonthKey(key: string): string {
  return monthKey(addMonths(`${key}-01`, -1));
}

/** Today's calendar date in the server's local time zone, or a pinned demo date. */
export function todayIso(pinned?: string | null): IsoDate {
  if (pinned) {
    parts(pinned);
    return pinned;
  }
  const now = new Date();
  return toIso(now.getFullYear(), now.getMonth() + 1, now.getDate());
}
