import type { GroupCode } from './types';

/**
 * CARC (claim adjustment reason code) and RARC (remark code) dictionary.
 *
 * `official` paraphrases the X12 code description so staff can cross-check a remittance;
 * `label` is the plain-English wording Plainbill shows (matching docs/design-reference.html);
 * `short` is a lowercase fragment for one-line summaries ("MRI · CO-197 prior auth missing").
 * The source of truth for the codes themselves is the X12 code list (x12.org/codes).
 */

export type Responsibility = 'patient' | 'payer';

export interface AdjustmentDescription {
  code: string;
  group: GroupCode;
  reason: string;
  label: string;
  short?: string;
  official: string;
  responsibility: Responsibility;
  known: boolean;
}

interface CarcEntry {
  official: string;
  /** Label when the provider writes the amount off (CO/OA/PI/CR). */
  label: string;
  /** Label when the patient owes the amount (PR), if it differs. */
  patientLabel?: string;
  short?: string;
}

const CARC: Record<string, CarcEntry> = {
  '1': {
    official: 'Deductible amount',
    label: 'Deductible',
    patientLabel: 'Deductible — patient pays',
  },
  '2': {
    official: 'Coinsurance amount',
    label: 'Coinsurance',
    patientLabel: "Coinsurance — patient's share",
  },
  '3': { official: 'Co-payment amount', label: 'Copay', patientLabel: 'Copay' },
  '16': {
    official: 'Claim/service lacks information or has submission/billing error(s)',
    label: 'Missing information — fix and resubmit',
    short: 'claim info missing',
  },
  '18': {
    official: 'Exact duplicate claim/service',
    label: 'Duplicate claim',
    short: 'duplicate claim',
  },
  '23': {
    official: 'The impact of prior payer(s) adjudication including payments and/or adjustments',
    label: "Adjusted for another insurer's payment",
  },
  '29': {
    official: 'The time limit for filing has expired',
    label: 'Filed too late',
    short: 'filed too late',
  },
  '45': {
    official:
      'Charge exceeds fee schedule/maximum allowable or contracted/legislated fee arrangement',
    label: 'Insurance discount (contract rate)',
  },
  '50': {
    official: "Non-covered service: not deemed a 'medical necessity' by the payer",
    label: 'Not considered medically necessary',
    patientLabel: 'Not considered medically necessary — patient pays',
    short: 'not medically necessary',
  },
  '96': {
    official: 'Non-covered charge(s)',
    label: 'Not covered — written off',
    patientLabel: 'Not covered by plan — patient pays',
    short: 'not covered',
  },
  '97': {
    official:
      'The benefit for this service is included in the payment/allowance for another service/procedure that has already been adjudicated',
    label: 'Bundled into another service',
    short: 'bundled',
  },
  '197': {
    official: 'Precertification/notification/authorization/pre-treatment absent',
    label: 'Prior authorization missing',
    short: 'prior auth missing',
  },
  '253': {
    official: 'Sequestration — reduction in federal payment',
    label: 'Federal sequestration reduction',
  },
};

const GROUP_CODES: readonly GroupCode[] = ['CO', 'PR', 'OA', 'PI', 'CR'];

export const GROUP_LABELS: Record<GroupCode, string> = {
  CO: 'Contractual obligation (provider writes off)',
  PR: 'Patient responsibility',
  OA: 'Other adjustment',
  PI: 'Payer-initiated reduction',
  CR: 'Correction or reversal',
};

export function isGroupCode(value: string): value is GroupCode {
  return (GROUP_CODES as readonly string[]).includes(value);
}

export function describeAdjustment(group: GroupCode, reason: string): AdjustmentDescription {
  const code = `${group}-${reason}`;
  const responsibility: Responsibility = group === 'PR' ? 'patient' : 'payer';
  const entry = CARC[reason];
  if (!entry) {
    return {
      code,
      group,
      reason,
      label:
        responsibility === 'patient'
          ? `Patient responsibility (${code})`
          : `Insurance adjustment (${code})`,
      official: `Unrecognized reason code ${reason}`,
      responsibility,
      known: false,
    };
  }
  const label = responsibility === 'patient' ? (entry.patientLabel ?? entry.label) : entry.label;
  return {
    code,
    group,
    reason,
    label,
    ...(entry.short ? { short: entry.short } : {}),
    official: entry.official,
    responsibility,
    known: true,
  };
}

export interface RemarkDescription {
  code: string;
  label: string;
  short?: string;
  official?: string;
  known: boolean;
}

const RARC: Record<string, Omit<RemarkDescription, 'code' | 'known'>> = {
  M62: {
    official: 'Missing/incomplete/invalid treatment authorization code',
    label: 'Authorization number missing or invalid',
    short: 'auth number missing',
  },
  MA130: {
    official:
      'Claim contains incomplete and/or invalid information; no appeal rights (unprocessable)',
    label: 'Claim could not be processed — fix and resubmit',
    short: 'unprocessable claim',
  },
  N264: {
    official: 'Missing/incomplete/invalid ordering provider name',
    label: 'Ordering provider name missing',
  },
  N265: {
    official: 'Missing/incomplete/invalid ordering provider primary identifier',
    label: 'Ordering provider ID missing',
  },
  N285: {
    official: 'Missing/incomplete/invalid referring provider name',
    label: 'Referring provider missing',
    short: 'referral missing',
  },
  N286: {
    official: 'Missing/incomplete/invalid referring provider primary identifier',
    label: 'Referral missing or invalid',
    short: 'referral missing',
  },
};

export function describeRemark(code: string): RemarkDescription {
  const entry = RARC[code];
  return entry ? { code, ...entry, known: true } : { code, label: `Remark ${code}`, known: false };
}
