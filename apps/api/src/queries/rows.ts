/**
 * Builds dashboard rows. Display amounts and adjustment labels are recomputed from the stored
 * claim through @plainbill/core, so the grid can never show money the core didn't produce.
 */
import { asc, eq, inArray } from 'drizzle-orm';
import {
  agingBucket,
  computePatientBalance,
  daysBetween,
  describeAdjustment,
  describeProcedure,
  describeRemark,
  formatMoneyShort,
  planOption,
  type IsoDate,
  type NormalizedClaim,
} from '@plainbill/core';
import type { BalanceRow, DisplayAdjustment } from '../contract';
import type { DbLike } from '../db/client';
import {
  adjustments,
  balances,
  claimLines,
  invoices,
  patients,
  payments,
  visits,
} from '../db/schema';

type VisitRow = typeof visits.$inferSelect;
type LineRow = typeof claimLines.$inferSelect;
type AdjustmentRow = typeof adjustments.$inferSelect;

const METHOD_LABEL: Record<string, string> = { paypal: 'PayPal', card: 'card', cash: 'cash' };

/** Rebuild the NormalizedClaim a visit was ingested from. */
export function visitToClaim(
  visit: VisitRow,
  lines: LineRow[],
  adjs: AdjustmentRow[],
): NormalizedClaim {
  const toAdj = (a: AdjustmentRow) => ({
    group: a.groupCode,
    reason: a.reasonCode,
    amountCents: a.amountCents,
    ...(a.quantity != null ? { quantity: a.quantity } : {}),
  });
  return {
    source: { kind: visit.sourceKind, ...(visit.sourceFile ? { fileName: visit.sourceFile } : {}) },
    payer: { name: visit.payerName },
    patientControlNumber: visit.claimId,
    claimStatusCode: visit.claimStatusCode,
    denied: visit.denied,
    patient: { firstName: '', lastName: '' },
    serviceDate: visit.serviceDate,
    chargeCents: visit.billedCents,
    paidCents: visit.insurancePaidCents,
    patientResponsibilityCents: visit.reportedPatientResponsibilityCents,
    claimAdjustments: adjs.filter((a) => a.claimLineId == null).map(toAdj),
    lines: lines.map((l) => ({
      lineNumber: l.lineNumber,
      codeQualifier: l.codeQualifier,
      procedureCode: l.procedureCode,
      modifiers: l.modifiers,
      chargeCents: l.chargeCents,
      paidCents: l.paidCents,
      adjustments: adjs.filter((a) => a.claimLineId === l.id).map(toAdj),
      remarks: l.remarks,
    })),
    remarks: visit.remarks,
  };
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

export function getBalanceRows(db: DbLike, today: IsoDate, ids?: number[]): BalanceRow[] {
  const base = db
    .select({ balance: balances, visit: visits, patient: patients })
    .from(balances)
    .innerJoin(visits, eq(balances.visitId, visits.id))
    .innerJoin(patients, eq(visits.patientId, patients.id));
  const rows = (ids ? base.where(inArray(balances.id, ids)) : base).orderBy(asc(balances.id)).all();
  if (rows.length === 0) return [];

  const visitIds = rows.map((r) => r.visit.id);
  const balanceIds = rows.map((r) => r.balance.id);
  const linesByVisit = groupBy(
    db
      .select()
      .from(claimLines)
      .where(inArray(claimLines.visitId, visitIds))
      .orderBy(asc(claimLines.lineNumber))
      .all(),
    (l) => l.visitId,
  );
  const adjsByVisit = groupBy(
    db
      .select()
      .from(adjustments)
      .where(inArray(adjustments.visitId, visitIds))
      .orderBy(asc(adjustments.id))
      .all(),
    (a) => a.visitId,
  );
  const invoicesByBalance = groupBy(
    db
      .select()
      .from(invoices)
      .where(inArray(invoices.balanceId, balanceIds))
      .orderBy(asc(invoices.id))
      .all(),
    (i) => i.balanceId,
  );
  const paymentsByBalance = groupBy(
    db
      .select()
      .from(payments)
      .where(inArray(payments.balanceId, balanceIds))
      .orderBy(asc(payments.id))
      .all(),
    (p) => p.balanceId,
  );

  return rows.map(({ balance, visit, patient }) => {
    const lines = linesByVisit.get(visit.id) ?? [];
    const claim = visitToClaim(visit, lines, adjsByVisit.get(visit.id) ?? []);
    const computed = computePatientBalance(claim);
    const invoice = invoicesByBalance.get(balance.id)?.at(-1) ?? null;
    const paymentList = paymentsByBalance.get(balance.id) ?? [];
    const lastPayment = paymentList.at(-1) ?? null;
    const remaining = balance.patientResponsibilityCents - balance.patientPaidCents;
    const selfPay = visit.payerKind === 'self-pay';
    const paid = balance.status === 'paid';

    const provider = visit.providerLastName ? `Dr. ${visit.providerLastName}` : null;
    const providerFullName = visit.providerLastName
      ? `Dr. ${[visit.providerFirstName, visit.providerLastName].filter(Boolean).join(' ')}`
      : null;

    // Adjustments panel, in the order the design reads: write-offs, insurance paid, patient share.
    const display: DisplayAdjustment[] = [];
    if (selfPay) {
      display.push({
        code: 'SELF',
        label: visit.selfPayRateApplied
          ? 'No insurance — self-pay rate applied'
          : 'No insurance — self-pay rate not applied yet',
        amountCents: null,
        kind: 'self-pay',
      });
    } else {
      for (const a of computed.adjustments.filter((x) => x.responsibility === 'payer')) {
        display.push({
          code: a.code,
          label: a.label,
          amountCents: -a.amountCents,
          kind: 'writeoff',
        });
      }
      if (!visit.denied || visit.insurancePaidCents > 0) {
        display.push({
          code: 'PAID',
          label: `${visit.payerName} paid`,
          amountCents: -visit.insurancePaidCents,
          kind: 'payment',
        });
      }
      for (const a of computed.adjustments.filter((x) => x.responsibility === 'patient')) {
        display.push({ code: a.code, label: a.label, amountCents: a.amountCents, kind: 'patient' });
      }
      const remarks = [...new Set([...visit.remarks, ...lines.flatMap((l) => l.remarks)])];
      for (const code of remarks) {
        display.push({
          code,
          label: describeRemark(code).label,
          amountCents: null,
          kind: 'remark',
        });
      }
    }
    if (balance.patientPaidCents > 0) {
      const via = METHOD_LABEL[lastPayment?.method ?? ''] ?? 'payment';
      display.push({
        code: 'RCVD',
        label: `Patient paid via ${via}${paymentList.length > 1 ? ` (${paymentList.length} payments)` : ''}`,
        amountCents: -balance.patientPaidCents,
        kind: 'payment',
      });
    }

    let denialReason: string | null = null;
    if (visit.denied) {
      const main = [...computed.adjustments]
        .filter((a) => a.responsibility === 'payer')
        .sort((a, b) => b.amountCents - a.amountCents)[0];
      if (main) {
        const carc = describeAdjustment(main.group, main.reason);
        const remarkShort = [...visit.remarks, ...lines.flatMap((l) => l.remarks)]
          .map((r) => describeRemark(r).short)
          .find(Boolean);
        // Generic CARCs (like CO-16) are explained by the remark code; specific ones by themselves.
        const short =
          main.reason === '16' ? (remarkShort ?? carc.short) : (carc.short ?? remarkShort);
        denialReason = short ? `${main.code} ${short}` : main.code;
      }
    }

    let sub: string;
    if (visit.denied && denialReason) {
      // Name the primary (first) service when it has a short name: "MRI · CO-197 prior auth missing".
      const service = lines[0] ? describeProcedure(lines[0].procedureCode).short : undefined;
      sub = service ? `${service} · ${denialReason}` : denialReason.replace(' ', ' · ');
    } else if (balance.status === 'sent') {
      const opens = invoice?.openCount ?? 0;
      sub = opens > 0 ? `Opened ${opens}× · not paid` : 'Not opened';
    } else if (balance.status === 'partial') {
      sub = `${formatMoneyShort(balance.patientPaidCents)} of ${formatMoneyShort(balance.patientResponsibilityCents)} paid`;
    } else {
      sub = provider ?? visit.payerName;
    }

    const daysOut = paid ? null : Math.max(0, daysBetween(visit.serviceDate, today));

    return {
      id: balance.id,
      status: balance.status,
      patientName: `${patient.firstName} ${patient.lastName}`,
      patientFirstName: patient.firstName,
      provider,
      providerFullName,
      sub,
      visitDate: visit.serviceDate,
      payerId: visit.payerId,
      payerName: visit.payerName,
      payerShortName: visit.payerShortName,
      payerKind: visit.payerKind,
      claimId: visit.claimId,
      sourceKind: visit.sourceKind,
      sourceFile: visit.sourceFile,
      billedCents: balance.billedCents,
      insurancePaidCents: selfPay ? null : balance.insurancePaidCents,
      contractualCents: balance.contractualCents,
      patientResponsibilityCents: balance.patientResponsibilityCents,
      patientPaidCents: balance.patientPaidCents,
      remainingCents: remaining,
      // Paid rows show what the patient owed (and paid), as in the design; others show what's left.
      owesCents: visit.denied ? null : paid ? balance.patientResponsibilityCents : remaining,
      daysOut,
      agingBucket: daysOut == null ? null : agingBucket(daysOut),
      paidInDays: paid && balance.paidOn ? daysBetween(visit.serviceDate, balance.paidOn) : null,
      paidOn: paid ? balance.paidOn : null,
      paidAt: paid ? (lastPayment?.receivedAt ?? null) : null,
      paidVia: paid && lastPayment ? (METHOD_LABEL[lastPayment.method] ?? null) : null,
      aiSuggestion: balance.aiSuggestion,
      reviewReason: balance.reviewReason,
      denialReason,
      lines: lines.map((l) => ({
        code: l.procedureCode,
        description: describeProcedure(l.procedureCode).label,
        chargeCents: l.chargeCents,
      })),
      adjustments: display,
      patientShare: computed.patientShare,
      plan: remaining > 0 && !visit.denied ? planOption(remaining, 3) : null,
      invoice: invoice
        ? { status: invoice.status, sentOn: invoice.sentOn, openCount: invoice.openCount }
        : null,
    } satisfies BalanceRow;
  });
}
