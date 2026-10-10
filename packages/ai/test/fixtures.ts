import type { EobExtraction, ExtractedField } from '../src/eob/schema';

export const sure = <T>(value: T): ExtractedField<T> => ({
  value,
  confidence: 0.98,
  note: null,
  alternatives: [],
});
export const unsure = <T>(
  value: T,
  alternatives: T[],
  note: string,
  confidence = 0.55,
): ExtractedField<T> => ({
  value,
  confidence,
  note,
  alternatives,
});

/** Priya Raman's scanned Aetna EOB: the paid figure is blurred ($260 or $280?). */
export function priyaExtraction(): EobExtraction {
  return {
    document_kind: 'eob',
    payer_name: sure('Aetna'),
    claims: [
      {
        patient_first_name: sure('PRIYA'),
        patient_last_name: sure('RAMAN'),
        patient_account_number: sure('HFM1003'),
        member_id: sure('W188420355'),
        payer_claim_number: sure('AE2610080091'),
        provider_name: sure('ANAND PATEL'),
        service_date: sure('2026-10-01'),
        claim_status: sure('processed' as const),
        services: [
          { procedure_code: sure('99214'), billed: sure('320.00') },
          { procedure_code: sure('85025'), billed: sure('90.00') },
          { procedure_code: sure('36415'), billed: sure('30.00') },
          { procedure_code: sure('80061'), billed: sure('80.00') },
        ],
        billed_total: sure('520.00'),
        adjustments: [
          {
            group_code: sure('CO' as const),
            reason_code: sure('45'),
            amount: sure('100.00'),
            printed_label: 'Contractual adjustment',
          },
          {
            group_code: sure('PR' as const),
            reason_code: sure('3'),
            amount: sure('160.00'),
            printed_label: 'Copay',
          },
        ],
        insurance_paid: unsure('260.00', ['280.00'], 'Second digit is blurred'),
        patient_responsibility_total: sure('160.00'),
        remark_codes: [],
      },
    ],
  };
}

/** Tomás Herrera's UHC EOB: the patient-share code is smudged (PR-3 or PR-2?). */
export function tomasExtraction(): EobExtraction {
  const e = priyaExtraction();
  e.payer_name = sure('UnitedHealthcare');
  const c = e.claims[0]!;
  Object.assign(c, {
    patient_first_name: sure('TOMAS'),
    patient_last_name: sure('HERRERA'),
    patient_account_number: sure('HFM1004'),
    service_date: sure('2026-09-12'),
    services: [{ procedure_code: sure('99215'), billed: sure('1480.00') }],
    billed_total: sure('1480.00'),
    adjustments: [
      {
        group_code: sure('CO'),
        reason_code: sure('45'),
        amount: sure('300.00'),
        printed_label: 'Contractual adjustment',
      },
      {
        group_code: sure('PR'),
        reason_code: unsure('3', ['2'], 'Code is smudged'),
        amount: sure('368.00'),
        printed_label: '',
      },
    ],
    insurance_paid: sure('812.00'),
    patient_responsibility_total: sure('368.00'),
  });
  return e;
}
