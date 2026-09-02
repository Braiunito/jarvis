#!/usr/bin/env node
import { buildGateway } from './app.js';
import { config, describeConfig } from './config.js';

const app = buildGateway({ logger: true });

app.listen({ port: config.port, host: config.bind })
  .then(() => {
    const settings = describeConfig();
    console.log(`jarvis-gateway listening on ${config.bind}:${config.port}`);
    console.log(`  relying party : ${settings.rpId}`);
    console.log(`  origins       : ${settings.origins.join(', ')}`);
    console.log(`  auth policy   : ${settings.authPolicy.join(' + ')}`
      + (settings.requireUserVerification ? ' (biometric/PIN required)' : ''));
    console.log(`  static app    : ${config.staticDir}`);
    console.log(`  core          : ${settings.coreUrl}`);
    if (!settings.secureCookies) {
      console.warn('  WARNING: insecure cookies enabled — development only, never expose this.');
    }
    if (settings.insecureLogin) {
      // Deliberadamente ruidoso: es el ajuste que no puede olvidarse encendido.
      console.warn('');
      console.warn('  ***********************************************************************');
      console.warn('  *  PLAIN-HTTP PASSWORD LOGIN IS ENABLED (JARVIS_INSECURE_LOGIN=true)  *');
      console.warn('  *  Passkeys cannot work without HTTPS. Temporary measure only.        *');
      console.warn(`  *  Restricted to private networks: ${String(settings.insecureLoginLanOnly).padEnd(5)}                              *`);
      console.warn('  ***********************************************************************');
      console.warn('');
    }
    if (settings.rpId === 'localhost' && !process.env['JARVIS_RP_ID']) {
      console.warn('  WARNING: JARVIS_RP_ID is unset. Passkeys enrolled now will not work on your '
        + 'real domain: the relying party id is baked into every credential.');
    }
  })
  .catch((error: unknown) => {
    console.error('[gateway] could not start:', error);
    process.exit(1);
  });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} received, closing.`);
    void app.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
