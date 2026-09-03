#!/usr/bin/env node
/**
 * El stack que usan las pruebas de punta a punta.
 *
 * Es el mismo `dev-local` pero con su propio estado, su propio puerto y una cuenta ya creada, de
 * forma que la suite no dependa de lo que haya quedado de una sesión anterior.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * El front se construye si el bundle está viejo, y se dice.
 *
 * Esto sirve `apps/web/dist`, que no lo genera nadie por el camino: `tsc -b` compila el core y el
 * gateway, pero el navegador se lleva lo que dejó el último `vite build`. Sin esta comprobación,
 * una pantalla recién cambiada se prueba contra el bundle anterior y la suite falla diciendo que
 * no encuentra un botón que sí está en el código — o, peor, pasa en verde sin haber probado el
 * cambio. Cuesta cinco segundos y ahorra media hora de buscar en el sitio equivocado.
 */
function masReciente(dir) {
  let ultimo = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    ultimo = Math.max(ultimo, entry.isDirectory() ? masReciente(full) : statSync(full).mtimeMs);
  }
  return ultimo;
}

const bundle = join(root, 'apps/web/dist');
const fuentes = join(root, 'apps/web/src');
const bundleAl = existsSync(bundle) ? masReciente(bundle) : 0;
if (existsSync(fuentes) && masReciente(fuentes) > bundleAl) {
  console.log('[e2e] el front está más nuevo que su bundle: construyendo apps/web…');
  const built = spawnSync('npm', ['run', '-w', '@jarvis/web', 'build'], { cwd: root, stdio: 'inherit' });
  if (built.status !== 0) {
    console.error('[e2e] no se pudo construir el front; las pruebas medirían el bundle anterior');
    process.exit(1);
  }
}
const state = join(root, '.e2e');
rmSync(state, { recursive: true, force: true });
mkdirSync(state, { recursive: true });
for (const demo of ['app', 'deploy', 'edge']) mkdirSync(join('/tmp/jarvis-demo', demo), { recursive: true });

const PASSWORD = 'e2e-password-de-pruebas';
const shared = {
  ...process.env,
  JARVIS_DATA_DIR: join(state, 'gateway'),
  JARVIS_INTERNAL_SECRET: 'e2e-internal-secret',
};

// La cuenta se crea antes de levantar nada: en este producto una cuenta sólo existe si alguien
// la creó por terminal, y la prueba no puede saltarse esa regla.
const users = join(root, 'apps/gateway/dist/bin/jarvis-users.js');
const runUsers = (args) => spawn(process.execPath, [users, ...args], { env: shared, stdio: 'inherit' });
await new Promise((done) => runUsers(['add', 'braian', 'Braian']).on('exit', done));
await new Promise((done) => runUsers(['set-password', 'braian', PASSWORD]).on('exit', done));

const children = [];
const start = (name, args, env) => {
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  children.push(child);
};

start('index', [join(root, 'packages/testkit/bin/fake-index.mjs')], { ...shared, JARVIS_FAKE_INDEX_PORT: '8098' });
start('core', [join(root, 'apps/core/dist/main.js')], {
  ...shared,
  JARVIS_CORE_DB: join(state, 'core', 'core.db'),
  JARVIS_CORE_BIND: '127.0.0.1',
  JARVIS_CORE_PORT: '8097',
  JARVIS_HOSTS: 'bastion,serverB,serverC,deadhost',
  JARVIS_BASTION_HOST: 'bastion',
  JARVIS_SSH_COMMAND: join(root, 'packages/testkit/bin/fake-ssh.mjs'),
  JARVIS_KNOWN_HOSTS_FILE: '',
  JARVIS_FAKE_SSH_ROOT: join(state, 'fake-ssh'),
  JARVIS_SPOOL_ROOT: join(state, 'spool'),
  JARVIS_ATTACHMENT_ROOT: join(state, 'attachments'),
  JARVIS_INDEX_URL: 'http://127.0.0.1:8098',
  JARVIS_POLL_INTERVAL_MS: '300',
  JARVIS_PLAN_INTERVAL_MS: '600',
  // Un modelo determinista: la prueba comprueba durabilidad, no la calidad de un modelo.
  JARVIS_ASSISTANT_SCRIPTED: 'true',
});
start('gateway', [join(root, 'apps/gateway/dist/src/main.js')], {
  ...shared,
  JARVIS_PORT: '8099',
  JARVIS_BIND: '127.0.0.1',
  JARVIS_CORE_URL: 'http://127.0.0.1:8097',
  JARVIS_STATIC_DIR: join(root, 'apps/web/dist'),
  JARVIS_RP_ID: 'localhost',
  JARVIS_ORIGINS: 'http://127.0.0.1:8099,http://localhost:8099',
  JARVIS_INSECURE_LOGIN: 'true',
  JARVIS_INSECURE_COOKIES: 'true',
});

const stop = () => {
  for (const child of children) if (!child.killed) child.kill('SIGTERM');
};
process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });
