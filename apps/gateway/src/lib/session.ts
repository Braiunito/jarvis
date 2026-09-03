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

/**
 * Momento a partir del cual una sesión es de fiar.
 *
 * Todo token emitido antes queda inválido, aunque su `jti` no esté en la lista. Es lo que permite
 * fallar cerrado cuando la lista deja de ser legible: si no se sabe qué se revocó, lo honesto es
 * no dar por buena ninguna sesión anterior a ese descubrimiento. Volver a entrar arregla la
 * situación en un gesto; dar por válido un token que alguien cerró no se arregla de ninguna forma.
 */
let revokedBefore = 0;

interface RevokedFile {
  revokedBefore?: number;
  jti?: Record<string, number>;
}

function loadRevoked(): Map<string, number> {
  if (revoked) return revoked;
  revoked = new Map();
  if (!existsSync(REVOKED_FILE())) return revoked;
  try {
    const raw = JSON.parse(readFileSync(REVOKED_FILE(), 'utf8')) as RevokedFile | Record<string, number>;
    // El formato antiguo era un objeto plano `jti -> exp`; se sigue leyendo.
    const entries = 'jti' in raw && typeof raw.jti === 'object'
      ? (raw as RevokedFile).jti ?? {}
      : raw as Record<string, number>;
    for (const [jti, exp] of Object.entries(entries)) {
      if (typeof exp === 'number') revoked.set(jti, exp);
    }
    const marker = (raw as RevokedFile).revokedBefore;
    if (typeof marker === 'number') revokedBefore = Math.max(revokedBefore, marker);
  } catch (error) {
    /**
     * Una lista ilegible no puede empezar limpia: eso resucita todas las sesiones cerradas.
     *
     * Se invalida lo anterior con la marca, se aparta el fichero roto en vez de sobrescribirlo
     * —si alguien lo corrompió a propósito, es lo primero que querrá mirar quien investigue— y se
     * dice en voz alta. Quien estuviera dentro vuelve a entrar; quien tuviera un token robado y
     * revocado no.
     */
    revoked = new Map();
    revokedBefore = Math.floor(Date.now() / 1000);
    console.error('[session] la lista de revocación no se puede leer, se invalidan las sesiones '
      + `anteriores a ${new Date(revokedBefore * 1000).toISOString()}:`, (error as Error).message);
    try {
      renameSync(REVOKED_FILE(), `${REVOKED_FILE()}.corrupt-${revokedBefore}`);
    } catch { /* si tampoco se puede apartar, la marca en memoria sigue protegiendo */ }
    persistRevoked();
  }
  return revoked;
}

/** Escribe la lista. Devuelve si se pudo dejar en disco, que es lo único que sobrevive al proceso. */
function persistRevoked(): boolean {
  const now = Math.floor(Date.now() / 1000);
  const current = revoked ?? new Map<string, number>();
  for (const [jti, exp] of current) if (exp < now) current.delete(jti);
  try {
    ensureDataDir();
    const tmp = `${REVOKED_FILE()}.${process.pid}.tmp`;
    const payload: RevokedFile = { revokedBefore, jti: Object.fromEntries(current) };
    writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    renameSync(tmp, REVOKED_FILE());
    return true;
  } catch (error) {
    console.error('[session] could not persist the revocation list:', (error as Error).message);
    return false;
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
    const list = loadRevoked();
    if (claims.jti && list.has(claims.jti)) return null;
    // Emitida antes de que la lista dejara de ser fiable: no vale, aunque su jti no conste. La
    // comparación incluye el segundo exacto del descubrimiento a propósito: `iat` va en segundos,
    // y dejar pasar ese segundo es dejar pasar justo los tokens de alrededor del problema.
    if (revokedBefore && claims.iat <= revokedBefore) return null;
    return claims;
  },

  /**
   * Cierra una sesión en el servidor. Devuelve `false` si no puede garantizarlo.
   *
   * Que la escritura falle y logout conteste que sí es la peor combinación posible: la persona se
   * va convencida de haber cerrado, y el token sigue sirviendo hasta que caduque. Quien llama
   * tiene que poder decirlo.
   */
  revoke(token: string | undefined): boolean {
    const claims = verify(token, 'session');
    if (!claims?.jti) return false;
    loadRevoked().set(claims.jti, claims.exp);
    return persistRevoked();
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

  resetRevokedForTests(): void { revoked = null; revokedBefore = 0; },
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
