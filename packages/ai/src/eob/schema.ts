/**
 * EOB extraction: what the model returns, and the per-field form the rest of Plainbill uses.
 *
 * The model transcribes plain values and lists every field it is not sure of in
 * `uncertain_fields` (path, confidence, note, other readings). A flat list keeps the structured-
 * output grammar small; `toExtraction` turns it back into a per-field form where every value
 * carries its own confidence (unlisted fields are ones the model read cleanly). Money stays a
 * decimal string ("260.00") so @plainbill/core can parse it straight into cents.
 */
import * as z from 'zod/v4';

const GROUP_CODES = ['CO', 'PR', 'OA', 'PI'] as const;
type GroupCode = (typeof GROUP_CODES)[number];
const money = (what: string) => z.string().describe(`${what}, decimal dollars as printed (e.g. "1480.00")`);

export const EobModelOutputSchema = z.object({
  document_kind: z.enum(['eob', 'not_an_eob']),
  payer_name: z.string(),
  claims: z.array(
    z.object({
      patient_first_name: z.string(),
      patient_last_name: z.string(),
      patient_account_number: z.string().nullable().describe("The provider's patient account number, if printed"),
      member_id: z.string().nullable(),
      payer_claim_number: z.string().nullable(),
      provider_name: z
        .string()
        .nullable()
        .describe('The rendering provider (the clinician who saw the patient), not the practice'),
      service_date: z.string().describe('YYYY-MM-DD'),
      claim_status: z.enum(['processed', 'denied']),
      services: z.array(z.object({ procedure_code: z.string(), billed: money('Billed') })),
      billed_total: money('Total billed'),
      adjustments: z.array(
        z.object({
          group_code: z.enum(GROUP_CODES),
          reason_code: z.string().describe('Reason code without the group prefix, e.g. "45"'),
          amount: money('Adjustment amount'),
          printed_label: z.string(),
        }),
      ),
      insurance_paid: money('Amount the plan paid'),
      patient_responsibility_total: money('Total patient responsibility'),
      remark_codes: z.array(z.string()),
    }),
  ),
  uncertain_fields: z
    .array(
      z.object({
        path: z.string().describe('Dot path of the field, e.g. "claims.0.insurance_paid" or "claims.0.adjustments.1.reason_code"'),
        confidence: z.number().describe('0 to 1'),
        note: z.string().describe('What is unclear, in a few words'),
        alternatives: z.array(z.string()).describe('Other plausible readings, most likely first'),
      }),
    )
    .describe('Every field you are less than 95% sure you read exactly as printed.'),
});

export type EobModelOutput = z.infer<typeof EobModelOutputSchema>;

export interface ExtractedField<T> {
  value: T;
  /** 0–1: how sure the model is that `value` is exactly what is printed. */
  confidence: number;
  note: string | null;
  alternatives: T[];
}

export interface EobClaimExtraction {
  patient_first_name: ExtractedField<string>;
  patient_last_name: ExtractedField<string>;
  patient_account_number: ExtractedField<string | null>;
  member_id: ExtractedField<string | null>;
  payer_claim_number: ExtractedField<string | null>;
  provider_name: ExtractedField<string | null>;
  service_date: ExtractedField<string>;
  claim_status: ExtractedField<'processed' | 'denied'>;
  services: Array<{ procedure_code: ExtractedField<string>; billed: ExtractedField<string> }>;
  billed_total: ExtractedField<string>;
  adjustments: Array<{
    group_code: ExtractedField<GroupCode>;
    reason_code: ExtractedField<string>;
    amount: ExtractedField<string>;
    printed_label: string;
  }>;
  insurance_paid: ExtractedField<string>;
  patient_responsibility_total: ExtractedField<string>;
  remark_codes: string[];
}

export interface EobExtraction {
  document_kind: 'eob' | 'not_an_eob';
  payer_name: ExtractedField<string>;
  claims: EobClaimExtraction[];
}

/** Confidence given to fields the model did not list as uncertain. */
export const CLEAN_READ_CONFIDENCE = 0.97;

const clean = <T>(value: T): ExtractedField<T> => ({ value, confidence: CLEAN_READ_CONFIDENCE, note: null, alternatives: [] });

/** Model output → per-field extraction. Uncertainty entries for unknown paths are ignored. */
export function toExtraction(raw: EobModelOutput): EobExtraction {
  const extraction: EobExtraction = {
    document_kind: raw.document_kind,
    payer_name: clean(raw.payer_name),
    claims: raw.claims.map((c) => ({
      patient_first_name: clean(c.patient_first_name),
      patient_last_name: clean(c.patient_last_name),
      patient_account_number: clean(c.patient_account_number),
      member_id: clean(c.member_id),
      payer_claim_number: clean(c.payer_claim_number),
      provider_name: clean(c.provider_name),
      service_date: clean(c.service_date),
      claim_status: clean(c.claim_status),
      services: c.services.map((s) => ({ procedure_code: clean(s.procedure_code), billed: clean(s.billed) })),
      billed_total: clean(c.billed_total),
      adjustments: c.adjustments.map((a) => ({
        group_code: clean(a.group_code),
        reason_code: clean(a.reason_code),
        amount: clean(a.amount),
        printed_label: a.printed_label,
      })),
      insurance_paid: clean(c.insurance_paid),
      patient_responsibility_total: clean(c.patient_responsibility_total),
      remark_codes: c.remark_codes,
    })),
  };

  for (const u of raw.uncertain_fields) {
    const target = u.path
      .split('.')
      .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], extraction);
    if (!target || typeof target !== 'object' || !('confidence' in target)) continue;
    const field = target as ExtractedField<unknown>;
    const isGroup = u.path.endsWith('.group_code');
    const isStatus = u.path.endsWith('.claim_status');
    const alternatives = u.alternatives
      .map((a) => a.trim())
      .filter((a) => a && a !== field.value)
      .filter((a) => !isGroup || (GROUP_CODES as readonly string[]).includes(a))
      .filter((a) => !isStatus || a === 'processed' || a === 'denied');
    Object.assign(field, {
      confidence: Math.min(1, Math.max(0, u.confidence)),
      note: u.note || null,
      alternatives,
    });
  }
  return extraction;
}
