#!/usr/bin/env node
/**
 * Levanta el stack entero contra hosts falsos, en esta máquina.
 *
 * Es lo que permite ver y probar el producto —login, sesiones, runs durables, terminal— sin un
 * bastión: el `ssh` es el del testkit, que ejecuta de verdad en local con tmux y spool reales.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const state = process.env.JARVIS_DEV_STATE || join(root, '.dev');
mkdirSync(state, { recursive: true });
// Los directorios de trabajo que anuncia el índice de desarrollo tienen que existir de verdad:
// un cwd inventado hace fallar el run, que es justo lo correcto y justo lo que aquí estorba.
for (const demo of ['app', 'deploy', 'edge']) mkdirSync(join('/tmp/jarvis-demo', demo), { recursive: true });

const shared = {
  ...process.env,
  JARVIS_DATA_DIR: join(state, 'gateway'),
  JARVIS_INTERNAL_SECRET: 'dev-internal-secret-cambiar-en-produccion',
  JARVIS_VERBOSE: '1',
};

const coreEnv = {
  ...shared,
  JARVIS_CORE_DB: join(state, 'core', 'core.db'),
  JARVIS_CORE_PORT: '8770',
  JARVIS_HOSTS: 'bastion,serverB,serverC,deadhost',
  JARVIS_BASTION_HOST: 'bastion',
  JARVIS_SSH_COMMAND: join(root, 'packages/testkit/bin/fake-ssh.mjs'),
  JARVIS_KNOWN_HOSTS_FILE: '',
  JARVIS_FAKE_SSH_ROOT: join(state, 'fake-ssh'),
  JARVIS_SPOOL_ROOT: join(state, 'spool'),
  JARVIS_ATTACHMENT_ROOT: join(state, 'attachments'),
  JARVIS_INDEX_URL: 'http://127.0.0.1:8765',
  JARVIS_POLL_INTERVAL_MS: '400',
  // Un modelo guionizado para poder probar el Assistant en local sin credencial ni cuota.
  JARVIS_ASSISTANT_SCRIPTED: 'true',
  JARVIS_PLAN_INTERVAL_MS: '800',
};

const gatewayEnv = {
  ...shared,
  JARVIS_PORT: '8080',
  JARVIS_BIND: '127.0.0.1',
  JARVIS_CORE_URL: 'http://127.0.0.1:8770',
  JARVIS_STATIC_DIR: join(root, 'apps/web/dist'),
  JARVIS_RP_ID: 'localhost',
  JARVIS_ORIGINS: 'http://localhost:8080,http://127.0.0.1:8080',
  // Sin TLS no hay passkeys: en desarrollo se entra con contraseña, igual que la escotilla real.
  JARVIS_INSECURE_LOGIN: 'true',
  JARVIS_INSECURE_COOKIES: 'true',
};

if (!existsSync(join(root, 'apps/web/dist/index.html'))) {
  console.error('falta el build del front: npm run -w @jarvis/web build');
  process.exit(1);
}

const children = [];
const start = (name, command, args, env) => {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `[${name}] `;
  child.stdout.on('data', (chunk) => process.stdout.write(prefix + String(chunk).replaceAll('\n', `\n${prefix}`).trimEnd() + '\n'));
  child.stderr.on('data', (chunk) => process.stderr.write(prefix + String(chunk).replaceAll('\n', `\n${prefix}`).trimEnd() + '\n'));
  child.on('exit', (code) => {
    console.log(`${prefix}terminó con código ${code}`);
    stop();
  });
  children.push(child);
  return child;
};

function stop() {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
}
process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });

start('index', process.execPath, [join(root, 'packages/testkit/bin/fake-index.mjs')], shared);
start('core', process.execPath, [join(root, 'apps/core/dist/main.js')], coreEnv);
start('gateway', process.execPath, [join(root, 'apps/gateway/dist/src/main.js')], gatewayEnv);

console.log('\n  Jarvis en desarrollo: http://localhost:8080');
console.log('  Crea una cuenta:  npm run dev:user -- add braian');
console.log('                    npm run dev:user -- set-password braian <contraseña>\n');
