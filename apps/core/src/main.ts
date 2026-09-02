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
  services.planSupervisor.start();
  console.log(`jarvis-core ${VERSION} starting`);
  console.log(`  database   : ${config.database}`);
  console.log(`  hosts      : ${config.hosts.join(', ')}`);
  console.log(`  index      : ${config.indexUrl}`);
  console.log(`  spool root : ${config.spoolRoot}`);
  /**
   * Un spool que empieza por el home de ESTE proceso casi siempre es un `$HOME` que se expandió
   * donde no debía —Compose lo interpola con el entorno del bastión— y entonces cada máquina de
   * la flota intenta escribir en el home de otra. El síntoma en el otro extremo es un
   * `mkdir: Permission denied` que no señala a la configuración por ningún lado, así que se avisa
   * aquí, que es donde todavía se puede entender.
   */
  const localHome = process.env['HOME'];
  if (localHome && config.spoolRoot.startsWith(`${localHome}/`)) {
    console.warn(`  AVISO      : el spool apunta al home de este proceso (${localHome}). Si los`
      + ' agentes corren en otras máquinas, escríbelo como ~/... para que se resuelva en cada una.');
  }
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
