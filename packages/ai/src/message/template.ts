/**
 * Deterministic patient messages. Used when no API key is configured, when the model's draft
 * fails the guard twice, and in tests. Same facts, same rules as the AI draft.
 */
import { formatMoneyShort, formatMonthDay } from '@plainbill/core';
import type { MessageFacts, MessageVariant } from './facts';

const m = formatMoneyShort;

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

function spanishDate(iso: string): string {
  return `${Number(iso.slice(8, 10))} de ${SPANISH_MONTHS[Number(iso.slice(5, 7)) - 1]}`;
}

/** " el Dr. Patel" for Spanish sentences; empty when no provider is named. */
function spanishProvider(f: MessageFacts): string {
  return f.providerName ? ` ${f.providerName.replace(/^Dr\./, 'el Dr.')}` : '';
}

function planEnglish(f: MessageFacts): string {
  if (!f.plan) return 'You can pay in full online.';
  return f.plan.firstCents === f.plan.regularCents
    ? `You can pay in full or split it into ${f.plan.months} payments of ${m(f.plan.regularCents)}.`
    : `You can pay in full or split it into ${f.plan.months} payments: ${m(f.plan.firstCents)} first, then ${m(f.plan.regularCents)} a month.`;
}

function planSpanish(f: MessageFacts): string {
  if (!f.plan) return 'Puede pagar el total en línea.';
  return f.plan.firstCents === f.plan.regularCents
    ? `Puede pagar el total o dividirlo en ${f.plan.months} pagos de ${m(f.plan.regularCents)}.`
    : `Puede pagar el total o dividirlo en ${f.plan.months} pagos: ${m(f.plan.firstCents)} el primero y luego ${m(f.plan.regularCents)} al mes.`;
}

function shareEnglish(f: MessageFacts): string {
  const parts = [
    f.deductibleCents && `${m(f.deductibleCents)} toward your yearly deductible`,
    f.coinsuranceCents && `${m(f.coinsuranceCents)} for your share of the cost`,
    f.copayCents && `${m(f.copayCents)} for your copay`,
    f.otherPatientCents && `${m(f.otherPatientCents)} your plan doesn't cover`,
  ].filter(Boolean);
  return parts.join(' plus ');
}

function shareSpanish(f: MessageFacts): string {
  const parts = [
    f.deductibleCents && `${m(f.deductibleCents)} de su deducible anual`,
    f.coinsuranceCents && `${m(f.coinsuranceCents)} de su parte del costo (coseguro)`,
    f.copayCents && `${m(f.copayCents)} de su copago`,
    f.otherPatientCents && `${m(f.otherPatientCents)} que su plan no cubre`,
  ].filter(Boolean);
  return parts.join(' más ');
}

export function templateMessage(f: MessageFacts, variant: MessageVariant): string {
  const date = formatMonthDay(f.visitDate);
  const name = f.patientFirstName;

  if (variant === 'spanish') {
    const provider = spanishProvider(f);
    const intro = `Hola ${name}, gracias por su visita${provider ? ` con${provider}` : ''} el ${spanishDate(f.visitDate)}.`;
    if (f.selfPay) {
      return `${intro} Su visita costó ${m(f.owesCents)} con nuestra tarifa sin seguro. ${planSpanish(f)}`;
    }
    const share = shareSpanish(f);
    return (
      `${intro} Su visita costó ${m(f.billedCents)}. Su plan ${f.payerShortName ?? ''} lo redujo a ` +
      `${m(f.billedCents - f.discountCents)} y pagó ${m(f.insurancePaidCents)}. Le quedan ${m(f.owesCents)}` +
      `${share ? `: ${share}` : ''}. ${planSpanish(f)}`
    ).replace(/\s+/g, ' ');
  }

  if (variant === 'simpler') {
    const covered = f.selfPay ? '' : ' Your insurance already covered the rest.';
    const plan = f.plan
      ? f.plan.firstCents === f.plan.regularCents
        ? ` You can pay it all at once or in ${f.plan.months} payments of ${m(f.plan.regularCents)}.`
        : ` You can pay it all at once or in ${f.plan.months} smaller payments.`
      : '';
    return `Hi ${name}. You owe ${m(f.owesCents)} for your ${date} visit${f.providerName ? ` with ${f.providerName}` : ''}.${covered}${plan}`;
  }

  const intro = `Hi ${name}, thanks for visiting ${f.providerName ?? f.practiceName} on ${date}.`;
  if (f.selfPay) {
    return `${intro} Your visit came to ${m(f.owesCents)} at our self-pay rate. ${planEnglish(f)}`;
  }
  const share = shareEnglish(f);
  return (
    `${intro} Your visit came to ${m(f.billedCents)}. Your ${f.payerShortName ?? 'insurance'} plan lowered that to ` +
    `${m(f.billedCents - f.discountCents)} and paid ${m(f.insurancePaidCents)}. The ${m(f.owesCents)} left is ` +
    `${share || 'your share of the cost'}. ${planEnglish(f)}`
  );
}
