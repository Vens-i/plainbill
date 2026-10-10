/**
 * Synthetic scanned EOBs. Each page is drawn on a canvas, the part of the "scan" that should be
 * hard to read is blurred and smudged, the page gets a slight skew and speckle, and the result is
 * embedded as an image in a PDF — so the model has to read pixels, like a real faxed EOB.
 *
 * Deterministic for a given machine (seeded noise, fixed PDF dates). Recorded extractions are keyed
 * by the PDF's SHA-256, so regenerating a PDF means re-recording (`pnpm ai:record`).
 */
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import {
  describeAdjustment,
  dollars,
  formatMoney,
  normalizePayer,
  type GroupCode,
} from '@plainbill/core';
import { PAYERS, PRACTICE, PROVIDERS, type SeedVisit } from './spec';

const W = 1275; // 8.5in at 150 dpi
const H = 1650; // 11in
const INK = '#23272a';
const MUTED = '#4a5052';
const SANS = 'Arial';
const MONO = 'Courier New';

type Box = { x: number; y: number; w: number; h: number };
type Align = 'left' | 'right' | 'center';

/** Small seeded PRNG (mulberry32) so the "scan" noise is the same every run. */
function prng(seedText: string): () => number {
  let seed = 0;
  for (const ch of seedText) seed = (Math.imul(seed, 31) + ch.charCodeAt(0)) | 0;
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Separable box blur on one region, a few passes ≈ gaussian. */
function blurRegion(ctx: SKRSContext2D, box: Box, radius: number, passes = 3): void {
  const img = ctx.getImageData(box.x, box.y, box.w, box.h);
  const { data, width, height } = img;
  const tmp = new Uint8ClampedArray(data.length);
  const pass = (src: Uint8ClampedArray, dst: Uint8ClampedArray, horizontal: boolean) => {
    const outer = horizontal ? height : width;
    const inner = horizontal ? width : height;
    for (let o = 0; o < outer; o++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        const idx = (i: number) => {
          const clamped = Math.min(inner - 1, Math.max(0, i));
          return ((horizontal ? o * width + clamped : clamped * width + o) << 2) + c;
        };
        for (let i = -radius; i <= radius; i++) sum += src[idx(i)]!;
        for (let i = 0; i < inner; i++) {
          dst[idx(i)] = sum / (radius * 2 + 1);
          sum += src[idx(i + radius + 1)]! - src[idx(i - radius)]!;
        }
      }
      for (let i = 0; i < inner; i++) {
        const a = ((horizontal ? o * width + i : i * width + o) << 2) + 3;
        dst[a] = 255;
      }
    }
  };
  for (let p = 0; p < passes; p++) {
    pass(data, tmp, true);
    pass(tmp, data, false);
  }
  ctx.putImageData(img, box.x, box.y);
}

function adjustmentLabel(group: GroupCode, reason: string): string {
  const printed: Record<string, string> = {
    'CO-45': 'Contractual adjustment',
    'CO-16': 'Claim lacks information',
    'CO-197': 'Precertification absent',
    'PR-1': 'Deductible',
    'PR-2': 'Coinsurance',
    'PR-3': 'Copay',
  };
  return printed[`${group}-${reason}`] ?? describeAdjustment(group, reason).label;
}

const usd = (cents: number) => formatMoney(cents).replace('$', '').replace('−', '-');
const mmddyyyy = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;

export interface EobPdfInput {
  fileKey: string;
  visit: SeedVisit;
  statementDate: string;
}

export async function renderEobPdf({
  fileKey,
  visit,
  statementDate,
}: EobPdfInput): Promise<Uint8Array> {
  const ins = visit.insurance;
  if (!ins?.eob) throw new Error(`${visit.key} has no EOB`);
  const payer = normalizePayer(PAYERS[ins.payer].name);
  const provider = PROVIDERS[visit.provider];
  const rand = prng(fileKey);

  const page = createCanvas(W, H);
  const ctx = page.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = INK;
  ctx.textBaseline = 'alphabetic';

  const text = (
    s: string,
    x: number,
    y: number,
    font: string,
    color = INK,
    align: Align = 'left',
  ) => {
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.fillText(s, x, y);
    const width = ctx.measureText(s).width;
    const left = align === 'right' ? x - width : x;
    return {
      x: Math.floor(left) - 4,
      y: Math.floor(y - 26),
      w: Math.ceil(width) + 8,
      h: 36,
    } satisfies Box;
  };
  /** The box around characters [start, end) of a string drawn with `text(...)`. */
  const charBox = (
    s: string,
    x: number,
    y: number,
    font: string,
    align: Align,
    start: number,
    end: number,
  ): Box => {
    ctx.font = font;
    const full = ctx.measureText(s).width;
    const left = align === 'right' ? x - full : x;
    const a = ctx.measureText(s.slice(0, start)).width;
    const b = ctx.measureText(s.slice(0, end)).width;
    return { x: Math.floor(left + a) - 2, y: Math.floor(y - 24), w: Math.ceil(b - a) + 4, h: 32 };
  };
  const rule = (y: number, x1 = 90, x2 = W - 90, width = 2) => {
    ctx.fillStyle = INK;
    ctx.fillRect(x1, y, x2 - x1, width);
  };

  // Header
  text(payer.name.toUpperCase(), 90, 130, `bold 44px ${SANS}`);
  text('EXPLANATION OF BENEFITS', 90, 175, `bold 26px ${SANS}`, MUTED);
  text('Provider copy · This is not a bill', 90, 210, `22px ${SANS}`, MUTED);
  text(`Statement date: ${mmddyyyy(statementDate)}`, W - 90, 130, `22px ${SANS}`, INK, 'right');
  text(`Claim number: ${ins.payerClaimNumber}`, W - 90, 165, `22px ${SANS}`, INK, 'right');
  text('Payment method: EFT', W - 90, 200, `22px ${SANS}`, INK, 'right');
  rule(240, 90, W - 90, 3);

  // Provider + patient
  text('PAY TO PROVIDER', 90, 290, `bold 20px ${SANS}`, MUTED);
  text(PRACTICE.name.toUpperCase(), 90, 322, `24px ${SANS}`);
  text(`${PRACTICE.addressLine1} ${PRACTICE.addressLine2}`.toUpperCase(), 90, 352, `24px ${SANS}`);
  text(
    `${PRACTICE.city} ${PRACTICE.state} ${PRACTICE.zip}  ·  NPI ${PRACTICE.npi}`.toUpperCase(),
    90,
    382,
    `24px ${SANS}`,
  );

  text('PATIENT', 700, 290, `bold 20px ${SANS}`, MUTED);
  const patientName = `${visit.patient.firstName} ${visit.patient.lastName}`
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase();
  text(patientName, 700, 322, `24px ${SANS}`);
  text(`Member ID: ${visit.patient.memberId}`, 700, 352, `24px ${SANS}`);
  text(`Patient account: ${visit.claimId}`, 700, 382, `24px ${SANS}`);
  text(
    `Rendering provider: ${provider.firstName} ${provider.lastName}`.toUpperCase(),
    90,
    432,
    `24px ${SANS}`,
  );
  text(`Date of service: ${mmddyyyy(visit.visitDate)}`, 700, 432, `24px ${SANS}`);
  rule(462);

  // Services
  let y = 515;
  text('SERVICES', 90, y, `bold 22px ${SANS}`);
  y += 45;
  text('Date of service', 90, y, `bold 20px ${SANS}`, MUTED);
  text('Procedure', 380, y, `bold 20px ${SANS}`, MUTED);
  text('Units', 640, y, `bold 20px ${SANS}`, MUTED);
  text('Billed', W - 90, y, `bold 20px ${SANS}`, MUTED, 'right');
  rule(y + 12, 90, W - 90, 1);
  for (const line of visit.lines) {
    y += 44;
    text(mmddyyyy(visit.visitDate), 90, y, `24px ${MONO}`);
    text(line.cpt, 380, y, `24px ${MONO}`);
    text('1', 640, y, `24px ${MONO}`);
    text(usd(dollars(line.charge)), W - 90, y, `24px ${MONO}`, INK, 'right');
  }
  const billed = visit.lines.reduce((s, l) => s + dollars(l.charge), 0);
  y += 20;
  rule(y, 760, W - 90, 1);
  y += 36;
  text('Total billed', 760, y, `bold 24px ${SANS}`);
  text(usd(billed), W - 90, y, `bold 24px ${MONO}`, INK, 'right');

  // Claim adjudication
  y += 80;
  text('CLAIM SUMMARY', 90, y, `bold 22px ${SANS}`);
  y += 45;
  text('Code', 90, y, `bold 20px ${SANS}`, MUTED);
  text('Description', 260, y, `bold 20px ${SANS}`, MUTED);
  text('Amount', W - 90, y, `bold 20px ${SANS}`, MUTED, 'right');
  rule(y + 12, 90, W - 90, 1);

  const contractual = ins.adjustments.filter((a) => a.group !== 'PR');
  const patient = ins.adjustments.filter((a) => a.group === 'PR');
  /** Lightly blurred area, plus the single character that should read two ways. */
  const obscured: Array<{ area: Box; glyph: Box }> = [];

  y += 44;
  text('Billed charges', 260, y, `24px ${SANS}`);
  text(usd(billed), W - 90, y, `24px ${MONO}`, INK, 'right');
  for (const a of contractual) {
    y += 44;
    text(`${a.group}-${a.reason}`, 90, y, `24px ${MONO}`);
    text(adjustmentLabel(a.group, a.reason), 260, y, `24px ${SANS}`);
    text(usd(-dollars(a.amount)), W - 90, y, `24px ${MONO}`, INK, 'right');
  }
  const allowed = billed - contractual.reduce((s, a) => s + dollars(a.amount), 0);
  y += 44;
  text('Allowed amount', 260, y, `24px ${SANS}`);
  text(usd(allowed), W - 90, y, `24px ${MONO}`, INK, 'right');
  y += 44;
  text('Plan paid', 260, y, `bold 24px ${SANS}`);
  const paidText = usd(dollars(ins.paid));
  const paidBox = text(paidText, W - 90, y, `bold 24px ${MONO}`, INK, 'right');
  if (ins.eob.obscure === 'insurance_paid') {
    // The tens digit ("260" → "2?0") is the one that smudged.
    const tens = paidText.indexOf('.') - 2;
    obscured.push({
      area: paidBox,
      glyph: charBox(paidText, W - 90, y, `bold 24px ${MONO}`, 'right', tens, tens + 1),
    });
  }

  for (const a of patient) {
    y += 44;
    const code = `${a.group}-${a.reason}`;
    const codeBox = text(code, 90, y, `24px ${MONO}`);
    // When the code itself is the unclear part, the label must not give it away.
    const label =
      ins.eob.obscure === 'patient_share_code'
        ? 'Member responsibility'
        : adjustmentLabel(a.group, a.reason);
    text(label, 260, y, `24px ${SANS}`);
    text(usd(dollars(a.amount)), W - 90, y, `24px ${MONO}`, INK, 'right');
    if (ins.eob.obscure === 'patient_share_code') {
      obscured.push({
        area: codeBox,
        glyph: charBox(code, 90, y, `24px ${MONO}`, 'left', 3, code.length),
      });
    }
  }
  y += 20;
  rule(y, 760, W - 90, 1);
  y += 36;
  const patientTotal = patient.reduce((s, a) => s + dollars(a.amount), 0);
  text('Patient responsibility', 640, y, `bold 24px ${SANS}`);
  text(usd(patientTotal), W - 90, y, `bold 24px ${MONO}`, INK, 'right');

  if (ins.remarks?.length) {
    y += 60;
    text(`Remark codes: ${ins.remarks.join(', ')}`, 90, y, `22px ${SANS}`, MUTED);
  }

  // Footer
  text(
    'Questions about this statement? Call Provider Services at 1-555-0100-000.',
    90,
    H - 120,
    `20px ${SANS}`,
    MUTED,
  );
  text('Page 1 of 1', W - 90, H - 120, `20px ${SANS}`, MUTED, 'right');

  // Make one character genuinely ambiguous: soften the figure, then smear the one glyph with a
  // toner smudge, so "6" could be "8" (or "3" could be "2") while the rest stays legible.
  for (const { area, glyph } of obscured) {
    blurRegion(ctx, area, 1, 1);
    blurRegion(ctx, glyph, 2, 2);
    ctx.fillStyle = 'rgba(40, 40, 40, 0.16)';
    ctx.beginPath();
    ctx.ellipse(
      glyph.x + glyph.w / 2,
      glyph.y + glyph.h * 0.5,
      glyph.w * 0.7,
      glyph.h * 0.42,
      -0.5,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }

  // Scan: off-white paper, a slight skew, light speckle.
  const scan = createCanvas(W, H);
  const sctx = scan.getContext('2d');
  sctx.fillStyle = '#f3f1ea';
  sctx.fillRect(0, 0, W, H);
  sctx.translate(W / 2, H / 2);
  sctx.rotate(((rand() - 0.5) * 1.2 * Math.PI) / 180);
  sctx.globalAlpha = 0.93;
  sctx.drawImage(page, -W / 2 + (rand() - 0.5) * 10, -H / 2 + (rand() - 0.5) * 10);
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.globalAlpha = 1;
  sctx.fillStyle = 'rgba(30, 30, 30, 0.35)';
  for (let i = 0; i < 2600; i++)
    sctx.fillRect(rand() * W, rand() * H, 1 + rand() * 1.5, 1 + rand() * 1.5);

  const jpeg = await scan.encode('jpeg', 72);

  const pdf = await PDFDocument.create();
  const fixed = new Date(`${statementDate}T12:00:00Z`);
  pdf.setTitle(`EOB ${ins.payerClaimNumber}`);
  pdf.setCreator('Plainbill synthetic seed data');
  pdf.setProducer('Plainbill seed (pdf-lib)');
  pdf.setCreationDate(fixed);
  pdf.setModificationDate(fixed);
  const img = await pdf.embedJpg(jpeg);
  const pdfPage = pdf.addPage([612, 792]);
  pdfPage.drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
  return pdf.save({ useObjectStreams: false });
}
