/**
 * Plain-language names for the procedure codes Plainbill shows staff. These are our own short
 * descriptions, not the official CPT descriptors. Patients never see codes; CLAUDE.md keeps CPT
 * descriptions out of emails and PayPal invoices entirely.
 */
export interface ProcedureDescription {
  code: string;
  label: string;
  /** One-word name for summaries ("MRI"). */
  short?: string;
  known: boolean;
}

const PROCEDURES: Record<string, { label: string; short?: string }> = {
  '99203': { label: 'New patient visit (30–44 min)' },
  '99204': { label: 'New patient visit (45–59 min)' },
  '99213': { label: 'Office visit, established patient (20–29 min)' },
  '99214': { label: 'Office visit, established patient (30–39 min)' },
  '99215': { label: 'Office visit, established patient (40–54 min)' },
  '99395': { label: 'Preventive checkup, age 18–39' },
  '99396': { label: 'Preventive checkup, age 40–64' },
  '36415': { label: 'Blood draw' },
  '80053': { label: 'Blood work — metabolic panel', short: 'Blood work' },
  '80061': { label: 'Blood work — cholesterol panel', short: 'Blood work' },
  '85025': { label: 'Blood count (CBC)', short: 'Blood work' },
  '87880': { label: 'Rapid strep test' },
  '93000': { label: 'Heart rhythm test (ECG)', short: 'ECG' },
  '71046': { label: 'Chest X-ray (2 views)', short: 'X-ray' },
  '73562': { label: 'Knee X-ray (3 views)', short: 'X-ray' },
  '72148': { label: 'MRI — lower back', short: 'MRI' },
  '20610': { label: 'Joint injection — large joint', short: 'Injection' },
  '90686': { label: 'Flu vaccine' },
  '90471': { label: 'Vaccine administration' },
  '97110': { label: 'Physical therapy exercises', short: 'Therapy' },
};

export function describeProcedure(code: string): ProcedureDescription {
  const entry = PROCEDURES[code];
  return entry ? { code, ...entry, known: true } : { code, label: `Service ${code}`, known: false };
}
