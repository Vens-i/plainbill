import { describe, expect, it } from 'vitest';
import {
  addMonths,
  ageOn,
  dobSearchForms,
  daysBetween,
  formatDob,
  formatLongDate,
  formatMonthDay,
  formatShortDate,
  isIsoDate,
  monthKey,
  x12DateToIso,
} from '../src/dates';

describe('dates', () => {
  it('validates ISO calendar dates', () => {
    expect(isIsoDate('2026-10-10')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('10/10/2026')).toBe(false);
  });

  it('converts X12 CCYYMMDD dates', () => {
    expect(x12DateToIso('20261003')).toBe('2026-10-03');
    expect(() => x12DateToIso('261003')).toThrow();
    expect(() => x12DateToIso('20261332')).toThrow();
  });

  it('counts whole days between dates regardless of DST', () => {
    // The design's "days out" column, with today = Oct 10, 2026
    expect(daysBetween('2026-10-01', '2026-10-10')).toBe(9);
    expect(daysBetween('2026-09-12', '2026-10-10')).toBe(28);
    expect(daysBetween('2026-06-20', '2026-10-10')).toBe(112);
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2); // spans US DST change
    expect(daysBetween('2026-10-10', '2026-10-01')).toBe(-9);
  });

  it('adds months, clamping to the end of shorter months', () => {
    expect(addMonths('2026-10-10', 1)).toBe('2026-11-10');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28');
  });

  it('formats dates the way the design does', () => {
    expect(formatShortDate('2026-10-03')).toBe('10/3/26');
    expect(formatLongDate('2026-10-03')).toBe('Oct 3, 2026');
    expect(formatMonthDay('2026-10-03')).toBe('Oct 3');
    expect(monthKey('2026-10-03')).toBe('2026-10');
    expect(formatDob('1984-04-17')).toBe('04/17/1984');
    expect(formatDob('1958-09-04')).toBe('09/04/1958');
    expect(dobSearchForms('1958-09-04')).toEqual(['1958-09-04', '09/04/1958', '9/4/1958']);
  });

  it('counts age in whole years, turning over on the birthday', () => {
    expect(ageOn('1984-04-17', '2026-10-10')).toBe(42);
    expect(ageOn('1988-10-30', '2026-10-10')).toBe(37);
    expect(ageOn('1988-10-10', '2026-10-10')).toBe(38);
    expect(ageOn('2000-02-29', '2027-02-28')).toBe(26);
    expect(ageOn('2000-02-29', '2027-03-01')).toBe(27);
  });
});
