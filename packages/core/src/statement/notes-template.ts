/**
 * Deterministic margin notes for the statement, one per anchor, in English or Spanish. Used
 * when no model is configured, when a model's note fails the guard twice, and as the reference
 * the AI notes are held to: a title of at most 5 words, a body of at most 35, and only the
 * figures listed on that anchor.
 */
import { formatMonthDay, type IsoDate } from '../dates';
import { formatMoney, formatMoneyShort, type Cents } from '../money';
import { patientServiceLabel } from '../procedures';
import type { Anchor, StatementLayout } from './layout';
import type { StatementModel } from './model';

export type TemplateNoteLang = 'en' | 'es';

export interface StatementNoteText {
  anchorId: string;
  title: string;
  body: string;
}

export const NOTE_TITLE_MAX_WORDS = 5;
export const NOTE_BODY_MAX_WORDS = 35;

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** The figures a note about this anchor may mention: its own, plus what the patient owes. */
export function allowedNoteAmounts(anchor: Pick<Anchor, 'amountsCents'>, remainingCents: Cents) {
  return new Set([...anchor.amountsCents, remainingCents]);
}

const SPANISH_MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** "3 de octubre" */
export function formatSpanishDate(date: IsoDate): string {
  return `${Number(date.slice(8, 10))} de ${SPANISH_MONTHS[Number(date.slice(5, 7)) - 1]}`;
}

const $ = formatMoneyShort;

/** "office visit, blood work and heart rhythm test (ECG)" — at most three, then "N more". */
function serviceList(codes: string[], lang: TemplateNoteLang): string {
  const names = [...new Set(codes.map((c) => patientServiceLabel(c, lang)))].map((n) =>
    // Lower-case the first letter unless the name starts with an acronym ("MRI").
    /^.[a-záéíóúñ]/.test(n) ? n.charAt(0).toLowerCase() + n.slice(1) : n,
  );
  const shown = names.length > 3 ? names.slice(0, 2) : names;
  const more = names.length - shown.length;
  const and = lang === 'es' ? 'y' : 'and';
  if (more > 0) {
    shown.push(lang === 'es' ? `${more} servicios más` : `${more} more services`);
  }
  if (shown.length === 1) return shown[0]!;
  return `${shown.slice(0, -1).join(', ')} ${and} ${shown.at(-1)}`;
}

function englishNote(model: StatementModel, anchor: Anchor): Omit<StatementNoteText, 'anchorId'> {
  const { input, totals } = model;
  const { visit } = input;
  const s = input.patientShare;
  const phone = input.practice.phone;
  const remaining = totals.remainingCents;
  const active = input.planActive && input.planActive.paidCount < input.planActive.months;

  switch (anchor.kind) {
    case 'amount_due':
      if (remaining === 0) {
        return {
          title: "You're all paid up",
          body: `Your balance is ${formatMoney(0)}. Thank you! Nothing else is due for this visit.`,
        };
      }
      return {
        title: 'This is what you owe',
        body: active
          ? `${formatMoney(remaining)} is what's left. Your payment plan takes care of it automatically.`
          : totals.patientPaidCents > 0
            ? `${formatMoney(remaining)} is what's left after your payments. Thank you for what you've paid so far.`
            : visit.selfPay
              ? `${formatMoney(remaining)}, and that's the whole amount. It's the self-pay price for your visit.`
              : `${formatMoney(remaining)}, and that's the whole amount. The bigger numbers further down are the full price before insurance.`,
      };
    case 'charges': {
      const codes = model.rows.filter((r) => r.anchor === 'charges').map((r) => r.code);
      const who = visit.providerName ? ` with ${visit.providerName}` : '';
      const before = visit.selfPay
        ? input.contractualCents > 0
          ? 'Full price before your discount'
          : 'Full price'
        : 'Full price before insurance';
      return {
        title: 'What you had done',
        body: `Your ${formatMonthDay(visit.date)} visit${who}: ${serviceList(codes, 'en')}. ${before}: ${$(totals.billedCents)}.`,
      };
    }
    case 'insurance_payment':
      return {
        title: `Your insurance paid ${$(totals.insurancePaidCents)}`,
        body: `${visit.payerShortName} sent the clinic ${$(totals.insurancePaidCents)}${
          visit.paymentDate ? ` on ${formatMonthDay(visit.paymentDate)}` : ''
        }. Nothing for you to do on this line.`,
      };
    case 'discount':
      return visit.selfPay
        ? {
            title: 'Your self-pay discount',
            body: `${$(totals.contractualCents)} comes off the ${$(totals.billedCents)} full price because you're paying without insurance. You never pay this part.`,
          }
        : {
            title: 'A discount, not a bill',
            body: `${$(totals.contractualCents)} comes off because ${visit.providerName ?? 'the clinic'} is in your insurance network. You never pay this part.`,
          };
    case 'patient_responsibility': {
      const share = totals.patientShareCents;
      const title =
        share === remaining ? `Why there's still ${$(share)}` : `Your share: ${$(share)}`;
      const full = [
        s.deductibleCents &&
          `${$(s.deductibleCents)} goes toward your yearly deductible, the amount you pay before insurance pays more.`,
        s.coinsuranceCents &&
          `${$(s.coinsuranceCents)} is your coinsurance, your share of the cost after the deductible.`,
        s.copayCents &&
          `${$(s.copayCents)} is your copay, the set amount your plan charges for a visit.`,
        s.otherCents && `${$(s.otherCents)} is for something your plan doesn't cover.`,
      ].filter(Boolean);
      let body = full.join(' ');
      if (countWords(body) > NOTE_BODY_MAX_WORDS) {
        const parts = [
          s.deductibleCents && `${$(s.deductibleCents)} deductible`,
          s.coinsuranceCents && `${$(s.coinsuranceCents)} coinsurance`,
          s.copayCents && `${$(s.copayCents)} copay`,
          s.otherCents && `${$(s.otherCents)} not covered by your plan`,
        ].filter(Boolean);
        body = `Your share is ${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}. Questions? Call ${phone}.`;
      }
      return { title, body };
    }
    case 'patient_payment': {
      const row = model.rows.find((r) => r.id === anchor.id)!;
      return {
        title: 'Your payment: thank you',
        body: `You paid ${$(row.creditCents!)} on ${formatMonthDay(row.date)}. Thank you! It's already taken off your balance.`,
      };
    }
    case 'messages': {
      const plan = input.planActive;
      if (remaining === 0) {
        return {
          title: 'All set',
          body: `There's nothing left to pay for this visit. Questions? Call ${phone}.`,
        };
      }
      if (plan && active) {
        const next =
          plan.nextCents && plan.nextDate
            ? ` Next ${$(plan.nextCents)} on ${formatMonthDay(plan.nextDate)}.`
            : '';
        return {
          title: 'Your payment plan',
          body: `You're on a ${plan.months}-month plan: ${plan.paidCount} of ${plan.months} paid.${next} Questions? Call ${phone}.`,
        };
      }
      const offer = input.planOffer;
      if (offer) {
        const split =
          offer.firstCents === offer.regularCents
            ? `${offer.months} payments of ${$(offer.regularCents)}`
            : `${offer.months} monthly payments (${$(offer.firstCents)} first, then ${$(offer.regularCents)})`;
        return {
          title: 'You have options',
          body: `Pay it all now, or split it into ${split} with no fees. Questions? Call ${phone}.`,
        };
      }
      return {
        title: "When it's due",
        body: `Please pay ${$(remaining)} by ${formatMonthDay(input.dueDate)}. Questions, or need more time? Call ${phone}.`,
      };
    }
  }
}

function spanishNote(model: StatementModel, anchor: Anchor): Omit<StatementNoteText, 'anchorId'> {
  const { input, totals } = model;
  const { visit } = input;
  const s = input.patientShare;
  const phone = input.practice.phone;
  const remaining = totals.remainingCents;
  const active = input.planActive && input.planActive.paidCount < input.planActive.months;
  // The provider is written as given, in parentheses, so the Spanish never guesses a gender.
  const provider = visit.providerName ? ` (${visit.providerName})` : '';

  switch (anchor.kind) {
    case 'amount_due':
      if (remaining === 0) {
        return {
          title: 'Ya no debe nada',
          body: `Su saldo es ${formatMoney(0)}. ¡Gracias! No tiene nada más que pagar por esta visita.`,
        };
      }
      return {
        title: 'Esto es lo que debe',
        body: active
          ? `${formatMoney(remaining)} es lo que queda. Su plan de pagos lo cubre automáticamente.`
          : totals.patientPaidCents > 0
            ? `${formatMoney(remaining)} es lo que queda después de sus pagos. Gracias por lo que ya pagó.`
            : visit.selfPay
              ? `${formatMoney(remaining)}, y esa es la cantidad total. Es el precio sin seguro de su visita.`
              : `${formatMoney(remaining)}, y esa es la cantidad total. Los números más grandes de abajo son el precio completo antes del seguro.`,
      };
    case 'charges': {
      const codes = model.rows.filter((r) => r.anchor === 'charges').map((r) => r.code);
      const before = visit.selfPay
        ? input.contractualCents > 0
          ? 'Precio completo antes de su descuento'
          : 'Precio completo'
        : 'Precio completo antes del seguro';
      return {
        title: 'Lo que le hicieron',
        body: `Su visita del ${formatSpanishDate(visit.date)}${provider}: ${serviceList(codes, 'es')}. ${before}: ${$(totals.billedCents)}.`,
      };
    }
    case 'insurance_payment':
      return {
        title: `Su seguro pagó ${$(totals.insurancePaidCents)}`,
        body: `${visit.payerShortName} le pagó ${$(totals.insurancePaidCents)} a la clínica${
          visit.paymentDate ? ` el ${formatSpanishDate(visit.paymentDate)}` : ''
        }. No tiene que hacer nada con esta línea.`,
      };
    case 'discount':
      return visit.selfPay
        ? {
            title: 'Su descuento sin seguro',
            body: `Se descuentan ${$(totals.contractualCents)} del precio completo de ${$(totals.billedCents)} porque paga sin seguro. Usted nunca paga esta parte.`,
          }
        : {
            title: 'Un descuento, no un cobro',
            body: `Se descuentan ${$(totals.contractualCents)} porque su proveedor${provider} está en la red de su seguro. Usted nunca paga esta parte.`,
          };
    case 'patient_responsibility': {
      const share = totals.patientShareCents;
      const title =
        share === remaining ? `¿Por qué todavía debe ${$(share)}?` : `Su parte: ${$(share)}`;
      const full = [
        s.deductibleCents &&
          `${$(s.deductibleCents)} van a su deducible del año: lo que usted paga antes de que su seguro pague más.`,
        s.coinsuranceCents &&
          `${$(s.coinsuranceCents)} es su coseguro: su parte del costo después del deducible.`,
        s.copayCents &&
          `${$(s.copayCents)} es su copago: la cantidad fija que su plan cobra por una visita.`,
        s.otherCents && `${$(s.otherCents)} es por algo que su plan no cubre.`,
      ].filter(Boolean);
      let body = full.join(' ');
      if (countWords(body) > NOTE_BODY_MAX_WORDS) {
        const parts = [
          s.deductibleCents && `${$(s.deductibleCents)} de deducible`,
          s.coinsuranceCents && `${$(s.coinsuranceCents)} de coseguro`,
          s.copayCents && `${$(s.copayCents)} de copago`,
          s.otherCents && `${$(s.otherCents)} que su plan no cubre`,
        ].filter(Boolean);
        body = `Su parte es ${parts.slice(0, -1).join(', ')} y ${parts.at(-1)}. ¿Preguntas? Llame al ${phone}.`;
      }
      return { title, body };
    }
    case 'patient_payment': {
      const row = model.rows.find((r) => r.id === anchor.id)!;
      return {
        title: 'Su pago: gracias',
        body: `Usted pagó ${$(row.creditCents!)} el ${formatSpanishDate(row.date)}. ¡Gracias! Ya está descontado de su saldo.`,
      };
    }
    case 'messages': {
      const plan = input.planActive;
      if (remaining === 0) {
        return {
          title: 'Todo listo',
          body: `No queda nada por pagar de esta visita. ¿Preguntas? Llame al ${phone}.`,
        };
      }
      if (plan && active) {
        const next =
          plan.nextCents && plan.nextDate
            ? ` Próximo pago: ${$(plan.nextCents)} el ${formatSpanishDate(plan.nextDate)}.`
            : '';
        return {
          title: 'Su plan de pagos',
          body: `Está en un plan de ${plan.months} meses: ${plan.paidCount} de ${plan.months} pagados.${next} ¿Preguntas? Llame al ${phone}.`,
        };
      }
      const offer = input.planOffer;
      if (offer) {
        const split =
          offer.firstCents === offer.regularCents
            ? `${offer.months} pagos de ${$(offer.regularCents)}`
            : `${offer.months} pagos mensuales (${$(offer.firstCents)} el primero y luego ${$(offer.regularCents)})`;
        return {
          title: 'Tiene opciones',
          body: `Pague todo ahora o divídalo en ${split} sin cargos. ¿Preguntas? Llame al ${phone}.`,
        };
      }
      return {
        title: 'Cuándo vence',
        body: `Por favor pague ${$(remaining)} antes del ${formatSpanishDate(input.dueDate)}. ¿Preguntas o necesita más tiempo? Llame al ${phone}.`,
      };
    }
  }
}

/** One note per anchor, in anchor (= note) order. */
export function templateStatementNotes(
  model: StatementModel,
  layout: StatementLayout,
  lang: TemplateNoteLang,
): StatementNoteText[] {
  const write = lang === 'es' ? spanishNote : englishNote;
  return layout.anchors.map((anchor) => ({ anchorId: anchor.id, ...write(model, anchor) }));
}
