/**
 * Intake routes: upload files into the open batch, resolve AI flags, approve or discard.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { IntakeApproveResult, IntakeBatchView } from '../contract';
import {
  addFileToBatch,
  approveBatch,
  batchView,
  discardBatch,
  getOpenBatch,
  getOrCreateOpenBatch,
  IntakeError,
  resolveFlag,
} from '../services/intake';
import { publishChanged, type RouteContext } from './context';

export function registerIntakeRoutes(
  api: FastifyInstance,
  ctx: RouteContext,
  devRoutes: boolean,
): void {
  const currentBatch = (): IntakeBatchView | null => {
    const open = getOpenBatch(ctx.db, ctx.practiceId());
    return open ? batchView(ctx.db, ctx.practiceId(), open.id) : null;
  };

  api.get('/intake/batch', async () => ({ batch: currentBatch() }));

  /** multipart/form-data, one or more files. Each file is parsed or read by AI before replying. */
  api.post('/intake/files', async (request) => {
    if (!request.isMultipart()) throw new IntakeError('Upload files as multipart/form-data.');
    const batchId = getOrCreateOpenBatch(ctx.db, ctx.practiceId());
    let count = 0;
    for await (const part of request.files()) {
      const bytes = await part.toBuffer();
      if (bytes.length === 0) continue;
      await addFileToBatch(ctx.db, ctx.ai.extractor, batchId, ctx.practiceId(), {
        fileName: basename(part.filename),
        bytes,
      });
      count++;
    }
    if (count === 0) throw new IntakeError('No files received.');
    return { batch: batchView(ctx.db, ctx.practiceId(), batchId) };
  });

  api.patch<{ Params: { id: string }; Body: { path?: unknown; value?: unknown } }>(
    '/intake/items/:id/flags',
    async (request) => {
      const { path, value } = request.body ?? {};
      if (typeof path !== 'string' || typeof value !== 'string' || !value.trim()) {
        throw new IntakeError('Send { path, value } for the field to confirm.');
      }
      resolveFlag(ctx.db, Number(request.params.id), path, value);
      return { batch: currentBatch() };
    },
  );

  api.post('/intake/batch/approve', async (): Promise<IntakeApproveResult> => {
    const open = getOpenBatch(ctx.db, ctx.practiceId());
    if (!open) throw new IntakeError('There is nothing to approve.', 404);
    const result = approveBatch(ctx.db, open.id, ctx.practiceId());
    publishChanged(
      ctx,
      result.approved.map((a) => a.balanceId),
    );
    return { ...result, batch: batchView(ctx.db, ctx.practiceId(), open.id) };
  });

  api.post('/intake/batch/discard', async () => {
    const open = getOpenBatch(ctx.db, ctx.practiceId());
    if (open) discardBatch(ctx.db, open.id);
    return { batch: null };
  });

  if (devRoutes) {
    /** Dev only: add sample files from seed/data to the batch, for rehearsing the Intake demo. */
    api.post<{ Body: { files?: unknown } }>('/dev/intake-samples', async (request) => {
      const files = request.body?.files;
      if (!Array.isArray(files) || files.some((f) => typeof f !== 'string')) {
        throw new IntakeError('Send { files: ["bcbs_era_1008.835", …] }.');
      }
      const batchId = getOrCreateOpenBatch(ctx.db, ctx.practiceId());
      for (const name of files as string[]) {
        const path = join(ctx.sampleDir, basename(name));
        if (!existsSync(path)) throw new IntakeError(`No sample file named ${name}.`, 404);
        await addFileToBatch(ctx.db, ctx.ai.extractor, batchId, ctx.practiceId(), {
          fileName: basename(name),
          bytes: readFileSync(path),
        });
      }
      return { batch: batchView(ctx.db, ctx.practiceId(), batchId) };
    });
  }
}
