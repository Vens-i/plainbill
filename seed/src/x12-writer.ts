/**
 * Minimal 835 writer for synthetic seed data. It spreads each claim's adjudication across its
 * service lines so every line balances (charge − paid = line CAS), the way real payers report
 * professional claims, and computes the SE segment count and control numbers.
 */
import {
  centsToDecimalString,
  dollars,
  isoToX12Date,
  type Cents,
  type GroupCode,
  type IsoDate,
} from '@plainbill/core';
import { PAYERS, PRACTICE, PROVIDERS, type SeedVisit } from './spec';

interface Component {
  kind: 'adjustment' | 'paid';
  group?: GroupCode;
  reason?: string;
  totalCents: Cents;
}

interface LineSplit {
  cpt: string;
  modifiers: string[];
  chargeCents: Cents;
  paidCents: Cents;
  adjustments: Array<{ group: GroupCode; reason: string; amountCents: Cents }>;
}

/** X12 basic character set has no accents: "Tomás" → "TOMAS". */
function x12Name(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase();
}

const money = (cents: Cents) => centsToDecimalString(cents);

/**
 * Allocate each component (paid, each CAS adjustment) to lines in proportion to line charges.
 * Rounding remainders on early lines go to that line's largest component; the last line takes
 * whatever is left of every component, so both line sums and component totals are exact.
 */
export function splitAcrossLines(visit: SeedVisit): LineSplit[] {
  const ins = visit.insurance;
  if (!ins) throw new Error(`${visit.key} is self-pay`);
  if (ins.lines) return explicitLines(visit);
  const charges = visit.lines.map((l) => dollars(l.charge));
  const billed = charges.reduce((a, b) => a + b, 0);
  const components: Component[] = [
    ...ins.adjustments
      .filter((a) => a.group !== 'PR')
      .map((a) => ({
        kind: 'adjustment' as const,
        group: a.group,
        reason: a.reason,
        totalCents: dollars(a.amount),
      })),
    { kind: 'paid', totalCents: dollars(ins.paid) },
    ...ins.adjustments
      .filter((a) => a.group === 'PR')
      .map((a) => ({
        kind: 'adjustment' as const,
        group: a.group,
        reason: a.reason,
        totalCents: dollars(a.amount),
      })),
  ];
  const componentSum = components.reduce((a, c) => a + c.totalCents, 0);
  if (componentSum !== billed) {
    throw new Error(
      `${visit.key}: paid + adjustments = ${componentSum} cents but billed is ${billed} cents`,
    );
  }

  const allocated = components.map(() => 0);
  return charges.map((chargeCents, i) => {
    const isLast = i === charges.length - 1;
    const shares = components.map((c, k) =>
      isLast ? c.totalCents - allocated[k]! : Math.round((c.totalCents * chargeCents) / billed),
    );
    if (!isLast) {
      const diff = chargeCents - shares.reduce((a, b) => a + b, 0);
      const largest = shares.indexOf(Math.max(...shares));
      shares[largest]! += diff;
    }
    shares.forEach((s, k) => {
      if (s < 0) throw new Error(`${visit.key}: negative allocation on line ${i + 1}`);
      allocated[k]! += s;
    });
    return {
      cpt: visit.lines[i]!.cpt,
      modifiers: visit.lines[i]!.modifiers ?? [],
      chargeCents,
      paidCents: shares[components.findIndex((c) => c.kind === 'paid')]!,
      adjustments: components
        .map((c, k) => ({ c, amountCents: shares[k]! }))
        .filter(({ c, amountCents }) => c.kind === 'adjustment' && amountCents !== 0)
        .map(({ c, amountCents }) => ({ group: c.group!, reason: c.reason!, amountCents })),
    };
  });
}

/**
 * Per-line adjudication as the spec gives it. Every line must balance (charge − paid = CAS), and
 * the lines must add up to the claim's paid amount and each of its adjustments exactly.
 */
function explicitLines(visit: SeedVisit): LineSplit[] {
  const ins = visit.insurance!;
  const given = ins.lines!;
  if (given.length !== visit.lines.length) {
    throw new Error(
      `${visit.key}: ${given.length} adjudicated lines for ${visit.lines.length} services`,
    );
  }
  const lines = given.map((g, i) => {
    const chargeCents = dollars(visit.lines[i]!.charge);
    const paidCents = dollars(g.paid);
    const adjustments = g.adjustments.map((a) => ({
      group: a.group,
      reason: a.reason,
      amountCents: dollars(a.amount),
    }));
    const adjusted = adjustments.reduce((sum, a) => sum + a.amountCents, 0);
    if (chargeCents - paidCents !== adjusted) {
      throw new Error(`${visit.key}: line ${i + 1} does not balance`);
    }
    return {
      cpt: visit.lines[i]!.cpt,
      modifiers: visit.lines[i]!.modifiers ?? [],
      chargeCents,
      paidCents,
      adjustments,
    };
  });
  if (lines.reduce((sum, l) => sum + l.paidCents, 0) !== dollars(ins.paid)) {
    throw new Error(`${visit.key}: line payments don't add up to the claim's paid amount`);
  }
  const key = (a: { group: string; reason: string }) => `${a.group}-${a.reason}`;
  const fromLines = new Map<string, number>();
  for (const a of lines.flatMap((l) => l.adjustments)) {
    fromLines.set(key(a), (fromLines.get(key(a)) ?? 0) + a.amountCents);
  }
  const fromClaim = new Map(ins.adjustments.map((a) => [key(a), dollars(a.amount)]));
  const same =
    fromLines.size === fromClaim.size &&
    [...fromClaim].every(([k, cents]) => fromLines.get(k) === cents);
  if (!same) throw new Error(`${visit.key}: line adjustments don't add up to the claim's`);
  return lines;
}

function casSegments(adjustments: LineSplit['adjustments']): string[] {
  const byGroup = new Map<GroupCode, string[]>();
  for (const a of adjustments) {
    const list = byGroup.get(a.group) ?? [];
    list.push(a.reason, money(a.amountCents), '');
    byGroup.set(a.group, list);
  }
  return [...byGroup].map(([group, triplets]) =>
    ['CAS', group, ...triplets].join('*').replace(/\*+$/, ''),
  );
}

export interface EraInput {
  fileKey: string;
  payer: keyof typeof PAYERS;
  date: IsoDate;
  controlNumber: number;
  trace: string;
  visits: SeedVisit[];
}

export function write835(era: EraInput): string {
  const payer = PAYERS[era.payer];
  const d8 = isoToX12Date(era.date);
  const icn = String(era.controlNumber).padStart(9, '0');
  const pad = (s: string, n: number) => s.padEnd(n, ' ').slice(0, n);
  const totalPaid = era.visits.reduce((sum, v) => sum + dollars(v.insurance!.paid), 0);

  const body: string[] = [];
  body.push(
    totalPaid > 0
      ? `BPR*C*${money(totalPaid)}*C*ACH*CCP*01*011000015*DA*0001234567*${payer.ein}**01*021000021*DA*0009876543*${d8}`
      : `BPR*H*0*C*NON************${d8}`,
    `TRN*1*${era.trace}*1${payer.ein}`,
    `DTM*405*${d8}`,
    `N1*PR*${payer.name}`,
    'N3*PO BOX 14000',
    'N4*PAYERVILLE*CA*94999',
    `REF*2U*${payer.id}`,
    'PER*BL*PROVIDER SERVICES*TE*5550100000',
    `N1*PE*${x12Name(PRACTICE.name)}*XX*${PRACTICE.npi}`,
    `N3*${x12Name(PRACTICE.addressLine1)}*${x12Name(PRACTICE.addressLine2)}`,
    `N4*${x12Name(PRACTICE.city)}*${PRACTICE.state}*${PRACTICE.zip}`,
    `REF*TJ*${PRACTICE.taxId}`,
    'LX*1',
  );

  for (const visit of era.visits) {
    const ins = visit.insurance!;
    const lines = splitAcrossLines(visit);
    const charge = lines.reduce((s, l) => s + l.chargeCents, 0);
    const patientResp = ins.adjustments
      .filter((a) => a.group === 'PR')
      .reduce((s, a) => s + dollars(a.amount), 0);
    const provider = PROVIDERS[visit.provider];
    const visitD8 = isoToX12Date(visit.visitDate);
    body.push(
      `CLP*${visit.claimId}*${ins.denied ? '4' : '1'}*${money(charge)}*${money(dollars(ins.paid))}*${money(patientResp)}*12*${ins.payerClaimNumber}*11*1`,
      `NM1*QC*1*${x12Name(visit.patient.lastName)}*${x12Name(visit.patient.firstName)}****MI*${visit.patient.memberId}`,
      `NM1*82*1*${x12Name(provider.lastName)}*${x12Name(provider.firstName)}****XX*${provider.npi}`,
    );
    if (ins.remarks?.length) body.push(`MOA***${ins.remarks.join('*')}`);
    body.push(`DTM*232*${visitD8}`, `DTM*233*${visitD8}`);
    for (const line of lines) {
      body.push(
        `SVC*HC:${[line.cpt, ...line.modifiers].join(':')}*${money(line.chargeCents)}*${money(line.paidCents)}**1`,
        `DTM*472*${visitD8}`,
      );
      body.push(...casSegments(line.adjustments));
      if (ins.remarks?.length) body.push(...ins.remarks.map((r) => `LQ*HE*${r}`));
      const allowed =
        line.chargeCents -
        line.adjustments.filter((a) => a.group !== 'PR').reduce((s, a) => s + a.amountCents, 0);
      if (!ins.denied) body.push(`AMT*B6*${money(allowed)}`);
    }
  }

  const st = ['ST*835*0001', ...body];
  const se = `SE*${st.length + 1}*0001`;
  const isa =
    `ISA*00*${pad('', 10)}*00*${pad('', 10)}*ZZ*${pad(payer.isaId, 15)}*ZZ*${pad('HARBORVIEWFM', 15)}` +
    `*${d8.slice(2)}*0600*^*00501*${icn}*0*P*:`;
  const segments = [
    isa,
    `GS*HP*${payer.isaId}*HARBORVIEWFM*${d8}*0600*${era.controlNumber}*X*005010X221A1`,
    ...st,
    se,
    `GE*1*${era.controlNumber}`,
    `IEA*1*${icn}`,
  ];
  return segments.map((s) => `${s}~`).join('\n') + '\n';
}

/** Self-pay visit summary CSV in the format parseSelfPayCsv reads. */
export function writeSelfPayCsv(visits: SeedVisit[]): string {
  const header =
    'visit_id,patient_first,patient_last,dob,provider,visit_date,cpt,charge,self_pay_rate_applied';
  const rows = visits.flatMap((v) =>
    v.lines.map((l) =>
      [
        v.claimId,
        v.patient.firstName,
        v.patient.lastName,
        v.patient.dob,
        `Dr. ${PROVIDERS[v.provider].firstName} ${PROVIDERS[v.provider].lastName}`,
        v.visitDate,
        l.cpt,
        money(dollars(l.charge)),
        v.selfPay!.rateApplied ? 'Y' : 'N',
      ].join(','),
    ),
  );
  return [header, ...rows].join('\n') + '\n';
}
