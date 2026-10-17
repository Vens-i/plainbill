import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { todayIso, type IsoDate } from '@plainbill/core';
import type { PatientNamesMode } from './contract';

/** Repo root: apps/api/src → ../../.. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const envFile = resolve(REPO_ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function resolveFromRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path);
}

export interface Config {
  port: number;
  host: string;
  databasePath: string;
  /** Pinned "today" for the demo (DEMO_TODAY), or null for the real date. */
  demoToday: IsoDate | null;
  /** Dev-only routes such as /api/dev/simulate-payment. Off in production. */
  devRoutes: boolean;
  ai: {
    apiKeySet: boolean;
    model: string | null;
    /** auto: recorded extraction when one exists for the file, else live; live; recorded. */
    eobMode: 'auto' | 'live' | 'recorded';
    recordingsDir: string;
  };
  paypal: {
    clientId: string | null;
    clientSecret: string | null;
    env: 'sandbox' | 'live';
    /** Needed to verify webhook signatures; webhooks are refused without it. */
    webhookId: string | null;
    /** Seconds between reconciliation polls of open PayPal invoices and plans; 0 turns it off. */
    syncSeconds: number;
  };
  email: {
    resendApiKey: string | null;
    from: string;
    /** For testing: every patient email goes to this address instead of the one on file. */
    toOverride: string | null;
  };
  /** Public base URL for patient links in emails ("http://localhost:5173"). */
  appBaseUrl: string;
  /** Signs patient-page sessions. A random one is generated per process when unset. */
  sessionSecret: string | null;
  /** Built web app to serve from the API (one origin in production), or null. */
  webDist: string | null;
  insights: {
    /**
     * How patients appear in Practice insights, whose data goes to the AI analyst (Claude):
     * full names, first name + last initial, or "Patient 7" labels (INSIGHTS_PATIENT_NAMES).
     */
    patientNames: PatientNamesMode;
  };
}

const blank = (v: string | undefined) => v?.trim() || null;

const PATIENT_NAMES: PatientNamesMode[] = ['full', 'initials', 'off'];

function patientNames(value: string | undefined): PatientNamesMode {
  const v = blank(value)?.toLowerCase() ?? 'full';
  if (!(PATIENT_NAMES as string[]).includes(v)) {
    throw new Error(
      `INSIGHTS_PATIENT_NAMES must be one of ${PATIENT_NAMES.join(', ')} (got "${value}").`,
    );
  }
  return v as PatientNamesMode;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const demoToday = env.DEMO_TODAY?.trim() || null;
  if (demoToday) todayIso(demoToday); // validates the format
  return {
    // API_PORT locally (PORT belongs to the web dev server); hosts like Render inject PORT in production.
    port: Number(env.API_PORT || (production ? env.PORT : undefined) || 3001),
    host: env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1'),
    databasePath: resolveFromRoot(env.DATABASE_PATH?.trim() || 'apps/api/data/plainbill.db'),
    demoToday,
    devRoutes: env.ENABLE_DEV_ROUTES ? env.ENABLE_DEV_ROUTES === 'true' : !production,
    ai: {
      apiKeySet: Boolean(env.ANTHROPIC_API_KEY?.trim()),
      model: env.ANTHROPIC_MODEL?.trim() || null,
      eobMode:
        env.AI_EOB_MODE === 'live' || env.AI_EOB_MODE === 'recorded' ? env.AI_EOB_MODE : 'auto',
      recordingsDir: resolveFromRoot(env.EOB_RECORDINGS_DIR?.trim() || 'seed/data/eob-recordings'),
    },
    paypal: {
      clientId: blank(env.PAYPAL_CLIENT_ID),
      clientSecret: blank(env.PAYPAL_CLIENT_SECRET),
      env: env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox',
      webhookId: blank(env.PAYPAL_WEBHOOK_ID),
      syncSeconds: Math.max(0, Number(env.PAYPAL_SYNC_SECONDS ?? 20) || 0),
    },
    email: {
      resendApiKey: blank(env.RESEND_API_KEY),
      from: blank(env.EMAIL_FROM) ?? 'Harborview Family Medicine <onboarding@resend.dev>',
      toOverride: blank(env.EMAIL_TO_OVERRIDE),
    },
    // Render sets RENDER_EXTERNAL_URL to the service's public https URL.
    appBaseUrl: (
      blank(env.APP_BASE_URL) ??
      blank(env.RENDER_EXTERNAL_URL) ??
      'http://localhost:5173'
    ).replace(/\/+$/, ''),
    sessionSecret: blank(env.SESSION_SECRET),
    webDist:
      (env.SERVE_WEB ? env.SERVE_WEB === 'true' : production) &&
      existsSync(resolve(REPO_ROOT, 'apps/web/dist/index.html'))
        ? resolve(REPO_ROOT, 'apps/web/dist')
        : null,
    insights: { patientNames: patientNames(env.INSIGHTS_PATIENT_NAMES) },
  };
}
