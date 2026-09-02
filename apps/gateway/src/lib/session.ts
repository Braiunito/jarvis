/**
 * Sesiones y tokens de autenticación en curso: JWT HS256 firmados con node:crypto.
 *
 * Dos audiencias, deliberadamente no intercambiables:
 *   `session` — se emite sólo cuando la cadena entera está completa.
 *   `pending` — corto, lleva qué pasos ya se hicieron durante un login de varios pasos.
 * Un token pending no puede reproducirse como cookie de sesión.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, ensureDataDir } from '../config.js';

const b64u = (buf: Buffer | string): string => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (str: string): Buffer =>
  Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

interface Claims {
  sub: string;
  username?: string;
  jti?: string;
  completed?: string[];
  aud: string;
  iat: number;
  exp: number;
}

function sign(payload: Record<string, unknown>, audience: string, ttlSeconds: number): string {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64u(JSON.stringify({ ...payload, aud: audience, iat: now, exp: now + ttlSeconds }));
  const signature = b64u(createHmac('sha256', config.sessionSecret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${signature}`;
}

function verify(token: string | undefined, audience: string): Claims | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts as [string, string, string];
  const expected = createHmac('sha256', config.sessionSecret).update(`${header}.${body}`).digest();
  const provided = fromB64u(signature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  let payload: Claims;
  try {
    payload = JSON.parse(fromB64u(body).toString('utf8')) as Claims;
  } catch {
    return null;
  }
  if (payload.aud !== audience) return null;
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

/**
 * Ids de sesión revocados.
 *
 * Borrar la cookie sólo le pide al navegador que olvide el token; quien ya lo capturó podría
 * seguir usándolo hasta que caduque. Salir tiene que significar algo también en el servidor.
 */
const REVOKED_FILE = (): string => join(config.dataDir, 'revoked-sessions.json');
let revoked: Map<string, number> | null = null;

function loadRevoked(): Map<string, number> {
  if (revoked) return revoked;
  revoked = new Map();
  try {
    if (existsSync(REVOKED_FILE())) {
      for (const [jti, exp] of Object.entries(JSON.parse(readFileSync(REVOKED_FILE(), 'utf8')) as Record<string, number>)) {
        revoked.set(jti, exp);
      }
    }
  } catch {
    // Una lista corrupta no puede dejar a todo el mundo fuera: se empieza limpia.
    revoked = new Map();
  }
  return revoked;
}

function persistRevoked(): void {
  const now = Math.floor(Date.now() / 1000);
  const current = loadRevoked();
  for (const [jti, exp] of current) if (exp < now) current.delete(jti);
  try {
    ensureDataDir();
    const tmp = `${REVOKED_FILE()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(current)), { mode: 0o600 });
    renameSync(tmp, REVOKED_FILE());
  } catch (error) {
    console.error('[session] could not persist the revocation list:', (error as Error).message);
  }
}

export const SESSION_COOKIE = 'jarvis_session';

export const session = {
  issue(user: { userId: string; username: string }): string {
    return sign({ sub: user.userId, username: user.username, jti: randomUUID() },
      'session', config.sessionTtlSeconds);
  },

  read(token: string | undefined): Claims | null {
    const claims = verify(token, 'session');
    if (!claims) return null;
    if (claims.jti && loadRevoked().has(claims.jti)) return null;
    return claims;
  },

  revoke(token: string | undefined): boolean {
    const claims = verify(token, 'session');
    if (!claims?.jti) return false;
    loadRevoked().set(claims.jti, claims.exp);
    persistRevoked();
    return true;
  },

  cookie(token: string): string {
    const attributes = [
      `${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict',
      `Max-Age=${config.sessionTtlSeconds}`,
    ];
    if (!config.insecureCookies) attributes.push('Secure');
    return attributes.join('; ');
  },

  clearCookie(): string {
    const attributes = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
    if (!config.insecureCookies) attributes.push('Secure');
    return attributes.join('; ');
  },

  resetRevokedForTests(): void { revoked = null; },
};

export const pending = {
  issue({ userId, completed }: { userId: string; completed: string[] }): string {
    return sign({ sub: userId, completed }, 'pending', config.challengeTtlSeconds);
  },
  read(token: string | undefined): Claims | null {
    return verify(token, 'pending');
  },
};

/**
 * Un valor de cookie que no es percent-encoding válido no puede lanzar.
 *
 * Esto corre en cada petición, antes de autenticar nada, así que un `URIError` escapando de aquí
 * es una promesa rechazada sin manejar: una sola petición anónima con `Cookie: jarvis_session=%`
 * tumbaría el gateway entero.
 */
function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const jar: Record<string, string> = {};
  if (!header) return jar;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    jar[part.slice(0, index).trim()] = decodeCookieValue(part.slice(index + 1).trim());
  }
  return jar;
}
