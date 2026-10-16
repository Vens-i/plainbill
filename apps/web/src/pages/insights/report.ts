/**
 * The Practice insights report: the data sources AG Studio reads (from /api/insights/data) and
 * the default page the office manager opens to. Amounts arrive as dollars computed by
 * @plainbill/core; Studio only aggregates them. No patient names: Studio's query results go to
 * the model, so the Still owed widget looks names up itself.
 */
import type { InsightsData } from '@plainbill/api/contract';

const usd = {
  format: new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }),
};
const money = (id: string, name: string, description?: string) => ({
  id,
  name,
  format: 'currencyFormat',
  formatOptions: usd,
  ...(description ? { description } : {}),
});
const text = (id: string, name: string, description?: string) => ({
  id,
  name,
  format: 'textFormat',
  ...(description ? { description } : {}),
});
const int = (id: string, name: string, description?: string) => ({
  id,
  name,
  format: 'integerFormat',
  ...(description ? { description } : {}),
});
const date = (id: string, name: string) => ({ id, name, format: 'dateFormat' });
const flag = (id: string, name: string, description?: string) => ({
  id,
  name,
  format: 'booleanFormat',
  ...(description ? { description } : {}),
});

/**
 * Dates here are calendar days. AG Studio reads a date filter value like "2026-10-01" or
 * "2026-10-01T00:00:00Z" as UTC and then takes the local day, so west of UTC it becomes Sep 30
 * and a Sep 30 denial lands in "this quarter". A local date-time with no zone filters correctly.
 */
export const DATE_FILTER_HINT =
  'In date filters, always write values as a local date-time with no time zone, for example 2026-10-01T00:00:00 for the start of Oct 1 and 2026-10-10T23:59:59 for the end of Oct 10 (never 2026-10-01 or a value ending in Z).';

/** Studio data sources. `month` is precomputed ("2026-07") so months sort and group simply. */
export function insightsSources(data: InsightsData) {
  return {
    description:
      'Harborview Family Medicine, a small independent practice. Patient balances after insurance, the payments patients made, and the adjustments on each claim (insurance write-offs and the patient share). Amounts are US dollars. Today is ' +
      data.today +
      '. ' +
      DATE_FILTER_HINT,
    sources: [
      {
        id: 'balances',
        name: 'Balances',
        description:
          'One row per visit: what was billed, what insurance paid or wrote off, and what the patient still owes.',
        data: data.balances.map((b) => ({ ...b, deniedClaims: b.status === 'Denied' ? 1 : 0 })),
        fields: [
          int('balanceId', 'Balance ID'),
          text(
            'status',
            'Status',
            'Needs review, Denied, Ready to invoice, Sent, Partially paid or Paid',
          ),
          text('payer', 'Payer', 'Insurance plan, or Self-pay'),
          text('provider', 'Provider'),
          date('visitDate', 'Visit date'),
          money('billed', 'Billed'),
          money(
            'insuranceDiscount',
            'Insurance discount',
            'Contract write-off; the patient never pays it',
          ),
          money('insurancePaid', 'Insurance paid'),
          money('patientShare', 'Patient share'),
          money('patientPaid', 'Patient paid'),
          money('stillOwed', 'Still owed', 'What the patient still owes today'),
          int('daysOut', 'Days out', 'Days since the visit, for open balances'),
          text('aging', 'Aging', '0–30, 31–60, 61–90 or 90+ days, or Settled'),
          int('deniedClaims', 'Denied claims', '1 when insurance denied the claim'),
          flag('invoiceOpened', 'Bill opened'),
          flag('onPlan', 'On a payment plan'),
          flag(
            'splitVisit',
            'Split visit',
            'Covered checkup plus a separately billed office visit',
          ),
        ],
      },
      {
        id: 'payments',
        name: 'Payments',
        description:
          'Patient payments received through Plainbill (PayPal, card or plan installments).',
        data: data.payments.map((p) => ({ ...p, month: p.paidOn.slice(0, 7) })),
        fields: [
          int('paymentId', 'Payment ID'),
          int('balanceId', 'Balance ID'),
          date('paidOn', 'Paid on'),
          text('month', 'Month', 'YYYY-MM'),
          money('amount', 'Amount'),
          text('method', 'Method'),
          text('payer', 'Payer'),
        ],
      },
      {
        id: 'adjustments',
        name: 'Adjustments',
        description:
          'Each claim adjustment with its plain-English reason: insurance write-offs (including denials) and the patient share (deductible, coinsurance, copay).',
        data: data.adjustments,
        fields: [
          int('balanceId', 'Balance ID'),
          text('payer', 'Payer'),
          date('date', 'Date'),
          text('code', 'Code', 'Adjustment code, e.g. CO-45 or PR-1'),
          text('reason', 'Reason'),
          text('whoPays', 'Who pays', 'Patient or Written off'),
          money('amount', 'Amount'),
          flag('denied', 'Denied claim'),
        ],
      },
    ],
    // Payments and adjustments belong to a balance, so a filter on a balance field (clicking
    // "90+ days" in the money flow) narrows them too: the Collected tile then agrees with the
    // flow's Collected instead of showing the whole practice.
    relationships: BALANCE_RELATIONSHIPS,
  };
}

export const BALANCE_RELATIONSHIPS = (['payments', 'adjustments'] as const).map((tableId) => ({
  id: `${tableId}-balance`,
  source: { tableId, fieldId: 'balanceId' },
  target: { tableId: 'balances', fieldId: 'balanceId' },
  type: 'many-to-one' as const,
}));

const title = (text: string) => ({
  title: { enabled: true, text, typography: { fontSize: 15, fontWeight: 'bold' } },
});

/** The page the office manager opens to. 24 tracks wide. */
export const INITIAL_REPORT = {
  selectedPageId: 'insights',
  // The report gets the room; Filters, Compose and Data are a click away.
  panels: { filters: { collapsed: true }, edit: { collapsed: true }, data: { collapsed: true } },
  pages: [
    {
      id: 'insights',
      layout: {
        rowHeight: 28,
        backgroundColor: '#F5F2EC',
        widgetBackgroundColor: '#FFFFFF',
        widgetBorderEnabled: true,
        widgetBorderColor: '#E5E1D9',
        widgetBorderWidth: 1,
        widgetBorderRadius: 12,
        widgetPadding: 12,
      },
      widgets: {
        flow: {
          type: 'money-flow',
          format: title('Where every dollar went'),
          dataMapping: {},
        },
        owed: {
          type: 'value',
          format: title('Still owed'),
          dataMapping: { value: [{ id: 'balances.stillOwed', aggregation: 'sum' }] },
        },
        collected: {
          type: 'value',
          format: title('Collected'),
          dataMapping: { value: [{ id: 'payments.amount', aggregation: 'sum' }] },
        },
        denied: {
          type: 'value',
          format: title('Denied claims'),
          dataMapping: { value: [{ id: 'balances.deniedClaims', aggregation: 'sum' }] },
        },
        aging: {
          type: 'column-chart-grouped',
          format: title('Owed, by age'),
          sort: [{ field: { id: 'balances.aging' }, direction: 'asc' }],
          dataMapping: {
            categoryKey: [{ id: 'balances.aging' }],
            valueKey: [{ id: 'balances.stillOwed', aggregation: 'sum' }],
          },
        },
        byPayer: {
          type: 'bar-chart-grouped',
          format: title('Owed, by payer'),
          dataMapping: {
            categoryKey: [{ id: 'balances.payer' }],
            valueKey: [{ id: 'balances.stillOwed', aggregation: 'sum' }],
          },
        },
        monthly: {
          type: 'column-chart-grouped',
          format: title('Collected, by month'),
          sort: [{ field: { id: 'payments.month' }, direction: 'asc' }],
          dataMapping: {
            categoryKey: [{ id: 'payments.month' }],
            valueKey: [{ id: 'payments.amount', aggregation: 'sum' }],
          },
        },
        denials: {
          type: 'bar-chart-grouped',
          format: title('Denials, by payer'),
          dataMapping: {
            categoryKey: [{ id: 'balances.payer' }],
            valueKey: [{ id: 'balances.deniedClaims', aggregation: 'sum' }],
          },
        },
        scoreboard: {
          type: 'still-owed',
          format: title('Who still owes'),
          dataMapping: {},
        },
      },
      widgetLayout: {
        flow: { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 14 },
        owed: { xTrack: 0, yTrack: 14, xSpan: 8, ySpan: 4 },
        collected: { xTrack: 8, yTrack: 14, xSpan: 8, ySpan: 4 },
        denied: { xTrack: 16, yTrack: 14, xSpan: 8, ySpan: 4 },
        scoreboard: { xTrack: 0, yTrack: 18, xSpan: 10, ySpan: 20 },
        aging: { xTrack: 10, yTrack: 18, xSpan: 7, ySpan: 10 },
        byPayer: { xTrack: 17, yTrack: 18, xSpan: 7, ySpan: 10 },
        monthly: { xTrack: 10, yTrack: 28, xSpan: 7, ySpan: 10 },
        denials: { xTrack: 17, yTrack: 28, xSpan: 7, ySpan: 10 },
      },
    },
  ],
};

export const PROMPT_STARTERS = [
  {
    label: 'Denials by payer',
    prompt: 'Which payer denied the most claims this quarter, and why?',
  },
  { label: 'Collected by week', prompt: 'Show what we collected each week.' },
  {
    label: 'Owed the longest',
    prompt: 'Who has owed us the longest? Chart open balances by days out.',
  },
];
