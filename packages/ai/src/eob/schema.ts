/**
 * Structured-output schema for EOB extraction. The model transcribes what is printed — it never
 * computes — and rates every field. Money stays a decimal string ("260.00") so it can be parsed
 * straight into cents by @plainbill/core.
 */
import * as z from 'zod/v4';

/** A transcribed value with the model's confidence and any other plausible readings. */
function field<T extends z.ZodType>(value: T, description: string) {
  return z
    .object({
      value,
      confidence: z
        .number()
        .describe(
          'From 0 to 1: how sure you are that `value` is exactly what is printed. Use 0.95+ only when the print is crisp and unambiguous.',
        ),
      note: z
        .string()
        .nullable()
        .describe(
          'If unsure, say why in a few words ("second digit is smudged"). null when confident.',
        ),
      alternatives: z
        .array(value)
        .describe(
          'Other plausible readings of the same printed text, most likely first. Empty when confident.',
        ),
    })
    .describe(description);
}

const money = (description: string) =>
  field(
    z.string(),
    `${description} Decimal dollars as printed, digits and a dot only (e.g. "1480.00").`,
  );

export const EobClaimSchema = z.object({
  patient_first_name: field(z.string(), "Patient's first name as printed."),
  patient_last_name: field(z.string(), "Patient's last name as printed."),
  patient_account_number: field(
    z.string().nullable(),
    "The provider's patient account / control number, if printed (often labelled 'Patient account' or 'Pt acct #').",
  ),
  member_id: field(z.string().nullable(), 'Member / subscriber ID, if printed.'),
  payer_claim_number: field(z.string().nullable(), "The payer's claim number, if printed."),
  provider_name: field(z.string().nullable(), 'Rendering provider name as printed, if any.'),
  service_date: field(z.string(), 'Date of service as YYYY-MM-DD.'),
  claim_status: field(
    z.enum(['processed', 'denied']),
    'denied only if the claim as a whole was denied.',
  ),
  services: z
    .array(
      z.object({
        procedure_code: field(z.string(), 'CPT/HCPCS code as printed.'),
        billed: money('Amount billed for this service.'),
      }),
    )
    .describe('One entry per service line, in printed order.'),
  billed_total: money('Total amount billed for the claim.'),
  adjustments: z
    .array(
      z.object({
        group_code: field(
          z.enum(['CO', 'PR', 'OA', 'PI']),
          'Adjustment group as printed: CO contractual, PR patient responsibility, OA other, PI payer-initiated.',
        ),
        reason_code: field(
          z.string(),
          'Numeric reason code as printed, without the group prefix (e.g. "45", "3").',
        ),
        amount: money('Adjustment amount.'),
        printed_label: z
          .string()
          .describe('The adjustment description exactly as printed, if any.'),
      }),
    )
    .describe(
      'Every claim-level adjustment printed on the EOB (contract discounts, deductible, copay, coinsurance, denials).',
    ),
  insurance_paid: money('Amount the plan paid the provider for this claim.'),
  patient_responsibility_total: money('Total the patient is responsible for, as printed.'),
  remark_codes: z
    .array(z.string())
    .describe('Remark codes printed for this claim (e.g. "M62"), if any.'),
});

export const EobExtractionSchema = z.object({
  document_kind: z
    .enum(['eob', 'not_an_eob'])
    .describe('not_an_eob if this document is not an Explanation of Benefits.'),
  payer_name: field(z.string(), 'Insurance company name as printed.'),
  claims: z.array(EobClaimSchema).describe('One entry per patient claim on the EOB.'),
});

export type EobExtraction = z.infer<typeof EobExtractionSchema>;
export type EobClaimExtraction = z.infer<typeof EobClaimSchema>;
export interface ExtractedField<T> {
  value: T;
  confidence: number;
  note: string | null;
  alternatives: T[];
}
