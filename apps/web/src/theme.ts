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
  chromeBackgroundColor: '#F8F7F4',
  headerBackgroundColor: '#F8F7F4',
  headerTextColor: '#5C6766',
  headerFontSize: 12,
  headerFontWeight: 600,
  headerHeight: 42,
  headerRowBorder: { color: '#E5E1D9' },
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

/** fg / bg / border per status (from the design reference). */
export const STATUS_COLORS: Record<BalanceStatus, { fg: string; bg: string; border: string }> = {
  review: { fg: '#7A4E00', bg: '#FAEFD6', border: '#EFD9A0' },
  denied: { fg: '#9B2C24', bg: '#FAE5E1', border: '#F0C4BD' },
  ready: { fg: '#454B4D', bg: '#ECEAE5', border: '#DAD6CE' },
  sent: { fg: '#23518C', bg: '#E2EBF7', border: '#C3D4EC' },
  partial: { fg: '#24633A', bg: '#FFFFFF', border: '#A9D2B2' },
  paid: { fg: '#24633A', bg: '#E0F0E3', border: '#B9DDC0' },
};

/** bg / fg per aging bucket. */
export const AGING_COLORS: Record<AgingBucket, { bg: string; fg: string }> = {
  '0-30': { bg: '#ECEAE5', fg: '#454B4D' },
  '31-60': { bg: '#FAEFD6', fg: '#7A4E00' },
  '61-90': { bg: '#F8E1CC', fg: '#7D3F12' },
  '90+': { bg: '#FAE5E1', fg: '#9B2C24' },
};

export const CHART_COLORS = {
  teal: '#1D5C5C',
  denial: '#B5483E',
  ink: '#1C2B2D',
  muted: '#5C6766',
};
