/**
 * La clave de la API de alertas: la única credencial del gateway que no es una sesión.
 *
 * Existe para que un script, un cron o un Claude de otra máquina puedan avisar sin pasar por un
 * login, y por eso vale para **una sola cosa**: `POST /api/alerts`. No lee la bandeja, no toca
 * runs ni terminales; quien la tenga sólo puede hacer sonar el teléfono. Que se filtre es ruido,
 * no una puerta a la flota.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createLimiter } from './ratelimit.js';

export const ALERTS_PATH = '/api/alerts';

/** Como quién entra al core lo que llega con la clave. La auditoría del core lo nombra así. */
export const ALERTS_API_USER = { userId: 'svc:alerts-api', username: 'alerts-api' } as const;

/** El token de un `Authorization: Bearer …`, o null si la cabecera no es eso. */
export function bearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] as string : null;
}

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/**
 * Si el token es una de las claves configuradas.
 *
 * Se comparan los hashes y no las cadenas para que `timingSafeEqual` reciba siempre el mismo
 * largo: comparar cadenas de largo distinto lanza, y cortar antes delata el largo de la clave.
 * Se recorren todas aunque una coincida, por lo mismo. Varias claves a la vez permiten rotar
 * sin cortar a nadie.
 */
export function alertsKeyMatches(token: string, keys: readonly string[]): boolean {
  const provided = digest(token);
  let ok = false;
  for (const key of keys) {
    if (key.length >= 24 && timingSafeEqual(provided, digest(key))) ok = true;
  }
  return ok;
}

/**
 * Intentos fallidos por IP. Con una clave de 256 bits adivinar no es el riesgo; esto es para que
 * un script mal configurado en bucle no llene el log de auditoría.
 */
export const alertsKeyLimiter = createLimiter({ maxAttempts: 10, windowSeconds: 300 });
