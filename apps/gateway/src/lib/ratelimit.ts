/**
 * Throttling de login: ventana deslizante por clave más bloqueo exponencial.
 *
 * Se indexa por IP y por usuario, de modo que probar una contraseña contra muchas cuentas y
 * machacar una cuenta desde muchas direcciones se frenan las dos.
 */
import type { IncomingMessage } from 'node:http';
import { isPrivateAddress } from '../config.js';

interface Bucket { hits: number[]; lockedUntil: number; strikes: number }
const buckets = new Map<string, Bucket>();

function bucketFor(key: string, windowMs: number): Bucket {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { hits: [], lockedUntil: 0, strikes: 0 };
    buckets.set(key, bucket);
  }
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs);
  return bucket;
}

export interface Limiter {
  check(key: string): { allowed: boolean; retryAfter: number };
  fail(key: string): void;
  succeed(key: string): void;
}

export function createLimiter({ maxAttempts, windowSeconds }: { maxAttempts: number; windowSeconds: number }): Limiter {
  const windowMs = windowSeconds * 1000;
  return {
    check(key) {
      const bucket = bucketFor(key, windowMs);
      const now = Date.now();
      if (bucket.lockedUntil > now) {
        return { allowed: false, retryAfter: Math.ceil((bucket.lockedUntil - now) / 1000) };
      }
      if (bucket.hits.length >= maxAttempts) {
        // Cada ráfaga adicional dobla el bloqueo, con tope para no dejar una cuenta inservible.
        bucket.strikes += 1;
        const lockSeconds = Math.min(windowSeconds * 2 ** bucket.strikes, 3600);
        bucket.lockedUntil = now + lockSeconds * 1000;
        bucket.hits = [];
        return { allowed: false, retryAfter: lockSeconds };
      }
      return { allowed: true, retryAfter: 0 };
    },
    fail(key) { bucketFor(key, windowMs).hits.push(Date.now()); },
    succeed(key) { buckets.delete(key); },
  };
}

export function resetLimitersForTests(): void {
  buckets.clear();
}

/**
 * La dirección del cliente, usada para throttling y para la regla de red local de la escotilla.
 *
 * X-Forwarded-For es una lista a la que los proxies añaden, así que la entrada de más a la
 * derecha es la del proxy que tenemos delante y la primera es lo que envió el cliente. Se cree
 * sólo si el despliegue declara que hay un proxy y además la conexión viene de uno.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  const peer = req.socket?.remoteAddress || 'unknown';
  if (trustProxy && isPrivateAddress(peer)) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const hops = String(forwarded).split(',').map((hop) => hop.trim()).filter(Boolean);
      if (hops.length) return hops[hops.length - 1] as string;
    }
  }
  return peer;
}
