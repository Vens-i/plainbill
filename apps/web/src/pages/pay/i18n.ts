/**
 * Page text for the patient's bill (not the notes, which come from the server). English is the
 * reference; other languages fall back to it key by key. Amounts and dates are passed in already
 * formatted, so translations never touch numbers.
 */
import { createContext, useContext } from 'react';
import { formatMonthDay, formatSpanishDate, type IsoDate } from '@plainbill/core';

const EN = {
  topSecure: 'Secure bill for {name} · verified',
  notesIn: 'Notes in',
  heroOwe: 'Hi {name} — you owe',
  heroStillOwe: 'Hi {name} — you still owe',
  heroBalance: 'Hi {name} — your balance',
  visitWith: 'Visit {date} with {provider}',
  visit: 'Visit {date}',
  subInsurance: 'insurance has already paid its part',
  subSelfPay: 'self-pay rate',
  subPartial: "you've paid {amount} so far",
  subPlan: 'payment plan: {paid} of {months} paid',
  subPaid: 'This bill is paid. Thank you!',
  askButton: 'Ask about this bill',
  payOverTime: 'Pay over time',
  payAmount: 'Pay {amount}',
  payOrPlan: 'Pay {amount} or pay over time',
  captionTitle: 'The bill you got in the mail, explained',
  highlightsOn: 'Highlights on',
  highlightsOff: 'Highlights off',
  download: 'Download original',
  footnoteAi:
    "Notes written by AI from this statement. Every amount is checked against the clinic's records before you see it.",
  footnoteTemplate:
    "Notes written from this statement. Every amount is checked against the clinic's records before you see it.",
  synthetic: 'Synthetic sample statement.',
  howItWorks: 'How this works',
  chip: 'On your bill:',
  previous: '‹ Previous',
  next: 'Next ›',
  position: '{n} of {total}',
  noteLabel: 'Note {n}: {title}',
  noteLabelBare: 'Note {n}',
  stripLabel: 'Close-up of your bill: {quote}',
  unavailable: "Explanations aren't available right now.",
  statementLabel: 'Your itemized statement from {practice}, amount due {amount}',
  loadingStatement: 'Loading your statement',
  fallbackBanner: "We couldn't translate this right now. Call {phone} for help in your language.",
  shortVersion: 'The short version',
  tapBar: 'Tap a bar to learn what it means',
  termsTitle: 'What do these terms mean?',
  yourPayments: 'Your payments',
  footerPrefer: 'Prefer a person? Call',
  howTitle: 'How the highlights work',
  howLede:
    'The AI explains the lines. Code finds where they are, checks the money, and draws the arrows.',
  how1Title: 'Read the paper',
  how1Body:
    "The clinic's system printed this statement, so it already knows every line and where it sits on the page.",
  how2Title: "Point, don't draw",
  how2Body:
    'Claude gets the lines and your balance, worked out by code, and writes a short note for each line. It never decides where anything goes.',
  how3Title: 'Check every number',
  how3Body:
    "Code checks every amount in a note against the clinic's records. A note that fails is replaced by a plain, pre-written one.",
  how4Title: 'Explain in your language',
  how4Body:
    'Short notes in plain English, Spanish, Kreyòl and more. The dollar amounts come from the checked balance.',
  how5Title: 'Draw it',
  how5Body:
    'The page draws the same statement as the PDF, highlights each line and points each note at it.',
  guard1: 'Money math stays in code',
  guard2: 'Shown only after the last name + date of birth check',
  guard3: 'Unsure about a line? The note says so and gives the office number',
  close: 'Close',
  language: 'Language',
  more: 'More',
  chooseLanguage: 'Choose a language for the notes',
  askTitle: 'Ask about your bill',
  askHelper: '✦ AI helper',
  askWhy: 'Why do I owe {amount}?',
  askPlan: 'Can I pay over time?',
  askRight: 'Is this right?',
  askPlaceholder: 'Type a question…',
  askLabel: 'Your question',
  askSend: 'Send question',
  preferPerson: 'Prefer a person? Call',
} as const;

export type I18nKey = keyof typeof EN;
/** Every key, for tests that check a table is complete. */
export const I18N_KEYS = Object.keys(EN) as I18nKey[];
type Table = Partial<Record<I18nKey, string>>;

const ES: Table = {
  topSecure: 'Factura segura para {name} · verificada',
  notesIn: 'Notas en',
  heroOwe: 'Hola {name} — usted debe',
  heroStillOwe: 'Hola {name} — todavía debe',
  heroBalance: 'Hola {name} — su saldo',
  visitWith: 'Visita del {date} con {provider}',
  visit: 'Visita del {date}',
  subInsurance: 'su seguro ya pagó su parte',
  subSelfPay: 'tarifa sin seguro',
  subPartial: 'ya pagó {amount}',
  subPlan: 'plan de pagos: {paid} de {months} pagados',
  subPaid: 'Esta factura está pagada. ¡Gracias!',
  askButton: 'Preguntar sobre esta factura',
  payOverTime: 'Pagar en cuotas',
  payAmount: 'Pagar {amount}',
  payOrPlan: 'Pagar {amount} o en cuotas',
  captionTitle: 'La factura que recibió por correo, explicada',
  highlightsOn: 'Resaltado activado',
  highlightsOff: 'Resaltado desactivado',
  download: 'Descargar original',
  footnoteAi:
    'Notas escritas por IA a partir de este estado de cuenta. Cada cantidad se verifica con los registros de la clínica antes de que usted la vea.',
  footnoteTemplate:
    'Notas escritas a partir de este estado de cuenta. Cada cantidad se verifica con los registros de la clínica antes de que usted la vea.',
  synthetic: 'Estado de cuenta de muestra, con datos ficticios.',
  howItWorks: 'Cómo funciona',
  chip: 'En su factura:',
  previous: '‹ Anterior',
  next: 'Siguiente ›',
  position: '{n} de {total}',
  noteLabel: 'Nota {n}: {title}',
  noteLabelBare: 'Nota {n}',
  stripLabel: 'Detalle de su factura: {quote}',
  unavailable: 'Las explicaciones no están disponibles en este momento.',
  statementLabel: 'Su estado de cuenta detallado de {practice}, cantidad a pagar {amount}',
  loadingStatement: 'Cargando su estado de cuenta',
  fallbackBanner:
    'No pudimos traducir esto en este momento. Llame al {phone} para recibir ayuda en su idioma.',
  shortVersion: 'La versión corta',
  tapBar: 'Toque una barra para ver qué significa',
  termsTitle: '¿Qué significan estos términos?',
  yourPayments: 'Sus pagos',
  footerPrefer: '¿Prefiere hablar con una persona? Llame al',
  howTitle: 'Cómo funcionan las marcas',
  howLede:
    'La IA explica las líneas. El código encuentra dónde están, revisa el dinero y dibuja las flechas.',
  how1Title: 'Leer el papel',
  how1Body:
    'El sistema de la clínica imprimió este estado de cuenta, así que ya conoce cada línea y dónde está en la página.',
  how2Title: 'Señalar, no dibujar',
  how2Body:
    'Claude recibe las líneas y su saldo, calculado por código, y escribe una nota corta para cada línea. Nunca decide dónde va nada.',
  how3Title: 'Revisar cada número',
  how3Body:
    'El código revisa cada cantidad de una nota con los registros de la clínica. Si una nota no pasa, se usa una nota sencilla ya escrita.',
  how4Title: 'Explicar en su idioma',
  how4Body:
    'Notas cortas en inglés sencillo, español, kreyòl y más. Las cantidades vienen del saldo ya revisado.',
  how5Title: 'Dibujarlo',
  how5Body:
    'La página dibuja el mismo estado de cuenta que el PDF, resalta cada línea y apunta cada nota hacia ella.',
  guard1: 'Los cálculos de dinero los hace el código',
  guard2: 'Se muestra solo después de verificar su apellido y fecha de nacimiento',
  guard3: '¿Dudas sobre una línea? La nota lo dice y da el número de la oficina',
  close: 'Cerrar',
  language: 'Idioma',
  more: 'Más',
  chooseLanguage: 'Elija el idioma de las notas',
  askTitle: 'Pregunte sobre su factura',
  askHelper: '✦ Asistente con IA',
  askWhy: '¿Por qué debo {amount}?',
  askPlan: '¿Puedo pagar en cuotas?',
  askRight: '¿Está bien esto?',
  askPlaceholder: 'Escriba una pregunta…',
  askLabel: 'Su pregunta',
  askSend: 'Enviar pregunta',
  preferPerson: '¿Prefiere hablar con una persona? Llame al',
};

const TABLES: Record<string, Table> = { en: EN, es: ES };

/** Languages with hand-written page text; others translate only the notes. */
export function hasPageText(lang: string): boolean {
  return lang in TABLES;
}

export type Translate = (key: I18nKey, vars?: Record<string, string | number>) => string;

export function translator(lang: string): Translate {
  const table = TABLES[lang] ?? EN;
  return (key, vars) =>
    (table[key] ?? EN[key]).replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? ''));
}

/** "Oct 3" / "3 de octubre" */
export function formatDay(date: IsoDate, lang: string): string {
  return lang === 'es' ? formatSpanishDate(date) : formatMonthDay(date);
}

export interface I18n {
  /** The notes' language (any NOTE_LANGUAGES code). */
  lang: string;
  t: Translate;
}

export const I18nContext = createContext<I18n>({ lang: 'en', t: translator('en') });

export const useI18n = () => useContext(I18nContext);
