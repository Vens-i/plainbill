import type { Cents } from './money';
import type { IsoDate } from './dates';

/** CAS group codes: who carries an adjustment. */
export type GroupCode = 'CO' | 'PR' | 'OA' | 'PI' | 'CR';

export interface Adjustment {
  group: GroupCode;
  /** CARC reason code, e.g. "45". */
  reason: string;
  amountCents: Cents;
  quantity?: number;
}

export interface Person {
  firstName: string;
  lastName: string;
  middleName?: string;
  id?: string;
  idQualifier?: string;
}

export interface ServiceLine {
  lineNumber: number;
  /** Code set qualifier from SVC01-1, usually "HC" (CPT/HCPCS). */
  codeQualifier: string;
  procedureCode: string;
  modifiers: string[];
  chargeCents: Cents;
  paidCents: Cents;
  allowedCents?: Cents;
  units?: number;
  serviceDate?: IsoDate;
  adjustments: Adjustment[];
  /** RARC remark codes (LQ*HE). */
  remarks: string[];
}

export type ClaimSourceKind = '835' | 'self-pay-csv' | 'eob';

export interface ClaimSource {
  kind: ClaimSourceKind;
  fileName?: string;
  /** ISA13 interchange control number, for 835s. */
  interchangeControlNumber?: string;
  /** TRN02 check/EFT trace number, for 835s. */
  traceNumber?: string;
  /** BPR16 payment effective date, for 835s. */
  paymentDate?: IsoDate;
}

/**
 * One visit's insurance (or self-pay) outcome, independent of where it came from. The 835
 * parser, the self-pay CSV reader and (later) EOB extraction all produce this shape, and
 * balance math only ever reads this shape.
 */
export interface NormalizedClaim {
  source: ClaimSource;
  payer: { name: string; id?: string };
  payee?: { name: string; npi?: string };
  /** CLP01: the practice's own claim/account number. */
  patientControlNumber: string;
  /** CLP07: the payer's claim number. */
  payerClaimControlNumber?: string;
  /** CLP02 claim status ("1" primary, "2" secondary, "4" denied, …); "SELF" for self-pay. */
  claimStatusCode: string;
  denied: boolean;
  patient: Person & { dob?: IsoDate };
  renderingProvider?: Person;
  serviceDate: IsoDate;
  receivedDate?: IsoDate;
  /** CLP03 total charge. */
  chargeCents: Cents;
  /** CLP04 insurance payment. */
  paidCents: Cents;
  /** CLP05 patient responsibility as reported by the source. */
  patientResponsibilityCents: Cents;
  /** CAS segments at claim level (before any SVC). */
  claimAdjustments: Adjustment[];
  lines: ServiceLine[];
  /** RARC remark codes at claim level (MOA/MIA). */
  remarks: string[];
  selfPay?: { rateApplied: boolean };
}
