/**
 * Margin notes for the patient's itemized statement. Claude writes them (through the guarded
 * annotator) from the computed balance; code numbers them and attaches the printed line. Notes
 * are cached per invoice and language, and rewritten when the balance changes (a payment, a plan
 * starting or a plan being offered). Template notes aren't cached: they're instant, and not
 * caching them means a model that was briefly down gets another chance.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { annotateFactsFor, TemplateStatementAnnotator } from '@plainbill/ai';
import {
  isPastDue,
  noteLanguage,
  type NoteLanguage,
  type StatementNoteText,
} from '@plainbill/core';
import type { StatementNote, StatementNotes } from '../contract';
import { events, invoices, practices, statementNotes } from '../db/schema';
import { getBalanceRows } from '../queries/rows';
import { publishChanged, type RouteContext } from '../routes/context';
import { QuestionLimiter } from './assistant';
import { buildMessageFacts } from './drawer';
import { PatientError } from './patient';
import { statementFor, type Statement } from './statement';

type Ctx = Pick<RouteContext, 'db' | 'today' | 'appBaseUrl' | 'ai' | 'log'>;

/** What the notes depend on, beyond the statement's fixed lines (including being past due). */
export function balanceHash({ model }: Statement): string {
  const { totals, input } = model;
  const offer = input.planOffer ? `${input.planOffer.months}` : '-';
  const active = input.planActive
    ? `${input.planActive.months}/${input.planActive.paidCount}`
    : '-';
  const late = isPastDue(input) ? 'late' : 'due';
  return `${totals.remainingCents}:${totals.patientPaidCents}:${offer}:${active}:${late}`;
}

/** Number the notes and attach each anchor's printed line (both from code, not the model). */
export function numberNotes(statement: Statement, notes: StatementNoteText[]): StatementNote[] {
  return statement.layout.anchors.map((anchor, i) => {
    const note = notes.find((n) => n.anchorId === anchor.id);
    return {
      anchorId: anchor.id,
      n: i + 1,
      title: note?.title ?? '',
      body: note?.body ?? '',
      quote: anchor.quote,
    };
  });
}

const TEMPLATES = new TemplateStatementAnnotator();
/**
 * Generation is limited per bill so a link can't be used to run up model costs. Created lazily:
 * assistant.ts and this module import each other indirectly (through send.ts).
 */
let limiter: QuestionLimiter | null = null;
/** Generations in flight, so a send and a page load for the same notes share one model call. */
const inFlight = new Map<string, Promise<StatementNotes>>();

async function generate(
  ctx: Ctx,
  invoiceId: number,
  lang: NoteLanguage,
  statement: Statement,
  hash: string,
): Promise<StatementNotes> {
  const invoice = ctx.db.select().from(invoices).where(eq(invoices.id, invoiceId)).get()!;
  const [row] = getBalanceRows(ctx.db, ctx.today(), [invoice.balanceId]);
  const practice = ctx.db.select().from(practices).get()!;
  const base = buildMessageFacts(
    row!,
    practice.name,
    invoice.paymentOption ?? { type: 'full' },
    invoice.dueDate,
  );
  const facts = annotateFactsFor(base, statement, { code: lang.code, name: lang.name });
  limiter ??= new QuestionLimiter(20, 60 * 60_000);
  const useModel = ctx.ai.available && limiter.allow(invoiceId);
  const result = useModel
    ? await ctx.ai.annotator.annotate(facts)
    : await TEMPLATES.annotate(facts);
  if (result.diagnostics.length) {
    ctx.log.info(`Statement notes (${lang.code}): ${result.diagnostics.join(' | ')}`);
  }
  if (result.source !== 'template') {
    const values = {
      notes: result.notes,
      source: result.source,
      fallback: result.fallback,
      model: result.model,
      balanceHash: hash,
      createdAt: new Date().toISOString(),
    };
    ctx.db
      .insert(statementNotes)
      .values({ invoiceId, lang: lang.code, ...values })
      .onConflictDoUpdate({
        target: [statementNotes.invoiceId, statementNotes.lang],
        set: values,
      })
      .run();
  }
  return {
    lang: lang.code,
    notes: numberNotes(statement, result.notes),
    source: result.source,
    fallback: result.fallback,
  };
}

/** The notes for one invoice and language: cached when the balance is unchanged, else written. */
export async function statementNotesFor(
  ctx: Ctx,
  invoiceId: number,
  langCode: string,
): Promise<StatementNotes> {
  const lang = noteLanguage(langCode);
  if (!lang) throw new PatientError('That language is not available.', 400, 'bad_lang');
  const statement = statementFor(ctx, invoiceId);
  const hash = balanceHash(statement);
  const cached = ctx.db
    .select()
    .from(statementNotes)
    .where(and(eq(statementNotes.invoiceId, invoiceId), eq(statementNotes.lang, lang.code)))
    .get();
  if (cached && cached.balanceHash === hash) {
    return {
      lang: lang.code,
      notes: numberNotes(statement, cached.notes),
      source: cached.source,
      fallback: cached.fallback,
    };
  }
  const key = `${invoiceId}:${lang.code}:${hash}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const job = generate(ctx, invoiceId, lang, statement, hash).finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}

/**
 * After "Send invoice": write the English and Spanish notes in the background, so they're ready
 * when the patient opens the page and the send itself isn't slowed down. Not run through the
 * payment queue (a model call must never hold up a PayPal capture). Errors are only logged.
 */
export function prepareStatementNotes(ctx: Ctx, invoiceId: number): Promise<void> {
  if (!ctx.ai.available) return Promise.resolve();
  return Promise.all(
    ['en', 'es'].map((lang) =>
      statementNotesFor(ctx, invoiceId, lang).catch((err: unknown) => {
        ctx.log.warn(
          `Statement notes (${lang}) for invoice ${invoiceId}: ${(err as Error).message}`,
        );
      }),
    ),
  ).then(() => undefined);
}

/** A new "viewed" event at most this often per bill, so reloads and language switches don't spam. */
const VIEW_EVERY_MS = 30 * 60_000;

/**
 * Log that the patient looked at the statement (`statement.viewed`) and which language they read
 * the notes in (`statement.language`, when it changes), for the dashboard's detail panel.
 */
export function recordStatementView(
  ctx: Pick<RouteContext, 'db' | 'bus'>,
  invoice: { id: number; balanceId: number },
  lang: string,
  now = new Date(),
): void {
  const recent = ctx.db
    .select()
    .from(events)
    .where(
      and(
        eq(events.balanceId, invoice.balanceId),
        inArray(events.type, ['statement.viewed', 'statement.language']),
      ),
    )
    .orderBy(desc(events.id))
    .all();
  const lastViewed = recent.find((e) => e.type === 'statement.viewed');
  const lastLang = String(
    recent.find((e) => e.type === 'statement.language')?.payload.lang ?? 'en',
  );
  const at = now.toISOString();
  let changed = false;
  if (!lastViewed || now.getTime() - Date.parse(lastViewed.createdAt) > VIEW_EVERY_MS) {
    ctx.db
      .insert(events)
      .values({
        type: 'statement.viewed',
        balanceId: invoice.balanceId,
        payload: { invoiceId: invoice.id, lang },
        createdAt: at,
      })
      .run();
    changed = true;
  }
  if (lang !== lastLang) {
    ctx.db
      .insert(events)
      .values({
        type: 'statement.language',
        balanceId: invoice.balanceId,
        payload: { invoiceId: invoice.id, lang },
        createdAt: at,
      })
      .run();
    changed = true;
  }
  if (changed) publishChanged(ctx, [invoice.balanceId]);
}
