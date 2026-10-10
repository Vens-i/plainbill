import {
  ClaudeEobExtractor,
  ClaudeMessageDrafter,
  createClaudeClient,
  RecordedEobExtractor,
  RecordedThenLiveExtractor,
} from '@plainbill/ai';
import { buildApp, offlineAi } from './app';
import { openDatabase } from './db/client';
import { loadConfig, type Config } from './env';
import type { AiServices } from './routes/context';

function aiServices(config: Config): AiServices {
  const { apiKeySet, model, eobMode, recordingsDir } = config.ai;
  if (!apiKeySet || !model || eobMode === 'recorded') return offlineAi(recordingsDir);
  const client = createClaudeClient();
  const live = new ClaudeEobExtractor({ client, model });
  return {
    // "auto" replays recorded extractions for the seed's sample EOBs (stable demos) and reads
    // anything else live.
    extractor:
      eobMode === 'live'
        ? live
        : new RecordedThenLiveExtractor(new RecordedEobExtractor(recordingsDir), live),
    drafter: new ClaudeMessageDrafter({ client, model }),
    available: true,
    model,
  };
}

const config = loadConfig();
const { db } = openDatabase(config.databasePath);
const ai = aiServices(config);
const { app } = buildApp({
  db,
  demoToday: config.demoToday,
  devRoutes: config.devRoutes,
  logger: true,
  ai,
});

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `Plainbill API on http://${config.host}:${config.port}/api · db ${config.databasePath} · today ${config.demoToday ?? 'real date'}` +
      ` · AI ${ai.available ? `${ai.model} (EOBs: ${config.ai.eobMode})` : 'offline (recorded + templates)'}` +
      (config.devRoutes ? ' · dev routes on' : ''),
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
