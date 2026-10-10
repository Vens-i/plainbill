import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { todayIso, type IsoDate } from '@plainbill/core';

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
  };
}
