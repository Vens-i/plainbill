/**
 * Plain-language names for the procedure codes Plainbill shows staff. These are our own short
 * descriptions, not the official CPT descriptors. Patients never see codes, and CPT
 * descriptions stay out of emails and PayPal invoices entirely.
 */
export interface ProcedureDescription {
  code: string;
  label: string;
  /** One-word name for summaries ("MRI"). */
  short?: string;
  known: boolean;
}

/**
 * `patient` is the wording on the patient's bill page (behind verification); `visit` marks
 * office visits, which get " with Dr. …" appended there.
 */
const PROCEDURES: Record<string, { label: string; short?: string; patient: string; visit?: true }> =
  {
    '99203': { label: 'New patient visit (30–44 min)', patient: 'New patient visit', visit: true },
    '99204': { label: 'New patient visit (45–59 min)', patient: 'New patient visit', visit: true },
    '99213': {
      label: 'Office visit, established patient (20–29 min)',
      patient: 'Office visit',
      visit: true,
    },
    '99214': {
      label: 'Office visit, established patient (30–39 min)',
      patient: 'Office visit',
      visit: true,
    },
    '99215': {
      label: 'Office visit, established patient (40–54 min)',
      patient: 'Office visit',
      visit: true,
    },
    '99395': { label: 'Preventive checkup, age 18–39', patient: 'Preventive checkup', visit: true },
    '99396': { label: 'Preventive checkup, age 40–64', patient: 'Preventive checkup', visit: true },
    '36415': { label: 'Blood draw', patient: 'Blood draw' },
    '80053': {
      label: 'Blood work — metabolic panel',
      short: 'Blood work',
      patient: 'Blood work (metabolic panel)',
    },
    '80061': {
      label: 'Blood work — cholesterol panel',
      short: 'Blood work',
      patient: 'Blood work (cholesterol panel)',
    },
    '85025': { label: 'Blood count (CBC)', short: 'Blood work', patient: 'Blood count (CBC)' },
    '87880': { label: 'Rapid strep test', patient: 'Rapid strep test' },
    '93000': { label: 'Heart rhythm test (ECG)', short: 'ECG', patient: 'Heart rhythm test (ECG)' },
    '71046': { label: 'Chest X-ray (2 views)', short: 'X-ray', patient: 'Chest X-ray' },
    '73562': { label: 'Knee X-ray (3 views)', short: 'X-ray', patient: 'Knee X-ray' },
    '72148': { label: 'MRI — lower back', short: 'MRI', patient: 'MRI (lower back)' },
    '20610': {
      label: 'Joint injection — large joint',
      short: 'Injection',
      patient: 'Joint injection',
    },
    '90686': { label: 'Flu vaccine', patient: 'Flu vaccine' },
    '90471': { label: 'Vaccine administration', patient: 'Vaccine given' },
    '97110': { label: 'Physical therapy exercises', short: 'Therapy', patient: 'Physical therapy' },
  };

export function describeProcedure(code: string): ProcedureDescription {
  const entry = PROCEDURES[code];
  if (!entry) return { code, label: `Service ${code}`, known: false };
  return { code, label: entry.label, ...(entry.short ? { short: entry.short } : {}), known: true };
}

/** What the patient's bill calls a service ("Office visit with Dr. Patel"). Never the code. */
export function patientServiceName(code: string, provider: string | null): string {
  const entry = PROCEDURES[code];
  if (!entry) return 'Other service';
  return entry.visit && provider ? `${entry.patient} with ${provider}` : entry.patient;
}
