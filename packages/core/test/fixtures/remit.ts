/**
 * Hand-written 835 (005010X221A1) used by the parser tests. Deliberately written by hand rather
 * than produced by the seed generator, so the parser is checked against an independent source.
 * All names, IDs and amounts are fictional.
 *
 *   TEST-001  processed as primary, two service lines with line-level CAS (CO-45, PR-1, PR-2)
 *   TEST-002  denied (CLP02 = 4), CO-197 on the line, remark M62 at claim (MOA) and line (LQ) level
 *   TEST-003  processed as secondary, no service lines, claim-level CAS (OA-23, PR-2)
 */
export const HAND_WRITTEN_835 = [
  'ISA*00*          *00*          *ZZ*ACMEHEALTH     *ZZ*HARBORVIEWFM   *261008*0930*^*00501*000000101*0*T*:~',
  'GS*HP*ACMEHEALTH*HARBORVIEWFM*20261008*0930*101*X*005010X221A1~',
  'ST*835*0001~',
  'BPR*C*162*C*ACH*CCP*01*011000015*DA*0001234567*1512345678**01*021000021*DA*0009876543*20261008~',
  'TRN*1*EFT0000101*1512345678~',
  'DTM*405*20261008~',
  'N1*PR*ACME HEALTH PLAN~',
  'N3*100 INSURANCE WAY~',
  'N4*SPRINGFIELD*IL*62701~',
  'REF*2U*ACME01~',
  'PER*BL*PROVIDER SERVICES*TE*5550100000~',
  'N1*PE*HARBORVIEW FAMILY MEDICINE*XX*1999999984~',
  'N3*220 HARBOR ST*SUITE 4~',
  'N4*HARBORVIEW*CA*94000~',
  'REF*TJ*999999999~',
  'LX*1~',
  'CLP*TEST-001*1*225*62*73*12*PAYERCLM0001*11*1~',
  'NM1*QC*1*RIVERS*JORDAN****MI*ACM100200300~',
  'NM1*82*1*PATEL*ANAND****XX*1999999992~',
  'DTM*232*20261001~',
  'DTM*233*20261001~',
  'DTM*050*20261003~',
  'SVC*HC:99213*200*50**1~',
  'DTM*472*20261001~',
  'CAS*CO*45*80~',
  'CAS*PR*1*50**2*20~',
  'AMT*B6*120~',
  'SVC*HC:36415*25*12**1~',
  'DTM*472*20261001~',
  'CAS*CO*45*10~',
  'CAS*PR*2*3~',
  'AMT*B6*15~',
  'CLP*TEST-002*4*1800*0*0*12*PAYERCLM0002*11*1~',
  'NM1*QC*1*MORGAN*KAI****MI*ACM400500600~',
  'MOA***M62~',
  'DTM*232*20260918~',
  'SVC*HC:72148*1800*0**1~',
  'DTM*472*20260918~',
  'CAS*CO*197*1800~',
  'LQ*HE*M62~',
  'CLP*TEST-003*2*300*100*40*12*PAYERCLM0003~',
  'CAS*OA*23*160~',
  'CAS*PR*2*40~',
  'NM1*QC*1*NG*SAM****MI*ACM700800900~',
  'DTM*232*20260920~',
  'SE*44*0001~',
  'GE*1*101~',
  'IEA*1*000000101~',
].join('\n');

/** Same transaction with different delimiters: `|` elements, `>` components, newline segments. */
export function withAlternateDelimiters(edi: string): string {
  return edi
    .split('\n')
    .map((segment) => segment.replace(/~$/, ''))
    .map((segment) => segment.replaceAll('*', '|'))
    .map((segment) => (segment.startsWith('ISA|') ? segment.replace(/\|:$/, '|>') : segment))
    .map((segment) => segment.replaceAll('HC:', 'HC>'))
    .join('\n');
}
