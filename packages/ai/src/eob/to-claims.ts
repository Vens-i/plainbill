/**
 * Turn an EOB extraction into NormalizedClaims plus the flags a human should look at.
 *
 * The model only transcribes. Every figure is parsed into cents here and reconciled by
 * @plainbill/core; for each uncertain money field we try every reading the model offered and
 * report which ones actually add up — so "paid $260 or $280?" comes with an answer.
 */
import {
  computePatientBalance,
  describeAdjustment,
  formatMoney,
  isIsoDate,
  parseDecimalToCents,
  ReconciliationError,
  type Adjustment,
  type NormalizedClaim,
} from '@plainbill/core';
import { CONFIDENCE_THRESHOLD } from '../config';
import type { EobClaimExtraction, EobExtraction, ExtractedField } from './schema';

export type FlagKind = 'money' | 'code' | 'date' | 'text';

export interface FlagOption {
  value: string;
  display: string;
  /** Whether the claim reconciles (billed − contractual − paid = patient owes) with this reading. */
  reconciles: boolean;
}

export interface ExtractionFlag {
  /** Path into the extraction, e.g. "claims.0.insurance_paid" or "claims.0.adjustments.1.reason_code". */
  path: string;
  kind: FlagKind;
  label: string;
  /** Which preview column the flag belongs to. */
  column: 'insurancePaid' | 'adjustments' | 'billed' | 'patient' | 'visit' | 'payer' | 'other';
  current: FlagOption;
  alternatives: FlagOption[];
  confidence: number;
  note: string | null;
  /** Set when a value could not be parsed at all (e.g. "26O.00"). */
  problem?: string;
}

export interface EobClaimResult {
  index: number;
  claim: NormalizedClaim | null;
  flags: ExtractionFlag[];
  reconciles: boolean;
  /** Why the claim can't be used as-is (unparseable field or figures that don't add up). */
  error: string | null;
}

// ── helpers ─────────────────────────────────────────────────────────────────

type AnyField = ExtractedField<string | null>;

function isField(value: unknown): value is AnyField {
  return typeof value === 'object' && value !== null && 'confidence' in value && 'value' in value;
}

function getAt(root: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], root);
}

/** Deep-copy the extraction with one field replaced (confidence 1: a human set it). */
export function withFieldValue(
  extraction: EobExtraction,
  path: string,
  value: string,
): EobExtraction {
  const copy = structuredClone(extraction);
  const target = getAt(copy, path);
  if (!isField(target)) throw new Error(`No extracted field at ${path}`);
  Object.assign(target, { value, confidence: 1, note: null, alternatives: [] });
  return copy;
}

/**
 * Printed money → signed cents. EOBs print "$1,480.00", "-100.00" or "(100.00)"; strip the
 * formatting (never the digits) and let core do an exact decimal parse.
 */
export function parseMoneyText(raw: string): number {
  let text = raw.trim().replace(/[$,\s]/g, '');
  let sign = 1;
  if (text.startsWith('(') && text.endsWith(')')) {
    sign = -1;
    text = text.slice(1, -1);
  }
  return sign * parseDecimalToCents(text);
}

function cents(f: ExtractedField<string>, what: string): number {
  try {
    return parseMoneyText(f.value);
  } catch {
    throw new FieldError(`${what} "${f.value}" is not an amount`);
  }
}

class FieldError extends Error {}

function moneyDisplay(raw: string): string {
  try {
    return formatMoney(parseMoneyText(raw));
  } catch {
    return raw;
  }
}

function fieldKind(path: string): {
  kind: FlagKind;
  label: string;
  column: ExtractionFlag['column'];
} {
  const leaf = path.split('.').slice(-1)[0]!;
  if (path === 'payer_name') return { kind: 'text', label: 'Payer', column: 'payer' };
  switch (leaf) {
    case 'insurance_paid':
      return { kind: 'money', label: 'Insurance paid', column: 'insurancePaid' };
    case 'billed_total':
      return { kind: 'money', label: 'Billed', column: 'billed' };
    case 'patient_responsibility_total':
      return { kind: 'money', label: 'Patient responsibility', column: 'other' };
    case 'billed':
      return { kind: 'money', label: 'Service charge', column: 'billed' };
    case 'amount':
      return { kind: 'money', label: 'Adjustment amount', column: 'adjustments' };
    case 'reason_code':
    case 'group_code':
      return { kind: 'code', label: 'Adjustment code', column: 'adjustments' };
    case 'procedure_code':
      return { kind: 'code', label: 'Procedure code', column: 'other' };
    case 'service_date':
      return { kind: 'date', label: 'Visit date', column: 'visit' };
    case 'patient_first_name':
    case 'patient_last_name':
      return { kind: 'text', label: 'Patient name', column: 'patient' };
    default:
      return { kind: 'text', label: leaf.replaceAll('_', ' '), column: 'other' };
  }
}

/** Display a value the way staff read it: "$260.00", "PR-3 → Copay". */
export function displayFieldValue(extraction: EobExtraction, path: string, value: string): string {
  const { kind } = fieldKind(path);
  if (kind === 'money') return moneyDisplay(value);
  if (path.endsWith('.reason_code') || path.endsWith('.group_code')) {
    const adjPath = path.split('.').slice(0, -1).join('.');
    const adj = getAt(extraction, adjPath) as EobClaimExtraction['adjustments'][number];
    const group = path.endsWith('.group_code') ? value : adj.group_code.value;
    const reason = path.endsWith('.reason_code') ? value : adj.reason_code.value;
    if (group === 'CO' || group === 'PR' || group === 'OA' || group === 'PI') {
      return `${group}-${reason} → ${describeAdjustment(group, reason).label}`;
    }
    return `${group}-${reason}`;
  }
  return value;
}

// ── claim building ──────────────────────────────────────────────────────────

function buildClaim(extraction: EobExtraction, index: number, fileName: string): NormalizedClaim {
  const c = extraction.claims[index];
  if (!c) throw new FieldError(`No claim ${index} in the extraction`);
  if (!isIsoDate(c.service_date.value))
    throw new FieldError(`Visit date "${c.service_date.value}" is not a date`);

  const adjustments: Adjustment[] = c.adjustments.map((a, j) => {
    if (!/^\d{1,3}$/.test(a.reason_code.value.trim())) {
      throw new FieldError(
        `Adjustment ${j + 1} has an unreadable reason code "${a.reason_code.value}"`,
      );
    }
    return {
      group: a.group_code.value,
      reason: a.reason_code.value.trim(),
      // EOBs often print write-offs as negatives; adjustment amounts are magnitudes (as in CAS).
      amountCents: Math.abs(cents(a.amount, 'Adjustment')),
    };
  });
  const provider = c.provider_name.value?.trim();
  const providerParts = provider?.replace(/^dr\.?\s+/i, '').split(/\s+/) ?? [];

  return {
    source: { kind: 'eob', fileName },
    payer: { name: extraction.payer_name.value },
    patientControlNumber: c.patient_account_number.value?.trim() || `EOB-${fileName}-${index + 1}`,
    ...(c.payer_claim_number.value ? { payerClaimControlNumber: c.payer_claim_number.value } : {}),
    claimStatusCode: c.claim_status.value === 'denied' ? '4' : '1',
    denied: c.claim_status.value === 'denied',
    patient: {
      firstName: c.patient_first_name.value,
      lastName: c.patient_last_name.value,
      ...(c.member_id.value ? { id: c.member_id.value, idQualifier: 'MI' } : {}),
    },
    ...(providerParts.length
      ? {
          renderingProvider: {
            lastName: providerParts.at(-1)!,
            firstName: providerParts.slice(0, -1).join(' '),
          },
        }
      : {}),
    serviceDate: c.service_date.value,
    chargeCents: cents(c.billed_total, 'Billed total'),
    paidCents: cents(c.insurance_paid, 'Insurance paid'),
    patientResponsibilityCents: cents(c.patient_responsibility_total, 'Patient responsibility'),
    claimAdjustments: adjustments,
    lines: c.services.map((s, k) => ({
      lineNumber: k + 1,
      codeQualifier: 'HC',
      procedureCode: s.procedure_code.value.trim(),
      modifiers: [],
      chargeCents: cents(s.billed, `Charge for ${s.procedure_code.value}`),
      paidCents: 0,
      adjustments: [],
      remarks: [],
    })),
    remarks: c.remark_codes,
  };
}

/** Does this extraction produce a claim that reconciles? Never throws. */
function tryReconcile(
  extraction: EobExtraction,
  index: number,
  fileName: string,
): { claim: NormalizedClaim | null; error: string | null } {
  try {
    const claim = buildClaim(extraction, index, fileName);
    computePatientBalance(claim);
    return { claim, error: null };
  } catch (err) {
    if (err instanceof FieldError || err instanceof ReconciliationError) {
      return { claim: null, error: err.message };
    }
    throw err;
  }
}

function collectFieldPaths(node: unknown, prefix: string, out: string[]): void {
  if (isField(node)) {
    out.push(prefix);
    return;
  }
  if (Array.isArray(node))
    node.forEach((child, i) => collectFieldPaths(child, `${prefix}.${i}`, out));
  else if (node && typeof node === 'object') {
    for (const [key, child] of Object.entries(node))
      collectFieldPaths(child, prefix ? `${prefix}.${key}` : key, out);
  }
}

export interface ToClaimsOptions {
  fileName: string;
  threshold?: number;
}

export function eobToClaims(extraction: EobExtraction, options: ToClaimsOptions): EobClaimResult[] {
  const threshold = options.threshold ?? CONFIDENCE_THRESHOLD;
  return extraction.claims.map((_, index) => {
    const paths: string[] = [];
    collectFieldPaths({ payer_name: extraction.payer_name }, '', paths);
    collectFieldPaths(extraction.claims[index], `claims.${index}`, paths);

    const option = (path: string, value: string): FlagOption => {
      const candidate = withFieldValue(extraction, path, value);
      return {
        value,
        display: displayFieldValue(candidate, path, value),
        reconciles: tryReconcile(candidate, index, options.fileName).claim !== null,
      };
    };

    const flags: ExtractionFlag[] = [];
    for (const path of paths) {
      const f = getAt(extraction, path) as AnyField;
      if (f.value === null) continue;
      const meta = fieldKind(path);
      let problem: string | undefined;
      if (meta.kind === 'money') {
        try {
          parseMoneyText(f.value);
        } catch {
          problem = `"${f.value}" is not a readable amount`;
        }
      }
      if (f.confidence >= threshold && !problem) continue;
      const current = option(path, f.value);
      flags.push({
        path,
        ...meta,
        current,
        alternatives: f.alternatives
          .filter((a): a is string => typeof a === 'string' && a !== f.value)
          .map((a) => option(path, a)),
        confidence: f.confidence,
        note: f.note,
        ...(problem ? { problem } : {}),
      });
    }

    const { claim, error } = tryReconcile(extraction, index, options.fileName);
    return { index, claim, flags, reconciles: claim !== null, error };
  });
}

/**
 * Plain-English review reason and the "AI suggests" action for a balance that still has open
 * flags. Built from the flag data, not from model prose, so it is stable.
 */
export function reviewSummary(
  flags: ExtractionFlag[],
): { reviewReason: string; aiSuggestion: string } | null {
  const first = flags[0];
  if (!first) return null;
  const reasons = flags.map((f) => {
    const alts = f.alternatives.map((a) => a.display);
    if (f.problem) return `${f.label} unreadable on the EOB (${f.problem})`;
    if (f.kind === 'money') {
      return alts.length
        ? `EOB scan unclear: ${f.label.toLowerCase()} ${f.current.display} or ${alts.join(' or ')}?`
        : `EOB scan unclear: check ${f.label.toLowerCase()} (${f.current.display})`;
    }
    if (f.kind === 'code') {
      const short = (display: string) => {
        // "PR-2 → Coinsurance — patient's share" → "PR-2 (coinsurance)"
        const [code, label] = display.split(' → ');
        return label ? `${code} (${label.split(' — ')[0]!.toLowerCase()})` : display;
      };
      return alts.length
        ? `Code read as ${short(f.current.display)}, may be ${alts.map(short).join(' or ')}`
        : `Check ${f.label.toLowerCase()} ${short(f.current.display)}`;
    }
    return `Check ${f.label.toLowerCase()}: ${f.current.display}`;
  });

  const patientShareCodes = [first.current, ...first.alternatives].map(
    (o) => o.display.split(' ')[0],
  );
  const aiSuggestion =
    first.column === 'insurancePaid'
      ? 'Confirm insurance paid amount'
      : first.kind === 'code' && patientShareCodes.every((c) => /^PR-[123]$/.test(c ?? ''))
        ? 'Check copay vs. coinsurance'
        : `Confirm ${first.label.toLowerCase()}`;
  return { reviewReason: reasons.join('; '), aiSuggestion };
}
