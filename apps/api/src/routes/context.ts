import type {
  BillAssistant,
  EobExtractor,
  MessageDrafter,
  StatementAnnotator,
  Suggester,
  StudioRunner,
} from '@plainbill/ai';
import type { IsoDate } from '@plainbill/core';
import type { PatientNamesMode } from '../contract';
import type { Db } from '../db/client';
import type { EventBus } from '../events';
import type { AgentPayPalTools } from '../paypal/agent';
import type { PayPalApi } from '../paypal/client';
import type { Mailer } from '../services/email';
import type { PatientSessions } from '../services/sessions';

/** AI services the API uses. Without an API key: recorded EOB extractions + template messages. */
export interface AiServices {
  extractor: EobExtractor;
  drafter: MessageDrafter;
  /** The patient's "Ask about your bill" helper. */
  assistant: BillAssistant;
  /** Writes the dashboard's "AI suggests" column. */
  suggester: Suggester;
  /** Writes the margin notes on the patient's itemized statement. */
  annotator: StatementAnnotator;
  /** Runs the AG Studio agent's turns on Practice insights. */
  studio: StudioRunner;
  /** True when a live model is configured. */
  available: boolean;
  model: string | null;
}

export interface PayPalServices {
  /** Null when PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET aren't set: sends stay local. */
  api: PayPalApi | null;
  /** Public client id for the browser SDK. */
  clientId: string | null;
  env: 'sandbox' | 'live';
  /** Webhooks are refused (not trusted) without it. */
  webhookId: string | null;
  /** PayPal Agent Toolkit actions for the bill helper (create order / subscription). */
  agent?: AgentPayPalTools | null;
}

export interface EmailServices {
  mailer: Mailer;
  /** For testing: deliver every patient email here instead of the address on file. */
  toOverride: string | null;
}

/** Runs async jobs one at a time, so payment bookkeeping never interleaves. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export interface RouteContext {
  db: Db;
  bus: EventBus;
  ai: AiServices;
  paypal: PayPalServices;
  email: EmailServices;
  sessions: PatientSessions;
  queue: SerialQueue;
  today: () => IsoDate;
  practiceId: () => number;
  /** Public base URL for patient links ("http://localhost:5173"). */
  appBaseUrl: string;
  /** Directory dev routes may read sample files from. */
  sampleDir: string;
  /** How patients appear in Practice insights, whose data goes to the AI analyst. */
  insights: { patientNames: PatientNamesMode };
  log: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

export function publishChanged(ctx: Pick<RouteContext, 'bus'>, ids: number[]): void {
  if (ids.length) ctx.bus.publish({ type: 'balances.changed', data: { ids } });
}
