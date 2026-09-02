/**
 * Contratos SSH-*: lo que impide que el core sea un servicio de ejecución remota arbitraria.
 *
 * El entrecomillado no se compara contra un literal esperado: se pasa por un `sh` de verdad y se
 * comprueba que el shell devuelve exactamente los bytes originales.
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  assertHostAllowed, defaultSshConfig, remotePathExport, remoteScript, shellJoin, shellQuote,
  sshArgv, SshError, sshFailureReason,
} from '@jarvis/agent-adapters';

const throughShell = (value: string): string =>
  execFileSync('sh', ['-c', `printf '%s' ${shellQuote(value)}`]).toString();

const NASTY = [
  'simple', 'with spaces', "it's got a quote", 'double "quotes"', '$(rm -rf /)', '`whoami`',
  '$HOME', 'a;b', 'a && b', 'a | b', 'newline\nsecond', 'tab\there', 'back\\slash', '*glob*',
  '~/expanded', '!history', 'unicode: acentuación ñ 中文 🙂', '', "'", "''", '--not-a-flag',
  '-oProxyCommand=touch /tmp/pwned',
  // zsh expande un '=' inicial a la ruta de un comando y '~' a un home; sh no. El shell de login
  // del otro lado es el que tenga el usuario, así que los dos van entrecomillados.
  '=jarvis-claude-abc', '~/notes', 'a=b',
];

describe('SSH-QUOTE-01', () => {
  it.each(NASTY)('devuelve %j intacto tras pasar por un shell real', (value) => {
    expect(throughShell(value)).toBe(value);
  });

  it('nunca deja ejecutar una sustitución de comando', () => {
    const payload = '$(touch /tmp/jarvis-quoting-canary)';
    expect(throughShell(payload)).toBe(payload);
  });

  it('une un argv sin fundir argumentos', () => {
    const joined = shellJoin(['echo', 'one two', 'three']);
    expect(execFileSync('sh', ['-c', `${joined} | cat`]).toString().trim()).toBe('one two three');
  });

  it('entrecomilla = y ~ iniciales, que en zsh se expanden', () => {
    expect(shellQuote('=jarvis-claude-abc')).toBe("'=jarvis-claude-abc'");
    expect(shellQuote('~/notes')).toBe("'~/notes'");
  });
});

describe('SSH-SCRIPT-01', () => {
  it('cambia de directorio y exporta el entorno antes del comando', () => {
    const script = remoteScript({
      argv: ['claude', '-p', 'do the thing'],
      cwd: '/srv/my app',
      env: { CLAUDE_CONFIG_DIR: '/opt/claude config' },
    });
    expect(script).toMatch(/; cd '\/srv\/my app' &&/);
    expect(script).toMatch(/CLAUDE_CONFIG_DIR='\/opt\/claude config'/);
    expect(script).toMatch(/claude -p 'do the thing'$/);
  });

  it('rechaza un nombre de variable de entorno que no lo es', () => {
    expect(() => remoteScript({ argv: ['true'], env: { 'EVIL; rm -rf /': 'x' } }))
      .toThrow(/unsafe environment name/);
  });

  it('produce un script que un shell ejecuta como un solo comando', () => {
    const script = remoteScript({ argv: ['printf', '%s', 'hola mundo'], cwd: '/tmp', env: { X: 'y z' } });
    expect(execFileSync('sh', ['-c', script]).toString()).toBe('hola mundo');
  });

  it('pone en PATH las rutas de instalación por usuario', () => {
    const script = remoteScript({ argv: ['codex', 'exec', 'hola'], cwd: '/srv/app', env: {} });
    expect(script).toMatch(/^export PATH=/);
    expect(script).toMatch(/\$HOME\/\.local\/bin/);
    expect(script).toMatch(/:\$PATH; /);
    expect(script).toMatch(/cd \/srv\/app && codex exec hola$/);
  });

  it('deja $HOME sin comillas para que lo expanda el shell remoto', () => {
    expect(remotePathExport().includes("'$HOME")).toBe(false);
  });

  it('rechaza un PATH que podría colar un comando', () => {
    expect(() => remotePathExport('/bin:$(touch /tmp/x)')).toThrow(/unsafe remote PATH/);
    expect(() => remotePathExport('/bin;id')).toThrow(/unsafe remote PATH/);
  });

  it('cierra stdin en runs headless para que el agente no espere entrada', () => {
    expect(remoteScript({ argv: ['codex', 'exec', 'hola'], stdinFromNull: true }))
      .toMatch(/codex exec hola < \/dev\/null$/);
  });

  it('se puede desactivar del todo', () => {
    expect(remoteScript({ argv: ['true'], pathExtra: '' })).toBe('true');
  });
});

describe('SSH-ALLOW-01', () => {
  const FLEET = ['bastion', 'server-b', 'user@10.0.0.4', 'db.internal', 'srv_1'];

  it('acepta nombres de host y alias ssh normales', () => {
    for (const host of FLEET) expect(() => assertHostAllowed(host, FLEET)).not.toThrow();
  });

  it('rechaza nombres que ssh leería como opciones', () => {
    for (const host of ['-oProxyCommand=touch /tmp/x', '--config=/etc/passwd', 'a host', 'a;b', '$(x)']) {
      expect(() => assertHostAllowed(host, [...FLEET, host])).toThrow(SshError);
    }
  });

  it('rechaza un nombre que sólo empieza por guion, esté o no en la lista', () => {
    for (const host of ['-Fpwned', '-b', '-tt']) {
      expect(() => assertHostAllowed(host, ['bastion', host])).toThrow(/refusing suspicious host name/);
    }
  });

  it('exige la allowlist y rechaza una vacía en vez de leerla como «todo vale»', () => {
    expect(() => assertHostAllowed('elsewhere', ['bastion', 'serverB'])).toThrow(/not in JARVIS_HOSTS/);
    expect(() => assertHostAllowed('bastion', [])).toThrow(/no host allowlist/);
    expect(() => sshArgv({ host: 'bastion', command: 'true', config: defaultSshConfig() }))
      .toThrow(/no host allowlist/);
  });
});

describe('SSH-ARGV-01', () => {
  const config = defaultSshConfig({ hosts: ['bastion'] });

  it('valida el host antes de construir ningún argv', () => {
    expect(() => sshArgv({ host: '-oProxyCommand=x', command: 'true', config }))
      .toThrow(SshError);
  });

  it('apunta a un known_hosts escribible, porque el montado es de sólo lectura', () => {
    const argv = sshArgv({ host: 'bastion', command: 'true', config });
    expect(argv.some((a) => a.startsWith('UserKnownHostsFile='))).toBe(true);
  });

  it('no pisa el known_hosts que eligió el operador', () => {
    const chosen = sshArgv({
      host: 'bastion',
      command: 'true',
      config: defaultSshConfig({ hosts: ['bastion'], sshOptions: ['-o', 'UserKnownHostsFile=/etc/pinned'] }),
    }).filter((a) => a.startsWith('UserKnownHostsFile='));
    expect(chosen).toEqual(['UserKnownHostsFile=/etc/pinned']);
  });

  it('usa BatchMode para llamadas no interactivas y tty para las interactivas', () => {
    const batch = sshArgv({ host: 'bastion', command: 'true', config });
    expect(batch).toContain('BatchMode=yes');
    expect(batch.at(-1)).toBe('true');
    expect(batch.at(-2)).toBe('--');

    const interactive = sshArgv({ host: 'bastion', command: 'true', config, tty: true, batch: false });
    expect(interactive).toContain('-tt');
    expect(interactive).not.toContain('BatchMode=yes');
  });
});

describe('HOST-SSHFAIL-01', () => {
  it('ignora el ruido benigno de stderr y reporta la causa real', () => {
    const stderr = [
      "Warning: Permanently added 'goro2' (ED25519) to the list of known hosts.",
      'Pseudo-terminal will not be allocated because stdin is not a terminal.',
      'Permission denied (publickey).',
    ].join('\n');
    expect(sshFailureReason({ code: 255, stderr })).toBe('Permission denied (publickey).');
  });

  it('explica un 255 sin stderr útil en lugar de decir «exited 255»', () => {
    expect(sshFailureReason({ code: 255, stderr: 'Warning: Permanently added x\n' }))
      .toMatch(/could not establish the connection/);
  });
});
