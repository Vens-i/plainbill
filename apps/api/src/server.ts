import { buildApp } from './app';
import { openDatabase } from './db/client';
import { loadConfig } from './env';

const config = loadConfig();
const { db } = openDatabase(config.databasePath);
const { app } = buildApp({
  db,
  demoToday: config.demoToday,
  devRoutes: config.devRoutes,
  logger: true,
});

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `Plainbill API on http://${config.host}:${config.port}/api · db ${config.databasePath} · today ${config.demoToday ?? 'real date'}` +
      (config.devRoutes ? ' · dev routes on' : ''),
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
