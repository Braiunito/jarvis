#!/usr/bin/env node
/**
 * La única forma de que exista una cuenta.
 *
 * No hay registro público en ninguna parte del producto: alguien con acceso a la máquina ejecuta
 * `jarvis-users add`, y el enrolamiento de la passkey se abre con un código de un solo uso que
 * sale por esta terminal. Ese paso es el ancla de confianza del sistema entero.
 */
import { hashPassword } from '../src/lib/password.js';
import { canLogin, publicUser, users, userStoreFile, type User } from '../src/lib/store.js';
import { generateRecoveryCodes, generateSecret, provisioningUri, verifyCode } from '../src/lib/totp.js';
import { config } from '../src/config.js';

const [command, ...args] = process.argv.slice(2);

function usage(): void {
  console.log(`jarvis-users — cuentas del bastión

  add <usuario> [nombre]        crea la cuenta (no puede entrar hasta enrolar una passkey)
  enroll <usuario>              emite un código de un solo uso para registrar la huella
  list                          lista las cuentas y su estado
  disable <usuario>             deja la cuenta fuera sin borrarla
  enable <usuario>              vuelve a habilitarla
  remove <usuario>              la borra del todo
  set-password <usuario>        fija una contraseña (paso opcional de la cadena)
  clear-password <usuario>      la quita
  revoke-credential <usuario> <id>   revoca una passkey concreta
  totp-enroll <usuario>         prepara un segundo factor TOTP
  totp-confirm <usuario> <código>    lo confirma con un código válido
  totp-clear <usuario>          lo quita

Store: ${userStoreFile()}
Política de autenticación: ${config.authPolicy.join(' + ')}`);
}

function requireUser(username: string | undefined): User {
  if (!username) {
    console.error('falta el nombre de usuario');
    process.exit(2);
  }
  const user = users.findByUsername(username);
  if (!user) {
    console.error(`no existe la cuenta ${username}`);
    process.exit(1);
  }
  return user;
}

async function readSecret(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    const chunks: string[] = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => chunks.push(chunk));
    process.stdin.on('end', () => {
      process.stdout.write('\n');
      resolve(chunks.join('').trim());
    });
  });
}

async function main(): Promise<void> {
  switch (command) {
    case 'add': {
      const [username, displayName] = args;
      if (!username) return usage();
      const user = users.create({ username, ...(displayName ? { displayName } : {}) });
      console.log(`creada ${user.username}`);
      console.log('todavía no puede entrar: ejecuta `jarvis-users enroll ' + user.username + '`');
      return;
    }
    case 'enroll': {
      const user = requireUser(args[0]);
      const code = users.issueEnrollmentCode(user.userId);
      console.log(`código de enrolamiento para ${user.username}: ${code}`);
      console.log(`caduca en ${Math.round(config.enrollmentTtlSeconds / 60)} minutos`);
      console.log('la persona abre /enroll en el navegador, lo escribe y registra su huella');
      return;
    }
    case 'list': {
      const all = users.list();
      if (!all.length) console.log('no hay cuentas todavía');
      for (const user of all) {
        const summary = publicUser(user);
        console.log(`${user.enabled ? '·' : '×'} ${user.username.padEnd(16)} `
          + `passkeys=${summary.credentials.length} `
          + `password=${user.passwordHash ? 'sí' : 'no'} `
          + `totp=${user.totp?.confirmed ? 'sí' : user.totp ? 'pendiente' : 'no'} `
          + `puede-entrar=${canLogin(user) ? 'sí' : 'no'}`);
      }
      return;
    }
    case 'disable':
    case 'enable': {
      const user = requireUser(args[0]);
      users.update(user.userId, (u) => { u.enabled = command === 'enable'; });
      console.log(`${user.username} ${command === 'enable' ? 'habilitada' : 'deshabilitada'}`);
      return;
    }
    case 'remove': {
      const user = requireUser(args[0]);
      users.remove(user.username);
      console.log(`borrada ${user.username}`);
      return;
    }
    case 'set-password': {
      const user = requireUser(args[0]);
      const password = args[1] ?? await readSecret('contraseña: ');
      if (password.length < 10) {
        console.error('una contraseña de menos de 10 caracteres no protege nada');
        process.exit(2);
      }
      const hash = await hashPassword(password);
      users.update(user.userId, (u) => { u.passwordHash = hash; });
      console.log(`contraseña fijada para ${user.username}`);
      return;
    }
    case 'clear-password': {
      const user = requireUser(args[0]);
      users.update(user.userId, (u) => { u.passwordHash = null; });
      console.log(`contraseña eliminada para ${user.username}`);
      return;
    }
    case 'revoke-credential': {
      const user = requireUser(args[0]);
      const credentialId = args[1];
      if (!credentialId) return usage();
      console.log(users.revokeCredential(user.userId, credentialId)
        ? `revocada ${credentialId}` : 'esa credencial no está en la cuenta');
      return;
    }
    case 'totp-enroll': {
      const user = requireUser(args[0]);
      const secret = generateSecret();
      const recoveryCodes = generateRecoveryCodes();
      users.setTotp(user.userId, { secret, recoveryCodes });
      console.log(`secreto TOTP para ${user.username}: ${secret}`);
      console.log(provisioningUri({ secret, account: user.username }));
      console.log('\ncódigos de recuperación (se guardan con hash; esta es la única vez que se ven):');
      for (const code of recoveryCodes) console.log(`  ${code}`);
      console.log(`\nconfírmalo con: jarvis-users totp-confirm ${user.username} <código>`);
      return;
    }
    case 'totp-confirm': {
      const user = requireUser(args[0]);
      if (!user.totp) {
        console.error('esa cuenta no tiene TOTP preparado');
        process.exit(1);
      }
      const result = verifyCode(user.totp.secret, args[1] ?? '');
      if (!result.ok) {
        console.error(result.reason ?? 'código inválido');
        process.exit(1);
      }
      users.confirmTotp(user.userId, result.counter as number);
      console.log(`TOTP confirmado para ${user.username}`);
      return;
    }
    case 'totp-clear': {
      const user = requireUser(args[0]);
      users.clearTotp(user.userId);
      console.log(`TOTP eliminado para ${user.username}`);
      return;
    }
    default:
      usage();
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
