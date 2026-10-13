/**
 * Draws a statement layout as a one-page PDF with pdf-lib's standard fonts (Helvetica,
 * Courier), so nothing is embedded and the output is small and deterministic. The layout uses a
 * top-left origin; PDF's is bottom-left, so every y is flipped here.
 */
import type { PDFFont } from 'pdf-lib';
import { PDFDocument, rgb, StandardFonts, type Color, type PDFPage } from 'pdf-lib';
import type { StatementFont, StatementLayout } from '@plainbill/core';

const FONT_NAMES: Record<StatementFont, StandardFonts> = {
  sans: StandardFonts.Helvetica,
  'sans-bold': StandardFonts.HelveticaBold,
  mono: StandardFonts.Courier,
  'mono-bold': StandardFonts.CourierBold,
};

function color(hex: string | undefined, fallback = '#1b1d1f'): Color {
  const h = (hex ?? fallback).replace('#', '');
  return rgb(
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  );
}

export interface StatementPdfMeta {
  title: string;
  /** The statement date, used as the creation date so the bytes don't change between renders. */
  date: string;
}

export async function renderStatementPdf(
  layout: StatementLayout,
  meta: StatementPdfMeta,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const when = new Date(`${meta.date}T12:00:00.000Z`);
  doc.setTitle(meta.title);
  doc.setSubject('Itemized patient statement (synthetic demo data)');
  doc.setCreator('Plainbill');
  doc.setProducer('Plainbill');
  doc.setCreationDate(when);
  doc.setModificationDate(when);

  const fonts = new Map<StatementFont, PDFFont>();
  for (const [key, name] of Object.entries(FONT_NAMES) as Array<[StatementFont, StandardFonts]>) {
    fonts.set(key, await doc.embedFont(name));
  }
  const page: PDFPage = doc.addPage([layout.width, layout.height]);
  const H = layout.height;

  for (const op of layout.ops) {
    switch (op.t) {
      case 'text': {
        const font = fonts.get(op.font)!;
        const width = font.widthOfTextAtSize(op.s, op.size);
        const x =
          op.align === 'right' ? op.x - width : op.align === 'center' ? op.x - width / 2 : op.x;
        page.drawText(op.s, { x, y: H - op.y, size: op.size, font, color: color(op.color) });
        break;
      }
      case 'rect':
        page.drawRectangle({
          x: op.x,
          y: H - op.y - op.h,
          width: op.w,
          height: op.h,
          ...(op.fill ? { color: color(op.fill) } : {}),
          ...(op.stroke
            ? { borderColor: color(op.stroke), borderWidth: op.lineWidth ?? 0.6 }
            : { borderWidth: 0 }),
        });
        break;
      case 'line':
        page.drawLine({
          start: { x: op.x1, y: H - op.y1 },
          end: { x: op.x2, y: H - op.y2 },
          thickness: op.lineWidth ?? 0.6,
          color: color(op.color),
          ...(op.dash ? { dashArray: op.dash } : {}),
        });
        break;
      case 'poly': {
        // drawSvgPath uses SVG's y-down coordinates from the given origin: the page's top-left.
        const path = op.points.map(([x, y], i) => `${i ? 'L' : 'M'} ${x} ${y}`).join(' ') + ' Z';
        page.drawSvgPath(path, { x: 0, y: H, color: color(op.fill), borderWidth: 0 });
        break;
      }
    }
  }
  return doc.save({ useObjectStreams: false });
}
