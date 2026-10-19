/**
 * The staff Patients page: one row per patient, rolled up in integer cents from the same computed
 * rows as the dashboard, so a patient's "still owed" always adds up to the Outstanding KPI.
 */
import { and, asc, inArray } from 'drizzle-orm';
import {
  ageOn,
  dobSearchForms,
  formatMoneyShort,
  STATUS_ORDER,
  type IsoDate,
} from '@plainbill/core';
import type { BalanceRow, PatientActivity, PatientSummary, PatientVisit } from '../contract';
import type { DbLike } from '../db/client';
import { events, patients, payments } from '../db/schema';
import { isOpen } from './dashboard';

const METHOD_LABEL: Record<string, string> = { paypal: 'PayPal', card: 'card', cash: 'cash' };

/** Live events carry wall-clock times; with a pinned demo date they still count toward today. */
const dayOf = (at: string, today: IsoDate): IsoDate => {
  const day = at.slice(0, 10);
  return day > today ? today : day;
};

/** Newest first: by the calendar day, then by the wall-clock time when there is one. */
const newer = (a: PatientActivity, b: PatientActivity) =>
  b.on.localeCompare(a.on) || (b.at ?? '').localeCompare(a.at ?? '');

function toVisit(r: BalanceRow): PatientVisit {
  const denied = r.status === 'denied';
  return {
    balanceId: r.id,
    status: r.status,
    visitDate: r.visitDate,
    provider: r.provider,
    payerShortName: r.payerKind === 'self-pay' ? 'Self-pay' : r.payerShortName,
    payerName: r.payerName,
    claimId: r.claimId,
    sub: r.sub,
    billedCents: r.billedCents,
    patientShareCents: denied ? null : r.patientResponsibilityCents,
    paidCents: r.patientPaidCents,
    owedCents: denied ? null : isOpen(r) ? r.remainingCents : 0,
    daysOut: r.daysOut,
    agingBucket: r.agingBucket,
  };
}

/** Everything that happened on these balances that staff would call "activity". */
function activities(db: DbLike, rows: BalanceRow[], today: IsoDate): PatientActivity[] {
  const ids = rows.map((r) => r.id);
  const list: PatientActivity[] = [];

  for (const p of db
    .select()
    .from(payments)
    .where(inArray(payments.balanceId, ids))
    .orderBy(asc(payments.id))
    .all()) {
    list.push({
      kind: 'payment',
      label: `Paid ${formatMoneyShort(p.amountCents)} via ${METHOD_LABEL[p.method] ?? p.method}`,
      at: p.receivedAt,
      on: p.postedOn,
      balanceId: p.balanceId,
    });
  }

  const logged = db
    .select()
    .from(events)
    .where(
      and(
        inArray(events.balanceId, ids),
        inArray(events.type, ['invoice.sent', 'invoice.reminded']),
      ),
    )
    .orderBy(asc(events.id))
    .all();
  for (const e of logged) {
    if (e.type !== 'invoice.reminded' || e.balanceId == null) continue;
    list.push({
      kind: 'reminder',
      label: e.payload.planMonths ? 'Reminder sent · plan offered' : 'Reminder sent',
      at: e.createdAt,
      on: dayOf(e.createdAt, today),
      balanceId: e.balanceId,
    });
  }

  for (const r of rows) {
    const invoice = r.invoice;
    if (invoice?.sentOn) {
      // The send date is the invoice's own (seeded invoices predate the event log); a send made
      // today also gets its time, for "just now".
      const sentAt =
        invoice.sentOn === today
          ? logged.filter((e) => e.type === 'invoice.sent' && e.balanceId === r.id).at(-1)
              ?.createdAt
          : undefined;
      list.push({
        kind: 'invoice_sent',
        label: 'Invoice sent',
        at: sentAt ?? null,
        on: invoice.sentOn,
        balanceId: r.id,
      });
    }
    const view = invoice?.statementView;
    if (view) {
      list.push({
        kind: 'statement_view',
        label: view.lang === 'en' ? 'Viewed statement' : `Viewed statement · ${view.language}`,
        at: view.at,
        on: dayOf(view.at, today),
        balanceId: r.id,
      });
    }
  }
  return list.sort(newer);
}

export function getPatients(db: DbLike, rows: BalanceRow[], today: IsoDate): PatientSummary[] {
  if (rows.length === 0) return [];
  const byPatient = new Map<number, BalanceRow[]>();
  for (const r of rows) {
    const list = byPatient.get(r.patientId);
    if (list) list.push(r);
    else byPatient.set(r.patientId, [r]);
  }
  const balanceToPatient = new Map(rows.map((r) => [r.id, r.patientId]));
  const lastActivity = new Map<number, PatientActivity>();
  for (const a of activities(db, rows, today)) {
    const patientId = balanceToPatient.get(a.balanceId)!;
    if (!lastActivity.has(patientId)) lastActivity.set(patientId, a);
  }

  const dobs = new Map(
    db
      .select({ id: patients.id, dob: patients.dob })
      .from(patients)
      .where(inArray(patients.id, [...byPatient.keys()]))
      .all()
      .map((p) => [p.id, p.dob]),
  );

  const summaries = [...byPatient].map(([patientId, list]): PatientSummary => {
    const first = list[0]!;
    const visits = list.map(toVisit);
    const sum = (f: (v: PatientVisit) => number | null) =>
      visits.reduce((t, v) => t + (f(v) ?? 0), 0);
    const open = list.filter(isOpen);
    const oldest = open.reduce<BalanceRow | null>(
      (o, r) => (o == null || (r.daysOut ?? 0) > (o.daysOut ?? 0) ? r : o),
      null,
    );
    const last = first.patientName.slice(first.patientFirstName.length).trim();
    const dob = dobs.get(patientId) ?? null;
    return {
      patientId,
      name: first.patientName,
      sortName: last ? `${last}, ${first.patientFirstName}` : first.patientFirstName,
      dob,
      age: dob ? ageOn(dob, today) : null,
      visitCount: list.length,
      billedCents: sum((v) => v.billedCents),
      patientShareCents: sum((v) => v.patientShareCents),
      paidCents: sum((v) => v.paidCents),
      owedCents: sum((v) => v.owedCents),
      oldestOpenDays: oldest?.daysOut ?? null,
      oldestOpenBucket: oldest?.agingBucket ?? null,
      statuses: STATUS_ORDER.map((status) => ({
        status,
        count: list.filter((r) => r.status === status).length,
      })).filter((s) => s.count > 0),
      lastActivity: lastActivity.get(patientId) ?? null,
      visits: visits.sort(
        (a, b) => b.visitDate.localeCompare(a.visitDate) || b.balanceId - a.balanceId,
      ),
    };
  });
  return summaries.sort((a, b) => a.sortName.localeCompare(b.sortName));
}

/** Search by name or date of birth ("bello", "04/17/1984", "1984-04-17", "4/17/1984"). */
export function matchesPatient(p: Pick<PatientSummary, 'name' | 'dob'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q || p.name.toLowerCase().includes(q)) return true;
  return p.dob != null && dobSearchForms(p.dob).some((form) => form.includes(q));
}
