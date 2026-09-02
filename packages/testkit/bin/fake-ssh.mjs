#!/usr/bin/env node
/**
 * Un `ssh` falso que ejecuta de verdad, en esta máquina.
 *
 * No simula respuestas: monta un HOME y un PATH por host y ejecuta el comando que el core habría
 * mandado. Así tmux es tmux, el spool son ficheros reales y matar el core a mitad de un run
 * prueba la recuperación de verdad, sin depender de un servidor remoto.
 *
 * Hosts:
 *   bastion  claude, codex, opencode, tmux, git, python3
 *   serverB  tmux, git, python3 — sin CLI de agente: fuerza estrategia A
 *   serverC  claude, git, python3 — sin tmux
 *   deadhost rechaza la conexión (código 255, como ssh)
 *
 * Raíz de trabajo: $JARVIS_FAKE_SSH_ROOT (por defecto /tmp/jarvis-fake-ssh).
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.JARVIS_FAKE_SSH_ROOT || '/tmp/jarvis-fake-ssh';

const HOSTS = {
  bastion: { agents: ['claude', 'codex', 'opencode'], tmux: true },
  serverB: { agents: [], tmux: true },
  serverC: { agents: ['claude'], tmux: false },
};

const argv = process.argv.slice(2);
const separator = argv.indexOf('--');
if (separator < 1) {
  process.stderr.write('fake-ssh: expected `... host -- command`\n');
  process.exit(255);
}
const host = argv[separator - 1];
const rawCommand = argv.slice(separator + 1).join(' ');

if (host === 'deadhost' || !HOSTS[host]) {
  process.stderr.write(`Warning: Permanently added '${host}' (ED25519) to the list of known hosts.\n`);
  process.stderr.write(`ssh: connect to host ${host} port 22: No route to host\n`);
  process.exit(255);
}

const spec = HOSTS[host];
const hostDir = join(ROOT, host);
const binDir = join(hostDir, 'bin');
const homeDir = join(hostDir, 'home');
/**
 * `$HOME/.local/bin` va primero en el PATH que exporta el core, así que es ahí donde tienen que
 * vivir los agentes: si no, el `claude` real instalado en esta máquina ganaría la resolución y
 * un test acabaría gastando cuota de verdad.
 */
const homeBin = join(homeDir, '.local', 'bin');
mkdirSync(binDir, { recursive: true });
mkdirSync(homeBin, { recursive: true });

const link = (target, path) => {
  if (existsSync(path)) return;
  try {
    symlinkSync(target, path);
  } catch {
    // Otra invocación lo creó entre el existsSync y esto: es justo lo que se quería.
  }
};

// El PATH no incluye /usr/bin: un host sin tmux tiene que quedarse de verdad sin tmux, y sólo
// se consigue enlazando a mano lo que ese host declara tener.
const POSIX_TOOLS = ['sh', 'base64', 'find', 'grep', 'tail', 'head', 'wc', 'cat', 'date', 'mv',
  'rm', 'mkdir', 'chmod', 'touch', 'kill', 'env', 'sleep', 'tr', 'ls', 'sed', 'dirname',
  'xargs', 'stat', 'cut', 'wait'];
for (const tool of POSIX_TOOLS) {
  for (const candidate of [`/usr/bin/${tool}`, `/bin/${tool}`]) {
    if (existsSync(candidate)) { link(candidate, join(binDir, tool)); break; }
  }
}
link(process.execPath, join(binDir, 'node'));
for (const optional of ['git', 'python3']) {
  for (const candidate of [`/usr/bin/${optional}`, `/bin/${optional}`]) {
    if (existsSync(candidate)) { link(candidate, join(binDir, optional)); break; }
  }
}

/** Un tmux por host, cada uno con su socket: list-sessions no ve las sesiones del vecino. */
if (spec.tmux) {
  const wrapper = join(homeBin, 'tmux');
  if (!existsSync(wrapper)) {
    writeFileSync(wrapper, `#!/bin/sh\nexec /usr/bin/tmux -L jarvis-${host} "$@"\n`, { mode: 0o755 });
  }
}
for (const agent of spec.agents) {
  link(join(here, 'agents', `${agent}.mjs`), join(homeBin, agent));
}
try { chmodSync(binDir, 0o755); } catch { /* no importa */ }

/**
 * El PATH que exporta el core incluye `/usr/local/bin`, que en esta máquina contiene binarios de
 * verdad — un `claude` real, por ejemplo. Un host simulado que dice no tener agente instalado
 * tiene que no tenerlo, así que esa ruta se redirige a un directorio del propio host.
 */
const shadowSystemDir = join(hostDir, 'usr-local-bin');
mkdirSync(shadowSystemDir, { recursive: true });
const command = rawCommand.split('/usr/local/bin').join(shadowSystemDir);

const child = spawn('/bin/sh', ['-c', command], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    HOME: homeDir,
    PATH: `${homeBin}:${binDir}`,
    JARVIS_FAKE_HOST: host,
    // Node tiene que seguir siendo alcanzable para los agentes falsos.
    JARVIS_FAKE_NODE: process.execPath,
  },
  cwd: existsSync(homeDir) ? homeDir : undefined,
});

process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on('error', (error) => {
  process.stderr.write(`fake-ssh: ${error.message}\n`);
  process.exit(255);
});
child.on('close', (code, signal) => {
  if (signal) process.exit(255);
  process.exit(code ?? 0);
});
