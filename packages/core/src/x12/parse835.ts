/**
 * ASC X12 835 (Health Care Claim Payment/Advice, 005010X221A1) parser.
 *
 * Reads the envelope (ISA/GS/ST … SE/GE/IEA), the payment header (BPR, TRN, DTM*405, N1 payer
 * and payee), and each claim loop (CLP, CAS, NM1, MOA/MIA, DTM, SVC, LQ, AMT) into
 * NormalizedClaim objects. The parser is structural: it rejects malformed files with an error
 * that names the segment, and leaves money reconciliation to `computePatientBalance`.
 */
import { isGroupCode } from '../codes';
import { x12DateToIso, type IsoDate } from '../dates';
import { parseDecimalToCents, type Cents } from '../money';
import type { Adjustment, NormalizedClaim, Person, ServiceLine } from '../types';
import { tokenize, X12ParseError, type Delimiters, type Segment } from './tokenize';

export { X12ParseError } from './tokenize';

export interface ProviderAdjustment {
  providerId: string;
  /** PLB03-1 adjustment reason code (e.g. "WO" overpayment recovery, "L6" interest). */
  reason: string;
  reference?: string;
  amountCents: Cents;
}

export interface RemittanceTransaction {
  controlNumber: string;
  payment: {
    handlingCode: string;
    amountCents: Cents;
    creditDebit: string;
    method: string;
    effectiveDate?: IsoDate;
  };
  traceNumber?: string;
  productionDate?: IsoDate;
  payer: { name: string; id?: string };
  payee: { name: string; npi?: string };
  claims: NormalizedClaim[];
  providerAdjustments: ProviderAdjustment[];
}

export interface Remittance835 {
  interchange: {
    senderId: string;
    receiverId: string;
    controlNumber: string;
    date: IsoDate;
    usage: string;
  };
  functionalGroup: { controlNumber: string; version: string };
  transactions: RemittanceTransaction[];
}

export interface Parse835Options {
  fileName?: string;
}

// ── element helpers ──────────────────────────────────────────────────────────

function name(seg: Segment, n: number): string {
  return `${seg.id}${String(n).padStart(2, '0')}`;
}

function where(seg: Segment): string {
  return `segment ${seg.position} (${seg.id})`;
}

function fail(seg: Segment, message: string): never {
  throw new X12ParseError(`${where(seg)}: ${message}`, seg.position);
}

function opt(seg: Segment, n: number): string {
  return seg.elements[n] ?? '';
}

function req(seg: Segment, n: number, what: string): string {
  const value = opt(seg, n);
  if (value === '') fail(seg, `${name(seg, n)} (${what}) is required`);
  return value;
}

function amount(seg: Segment, n: number, what: string): Cents {
  const raw = req(seg, n, what);
  try {
    return parseDecimalToCents(raw);
  } catch {
    return fail(seg, `${name(seg, n)} is not a valid amount: ${JSON.stringify(raw)}`);
  }
}

function optionalAmount(seg: Segment, n: number): Cents | undefined {
  return opt(seg, n) === '' ? undefined : amount(seg, n, 'amount');
}

function date(seg: Segment, n: number): IsoDate {
  const raw = req(seg, n, 'date');
  try {
    return x12DateToIso(raw);
  } catch {
    return fail(seg, `${name(seg, n)} is not a valid CCYYMMDD date: ${JSON.stringify(raw)}`);
  }
}

function quantity(seg: Segment, n: number): number | undefined {
  const raw = opt(seg, n);
  if (raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) fail(seg, `${name(seg, n)} is not a number: ${JSON.stringify(raw)}`);
  return value;
}

function person(seg: Segment): Person {
  const p: Person = { lastName: req(seg, 3, 'last name'), firstName: opt(seg, 4) };
  if (opt(seg, 5)) p.middleName = opt(seg, 5);
  if (opt(seg, 9)) {
    p.id = opt(seg, 9);
    if (opt(seg, 8)) p.idQualifier = opt(seg, 8);
  }
  return p;
}

// ── builders ─────────────────────────────────────────────────────────────────

interface ClaimBuilder {
  seg: Segment;
  patientControlNumber: string;
  claimStatusCode: string;
  chargeCents: Cents;
  paidCents: Cents;
  patientResponsibilityCents: Cents;
  payerClaimControlNumber?: string;
  patient?: Person;
  renderingProvider?: Person;
  statementDate?: IsoDate;
  receivedDate?: IsoDate;
  claimAdjustments: Adjustment[];
  lines: ServiceLine[];
  remarks: string[];
}

interface TransactionBuilder {
  st: Segment;
  segmentCount: number;
  payment?: RemittanceTransaction['payment'];
  traceNumber?: string;
  productionDate?: IsoDate;
  payer?: { name: string; id?: string };
  payee?: { name: string; npi?: string };
  n1Context?: string;
  claims: ClaimBuilder[];
  claim?: ClaimBuilder;
  line?: ServiceLine;
  providerAdjustments: ProviderAdjustment[];
}

const CLAIM_REMARK_ELEMENTS: Record<string, number[]> = {
  MOA: [3, 4, 5, 6, 7],
  MIA: [5, 20, 21, 22, 23],
};

function parseCas(seg: Segment): Adjustment[] {
  const group = req(seg, 1, 'claim adjustment group code');
  if (!isGroupCode(group)) {
    fail(seg, `CAS01 group code "${group}" is not one of CO, PR, OA, PI, CR`);
  }
  const adjustments: Adjustment[] = [];
  for (let k = 0; k < 6; k++) {
    const reasonIndex = 2 + k * 3;
    const reason = opt(seg, reasonIndex);
    if (reason === '') {
      if (k === 0) fail(seg, 'CAS02 (reason code) is required');
      break;
    }
    const adj: Adjustment = {
      group,
      reason,
      amountCents: amount(seg, reasonIndex + 1, 'adjustment amount'),
    };
    const qty = quantity(seg, reasonIndex + 2);
    if (qty !== undefined) adj.quantity = qty;
    adjustments.push(adj);
  }
  return adjustments;
}

function parseSvc(seg: Segment, delimiters: Delimiters, lineNumber: number): ServiceLine {
  const composite = req(seg, 1, 'procedure').split(delimiters.component);
  const [codeQualifier = '', procedureCode = '', ...rest] = composite;
  if (!procedureCode) fail(seg, 'SVC01-2 (procedure code) is required');
  const line: ServiceLine = {
    lineNumber,
    codeQualifier,
    procedureCode,
    modifiers: rest.slice(0, 4).filter(Boolean),
    chargeCents: amount(seg, 2, 'line charge'),
    paidCents: amount(seg, 3, 'line payment'),
    adjustments: [],
    remarks: [],
  };
  const units = quantity(seg, 5);
  if (units !== undefined) line.units = units;
  return line;
}

function closeLine(tx: TransactionBuilder): void {
  if (tx.line && tx.claim) tx.claim.lines.push(tx.line);
  tx.line = undefined;
}

function closeClaim(tx: TransactionBuilder): void {
  closeLine(tx);
  if (!tx.claim) return;
  const c = tx.claim;
  if (!c.patient) {
    throw new X12ParseError(
      `Claim ${c.patientControlNumber} has no patient (NM1*QC).`,
      c.seg.position,
    );
  }
  tx.claims.push(c);
  tx.claim = undefined;
}

function finishClaim(
  c: ClaimBuilder,
  tx: TransactionBuilder,
  interchangeControlNumber: string,
  options: Parse835Options,
): NormalizedClaim {
  const serviceDate = c.statementDate ?? c.lines.find((l) => l.serviceDate)?.serviceDate;
  if (!serviceDate) {
    throw new X12ParseError(
      `Claim ${c.patientControlNumber} has no service date (DTM*232 on the claim or DTM*472 on a line).`,
      c.seg.position,
    );
  }
  const claim: NormalizedClaim = {
    source: {
      kind: '835',
      ...(options.fileName ? { fileName: options.fileName } : {}),
      interchangeControlNumber,
      ...(tx.traceNumber ? { traceNumber: tx.traceNumber } : {}),
      ...(tx.payment?.effectiveDate ? { paymentDate: tx.payment.effectiveDate } : {}),
    },
    payer: tx.payer!,
    ...(tx.payee ? { payee: tx.payee } : {}),
    patientControlNumber: c.patientControlNumber,
    ...(c.payerClaimControlNumber ? { payerClaimControlNumber: c.payerClaimControlNumber } : {}),
    claimStatusCode: c.claimStatusCode,
    denied: c.claimStatusCode === '4',
    patient: c.patient!,
    ...(c.renderingProvider ? { renderingProvider: c.renderingProvider } : {}),
    serviceDate,
    ...(c.receivedDate ? { receivedDate: c.receivedDate } : {}),
    chargeCents: c.chargeCents,
    paidCents: c.paidCents,
    patientResponsibilityCents: c.patientResponsibilityCents,
    claimAdjustments: c.claimAdjustments,
    lines: c.lines,
    remarks: c.remarks,
  };
  return claim;
}

// ── main ─────────────────────────────────────────────────────────────────────

export function parse835(raw: string, options: Parse835Options = {}): Remittance835 {
  const { delimiters, segments } = tokenize(raw);
  const isa = segments[0]!;

  const interchange: Remittance835['interchange'] = {
    senderId: req(isa, 6, 'sender id'),
    receiverId: req(isa, 8, 'receiver id'),
    controlNumber: req(isa, 13, 'interchange control number'),
    date: (() => {
      const yymmdd = req(isa, 9, 'interchange date');
      try {
        return x12DateToIso(`20${yymmdd}`);
      } catch {
        return fail(isa, `ISA09 is not a valid YYMMDD date: ${JSON.stringify(yymmdd)}`);
      }
    })(),
    usage: opt(isa, 15),
  };

  let group:
    (Remittance835['functionalGroup'] & { gs: Segment; transactionCount: number }) | undefined;
  let groupClosed = false;
  let tx: TransactionBuilder | undefined;
  let sawIea = false;
  const transactions: RemittanceTransaction[] = [];

  for (const seg of segments.slice(1)) {
    if (sawIea) fail(seg, 'unexpected content after IEA');
    if (tx) tx.segmentCount++;

    switch (seg.id) {
      case 'GS': {
        if (group) fail(seg, 'files with more than one functional group (GS) are not supported');
        if (opt(seg, 1) !== 'HP')
          fail(seg, `GS01 is "${opt(seg, 1)}", expected "HP" (health care claim payment/advice)`);
        group = {
          gs: seg,
          controlNumber: req(seg, 6, 'group control number'),
          version: opt(seg, 8),
          transactionCount: 0,
        };
        continue;
      }
      case 'ST': {
        if (!group || groupClosed) fail(seg, 'ST outside of a functional group');
        if (tx)
          fail(seg, `ST before the previous transaction ${tx.st.elements[2]} was closed with SE`);
        if (opt(seg, 1) !== '835') {
          throw new X12ParseError(
            `Transaction ${opt(seg, 2)} is not an 835 (ST01 = ${opt(seg, 1) || 'blank'}).`,
            seg.position,
          );
        }
        tx = { st: seg, segmentCount: 1, claims: [], providerAdjustments: [] };
        continue;
      }
      case 'SE': {
        if (!tx) fail(seg, 'SE without a matching ST');
        closeClaim(tx);
        const declared = Number(req(seg, 1, 'segment count'));
        const control = req(tx.st, 2, 'transaction control number');
        if (declared !== tx.segmentCount) {
          throw new X12ParseError(
            `Transaction ${control}: SE01 says ${declared} segments but the transaction has ${tx.segmentCount}.`,
            seg.position,
          );
        }
        if (opt(seg, 2) !== control)
          fail(seg, `SE02 (${opt(seg, 2)}) does not match ST02 (${control})`);
        if (!tx.payment) fail(tx.st, `transaction ${control} has no BPR segment`);
        if (!tx.payer) fail(tx.st, `transaction ${control} has no payer (N1*PR)`);
        if (!tx.payee) fail(tx.st, `transaction ${control} has no payee (N1*PE)`);
        const finished = tx;
        transactions.push({
          controlNumber: control,
          payment: finished.payment!,
          ...(finished.traceNumber ? { traceNumber: finished.traceNumber } : {}),
          ...(finished.productionDate ? { productionDate: finished.productionDate } : {}),
          payer: finished.payer!,
          payee: finished.payee!,
          claims: finished.claims.map((c) =>
            finishClaim(c, finished, interchange.controlNumber, options),
          ),
          providerAdjustments: finished.providerAdjustments,
        });
        group!.transactionCount++;
        tx = undefined;
        continue;
      }
      case 'GE': {
        if (!group || groupClosed) fail(seg, 'GE without a matching GS');
        if (tx) fail(seg, 'GE before the open transaction was closed with SE');
        if (Number(opt(seg, 1)) !== group.transactionCount) {
          fail(
            seg,
            `GE01 says ${opt(seg, 1)} transactions but the group has ${group.transactionCount}`,
          );
        }
        if (opt(seg, 2) !== group.controlNumber) {
          fail(seg, `GE02 (${opt(seg, 2)}) does not match GS06 (${group.controlNumber})`);
        }
        groupClosed = true;
        continue;
      }
      case 'IEA': {
        if (!group || !groupClosed) fail(seg, 'IEA before the functional group was closed with GE');
        if (opt(seg, 2) !== interchange.controlNumber) {
          fail(seg, `IEA02 (${opt(seg, 2)}) does not match ISA13 (${interchange.controlNumber})`);
        }
        sawIea = true;
        continue;
      }
    }

    if (!tx) fail(seg, `${seg.id} outside of a transaction (ST/SE)`);
    handleTransactionSegment(seg, tx, delimiters);
  }

  if (tx) throw new X12ParseError(`Transaction ${tx.st.elements[2]} is missing its SE trailer.`);
  if (!group) throw new X12ParseError('File has no functional group (GS).');
  if (!groupClosed) throw new X12ParseError('File is missing GE (functional group trailer).');
  if (!sawIea) throw new X12ParseError('File is missing IEA (interchange trailer).');

  return {
    interchange,
    functionalGroup: { controlNumber: group.controlNumber, version: group.version },
    transactions,
  };
}

function handleTransactionSegment(
  seg: Segment,
  tx: TransactionBuilder,
  delimiters: Delimiters,
): void {
  const inClaim = (): ClaimBuilder => tx.claim ?? fail(seg, `${seg.id} outside of a claim (CLP)`);

  switch (seg.id) {
    case 'BPR': {
      tx.payment = {
        handlingCode: req(seg, 1, 'transaction handling code'),
        amountCents: amount(seg, 2, 'total payment'),
        creditDebit: req(seg, 3, 'credit/debit flag'),
        method: req(seg, 4, 'payment method'),
        ...(opt(seg, 16) ? { effectiveDate: date(seg, 16) } : {}),
      };
      return;
    }
    case 'TRN':
      tx.traceNumber = req(seg, 2, 'trace number');
      return;
    case 'N1': {
      closeClaim(tx);
      const entity = req(seg, 1, 'entity identifier');
      tx.n1Context = entity;
      if (entity === 'PR') tx.payer = { name: req(seg, 2, 'payer name') };
      if (entity === 'PE') {
        tx.payee = { name: req(seg, 2, 'payee name') };
        if (opt(seg, 3) === 'XX' && opt(seg, 4)) tx.payee.npi = opt(seg, 4);
      }
      return;
    }
    case 'REF': {
      if (!tx.claim && tx.n1Context === 'PR' && opt(seg, 1) === '2U' && tx.payer)
        tx.payer.id = req(seg, 2, 'payer id');
      return;
    }
    case 'DTM': {
      const qualifier = req(seg, 1, 'date qualifier');
      if (tx.line) {
        if (qualifier === '472' || (qualifier === '150' && !tx.line.serviceDate))
          tx.line.serviceDate = date(seg, 2);
      } else if (tx.claim) {
        if (qualifier === '232') tx.claim.statementDate = date(seg, 2);
        if (qualifier === '050') tx.claim.receivedDate = date(seg, 2);
      } else if (qualifier === '405') {
        tx.productionDate = date(seg, 2);
      }
      return;
    }
    case 'LX':
      closeClaim(tx);
      return;
    case 'CLP': {
      closeClaim(tx);
      tx.claim = {
        seg,
        patientControlNumber: req(seg, 1, 'patient control number'),
        claimStatusCode: req(seg, 2, 'claim status code'),
        chargeCents: amount(seg, 3, 'total claim charge'),
        paidCents: amount(seg, 4, 'claim payment'),
        patientResponsibilityCents: optionalAmount(seg, 5) ?? 0,
        ...(opt(seg, 7) ? { payerClaimControlNumber: opt(seg, 7) } : {}),
        claimAdjustments: [],
        lines: [],
        remarks: [],
      };
      return;
    }
    case 'CAS': {
      const claim = inClaim();
      const adjustments = parseCas(seg);
      (tx.line ? tx.line.adjustments : claim.claimAdjustments).push(...adjustments);
      return;
    }
    case 'NM1': {
      const claim = inClaim();
      const entity = req(seg, 1, 'entity identifier');
      if (entity === 'QC') claim.patient = person(seg);
      if (entity === '82') claim.renderingProvider = person(seg);
      return;
    }
    case 'MOA':
    case 'MIA': {
      const claim = inClaim();
      for (const n of CLAIM_REMARK_ELEMENTS[seg.id]!)
        if (opt(seg, n)) claim.remarks.push(opt(seg, n));
      return;
    }
    case 'SVC': {
      const claim = inClaim();
      closeLine(tx);
      tx.line = parseSvc(seg, delimiters, claim.lines.length + 1);
      return;
    }
    case 'AMT': {
      if (tx.line && opt(seg, 1) === 'B6') tx.line.allowedCents = amount(seg, 2, 'allowed amount');
      return;
    }
    case 'LQ': {
      if (!tx.line) fail(seg, 'LQ outside of a service line (SVC)');
      if (opt(seg, 1) === 'HE') tx.line.remarks.push(req(seg, 2, 'remark code'));
      return;
    }
    case 'PLB': {
      closeClaim(tx);
      const providerId = req(seg, 1, 'provider identifier');
      for (let k = 0; k < 6; k++) {
        const composite = opt(seg, 3 + k * 2);
        if (composite === '') break;
        const [reason = '', reference] = composite.split(delimiters.component);
        tx.providerAdjustments.push({
          providerId,
          reason,
          ...(reference ? { reference } : {}),
          amountCents: amount(seg, 4 + k * 2, 'provider adjustment amount'),
        });
      }
      return;
    }
    default:
      // N3, N4, PER, RDM, TS3, TS2, QTY, NM1 variants and other informational segments.
      return;
  }
}

/** Convenience: every claim in a file, in order. */
export function claimsFrom835(raw: string, options: Parse835Options = {}): NormalizedClaim[] {
  return parse835(raw, options).transactions.flatMap((t) => t.claims);
}
