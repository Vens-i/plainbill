/**
 * AG Grid Quartz theme, customized through the Theming API to the Plainbill tokens.
 */
import { themeQuartz } from 'ag-grid-community';
import type { AgingBucket, BalanceStatus } from '@plainbill/core';

export const gridTheme = themeQuartz.withParams({
  fontFamily: 'Figtree, system-ui, -apple-system, "Segoe UI", sans-serif',
  fontSize: 13,
  dataFontSize: 13,
  foregroundColor: '#1C2B2D',
  textColor: '#1C2B2D',
  subtleTextColor: '#5C6766',
  backgroundColor: '#FFFFFF',
  accentColor: '#1D5C5C',
  borderColor: '#ECE8E1',
  borderRadius: 8,
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  chromeBackgroundColor: '#F3F0EA',
  headerBackgroundColor: '#F3F0EA',
  headerTextColor: '#4F5A5A',
  headerFontSize: 11,
  headerFontWeight: 700,
  headerHeight: 40,
  headerRowBorder: { color: '#E2DDD3' },
  headerColumnBorder: false,
  headerColumnResizeHandleColor: 'transparent',
  columnBorder: false,
  rowHeight: 54,
  rowBorder: { color: '#ECE8E1' },
  rowHoverColor: '#FBFAF7',
  oddRowBackgroundColor: '#FFFFFF',
  selectedRowBackgroundColor: '#F3F8F7',
  cellHorizontalPadding: 12,
  iconColor: '#5C6766',
  rangeSelectionBorderColor: '#1D5C5C',
  rangeSelectionBackgroundColor: 'rgba(29, 92, 92, 0.08)',
  menuBackgroundColor: '#FFFFFF',
  menuBorder: { color: '#E5E1D9' },
  // flashCells on a live payment: a strong green that fades into the paid-now tint (#E4F2E6).
  valueChangeValueHighlightBackgroundColor: '#B9DDC0',
});

/**
 * Per status: the pill (fg / bg / border), and the grid's group header — a white row underlined
 * in `rule`, with a `solid` icon disc, an `ink` label and a count chip ringed in `line`. Each
 * status has its own hue so the grid's sections read apart at a glance.
 */
export interface StatusColors {
  fg: string;
  bg: string;
  border: string;
  rule: string;
  line: string;
  solid: string;
  ink: string;
}

export const STATUS_COLORS: Record<BalanceStatus, StatusColors> = {
  review: {
    fg: '#7A4E00',
    bg: '#FAEFD6',
    border: '#EFD9A0',
    rule: '#D9A53C',
    line: '#EACB80',
    solid: '#9A6400',
    ink: '#5A3A00',
  },
  denied: {
    fg: '#9B2C24',
    bg: '#FAE5E1',
    border: '#F0C4BD',
    rule: '#D9776B',
    line: '#E9B3AA',
    solid: '#9B2C24',
    ink: '#7D221B',
  },
  ready: {
    fg: '#1D5C5C',
    bg: '#E2EEEC',
    border: '#B9D3CF',
    rule: '#5E9E95',
    line: '#A9CEC6',
    solid: '#1D5C5C',
    ink: '#103B3B',
  },
  sent: {
    fg: '#23518C',
    bg: '#E2EBF7',
    border: '#C3D4EC',
    rule: '#6F95CE',
    line: '#B3C8E8',
    solid: '#23518C',
    ink: '#1A3F6E',
  },
  partial: {
    fg: '#5A3E8A',
    bg: '#EEE7F8',
    border: '#D6C8EE',
    rule: '#9C84C9',
    line: '#CDBDE9',
    solid: '#5A3E8A',
    ink: '#432D70',
  },
  paid: {
    fg: '#24633A',
    bg: '#E0F0E3',
    border: '#B9DDC0',
    rule: '#6DB282',
    line: '#A9D2B2',
    solid: '#24633A',
    ink: '#194A2A',
  },
};

/** bg / fg per aging bucket. */
export const AGING_COLORS: Record<AgingBucket, { bg: string; fg: string }> = {
  '0-30': { bg: '#ECEAE5', fg: '#454B4D' },
  '31-60': { bg: '#FAEFD6', fg: '#7A4E00' },
  '61-90': { bg: '#F8E1CC', fg: '#7D3F12' },
  '90+': { bg: '#FAE5E1', fg: '#9B2C24' },
};

/** Bar fill per aging bucket: teal while fresh, warming to red as balances age. */
export const AGING_BAR_COLORS: Record<AgingBucket, string> = {
  '0-30': '#2F7A73',
  '31-60': '#D19A2E',
  '61-90': '#C2632A',
  '90+': '#B5483E',
};

/** The same buckets, lightened to sit on the dark teal Outstanding card. */
export const AGING_KPI_COLORS: Record<AgingBucket, string> = {
  '0-30': '#9AD8C9',
  '31-60': '#F2CD7A',
  '61-90': '#F2A26B',
  '90+': '#EE7E6E',
};

export const CHART_COLORS = {
  teal: '#1D5C5C',
  denial: '#B5483E',
  ink: '#1C2B2D',
  muted: '#5C6766',
};

/**
 * Where a bill's money went, shared by the Breakdown sparkline and integrated charts:
 * warm gray for the discount, blue for insurance, green for what the patient paid, teal for
 * what's still owed.
 */
export const BREAKDOWN_COLORS = {
  discount: '#C9C2B6',
  insurance: '#6F95CE',
  patientPaid: '#6DB282',
  owed: '#1D5C5C',
  billed: '#B5AC9E',
} as const;
