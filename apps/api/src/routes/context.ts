import type { EobExtractor, MessageDrafter } from '@plainbill/ai';
import type { IsoDate } from '@plainbill/core';
import type { Db } from '../db/client';
import type { EventBus } from '../events';

/** AI services the API uses. Without an API key: recorded EOB extractions + template messages. */
export interface AiServices {
  extractor: EobExtractor;
  drafter: MessageDrafter;
  /** True when a live model is configured. */
  available: boolean;
  model: string | null;
}

export interface RouteContext {
  db: Db;
  bus: EventBus;
  ai: AiServices;
  today: () => IsoDate;
  practiceId: () => number;
  /** Directory dev routes may read sample files from. */
  sampleDir: string;
}

export function publishChanged(ctx: RouteContext, ids: number[]): void {
  if (ids.length) ctx.bus.publish({ type: 'balances.changed', data: { ids } });
}
