#!/usr/bin/env node
import { buildApp } from './app.js';
import { config } from './config.js';
import { buildServices, VERSION } from './services.js';

const services = buildServices({
  onSupervisorError: (error, runId) => {
    console.error(`[core] run ${runId}: ${error.message}`);
  },
});
const app = buildApp({ services, logger: true });

async function start(): Promise<void> {
  // Reconciliar antes de aceptar escrituras: lo primero es enterarse de qué quedó vivo.
  const reconciled = await services.supervisor.start();
  console.log(`jarvis-core ${VERSION} starting`);
  console.log(`  database   : ${config.database}`);
  console.log(`  hosts      : ${config.hosts.join(', ')}`);
  console.log(`  index      : ${config.indexUrl}`);
  console.log(`  spool root : ${config.spoolRoot}`);
  console.log(`  reconciled : ${JSON.stringify(reconciled ?? {})}`);
  await app.listen({ port: config.port, host: config.bind });
  console.log(`jarvis-core listening on ${config.bind}:${config.port}`);
}

start().catch((error: unknown) => {
  console.error('[core] could not start:', error);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} received, closing.`);
    services.supervisor.stop();
    void app.close().then(() => {
      services.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
