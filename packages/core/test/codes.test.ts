import { describe, expect, it } from 'vitest';
import { describeAdjustment, describeRemark, isGroupCode } from '../src/codes';
import { describeProcedure, patientServiceName } from '../src/procedures';
import { normalizePayer, SELF_PAY } from '../src/payers';

describe('CARC dictionary', () => {
  it.each([
    ['CO', '45', 'Insurance discount (contract rate)', 'payer'],
    ['PR', '1', 'Deductible — patient pays', 'patient'],
    ['PR', '2', "Coinsurance — patient's share", 'patient'],
    ['PR', '3', 'Copay', 'patient'],
    ['CO', '16', 'Missing information — fix and resubmit', 'payer'],
    ['CO', '97', 'Bundled into another service', 'payer'],
    ['CO', '197', 'Prior authorization missing', 'payer'],
    ['OA', '23', "Adjusted for another insurer's payment", 'payer'],
  ] as const)('%s-%s → %s', (group, reason, label, responsibility) => {
    const d = describeAdjustment(group, reason);
    expect(d.code).toBe(`${group}-${reason}`);
    expect(d.label).toBe(label);
    expect(d.responsibility).toBe(responsibility);
    expect(d.known).toBe(true);
    expect(d.official.length).toBeGreaterThan(5);
  });

  it('gives short labels for denial reasons used in grid sub-lines', () => {
    expect(describeAdjustment('CO', '197').short).toBe('prior auth missing');
    expect(describeAdjustment('CO', '16').short).toBe('claim info missing');
  });

  it('labels a patient-responsibility version of a reason differently from the write-off version', () => {
    expect(describeAdjustment('PR', '96').label).toBe('Not covered by plan — patient pays');
    expect(describeAdjustment('CO', '96').label).toBe('Not covered — written off');
  });

  it('never throws on unknown codes, and says so', () => {
    const d = describeAdjustment('CO', '999');
    expect(d).toMatchObject({ code: 'CO-999', known: false, responsibility: 'payer' });
    expect(d.label).toBe('Insurance adjustment (CO-999)');
    expect(describeAdjustment('PR', '999').label).toBe('Patient responsibility (PR-999)');
  });

  it('knows the CAS group codes', () => {
    expect(['CO', 'PR', 'OA', 'PI', 'CR'].every(isGroupCode)).toBe(true);
    expect(isGroupCode('XX')).toBe(false);
  });
});

describe('RARC dictionary', () => {
  it('translates remark codes', () => {
    expect(describeRemark('M62')).toMatchObject({
      code: 'M62',
      label: 'Authorization number missing or invalid',
      known: true,
    });
    expect(describeRemark('N286')).toMatchObject({ short: 'referral missing', known: true });
    expect(describeRemark('ZZ99')).toMatchObject({
      code: 'ZZ99',
      known: false,
      label: 'Remark ZZ99',
    });
  });
});

describe('procedure labels', () => {
  it('uses plain language matching the design', () => {
    expect(describeProcedure('99214').label).toBe('Office visit, established patient (30–39 min)');
    expect(describeProcedure('80053').label).toBe('Blood work — metabolic panel');
    expect(describeProcedure('93000').label).toBe('Heart rhythm test (ECG)');
    expect(describeProcedure('72148').short).toBe('MRI');
    expect(describeProcedure('00000')).toMatchObject({
      code: '00000',
      label: 'Service 00000',
      known: false,
    });
  });
});

describe('patient-facing procedure names', () => {
  it('matches the bill page wording and appends the provider to visits', () => {
    expect(patientServiceName('99214', 'Dr. Patel')).toBe('Office visit with Dr. Patel');
    expect(patientServiceName('99214', null)).toBe('Office visit');
    expect(patientServiceName('80053', 'Dr. Patel')).toBe('Blood work (metabolic panel)');
    expect(patientServiceName('93000', 'Dr. Patel')).toBe('Heart rhythm test (ECG)');
    expect(patientServiceName('99204', 'Dr. Kim')).toBe('New patient visit with Dr. Kim');
  });

  it('never shows a patient the code itself', () => {
    expect(patientServiceName('00000', 'Dr. Patel')).toBe('Other service');
    for (const code of ['99213', '72148', '36415', '00000']) {
      expect(patientServiceName(code, 'Dr. Okoye')).not.toMatch(/\d{5}/);
    }
  });
});

describe('payers', () => {
  it('normalizes raw 835 payer names to display names', () => {
    expect(normalizePayer('BLUECROSS BLUESHIELD')).toMatchObject({
      id: 'BCBS',
      name: 'BlueCross BlueShield',
      shortName: 'BlueCross',
    });
    expect(normalizePayer('Blue Cross Blue Shield of Somewhere')).toMatchObject({ id: 'BCBS' });
    expect(normalizePayer('UNITEDHEALTHCARE')).toMatchObject({
      id: 'UHC',
      name: 'UnitedHealthcare',
      shortName: 'UnitedHealth',
    });
    expect(normalizePayer('AETNA')).toMatchObject({ id: 'AETNA', name: 'Aetna' });
    expect(normalizePayer('ACME HEALTH PLAN')).toEqual({
      id: 'ACME HEALTH PLAN',
      name: 'Acme Health Plan',
      shortName: 'Acme Health Plan',
      kind: 'insurance',
    });
    expect(normalizePayer('Self-pay')).toBe(SELF_PAY);
  });
});
