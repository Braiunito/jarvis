/**
 * El core sólo acepta peticiones que traigan una identidad firmada por el gateway (ADR-001).
 *
 * Esto es lo que impide que cualquier contenedor de la red interna conduzca agentes: la cookie
 * del usuario no llega hasta aquí, y sin la firma correcta no hay identidad que asumir.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { UserIdentity } from '@jarvis/contracts';
import { JarvisError } from '@jarvis/contracts';
import { config } from '../config.js';

export const IDENTITY_HEADER = 'x-jarvis-identity';
export const REQUEST_ID_HEADER = 'x-jarvis-request-id';

const fromB64u = (value: string): Buffer =>
  Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

let cachedSecret: Buffer | null = null;

export function internalSecret(): Buffer {
  if (cachedSecret) return cachedSecret;
  if (config.internalSecret) {
    cachedSecret = Buffer.from(config.internalSecret, 'utf8');
    return cachedSecret;
  }
  try {
    cachedSecret = Buffer.from(readFileSync(config.internalSecretFile, 'utf8'), 'base64');
  } catch (error) {
    throw new JarvisError('INTERNAL',
      `the internal identity secret is not available (${config.internalSecretFile}): ${(error as Error).message}`);
  }
  return cachedSecret;
}

export function resetIdentitySecretForTests(): void {
  cachedSecret = null;
}

interface IdentityPayload extends UserIdentity {
  requestId: string;
  exp: number;
}

export function verifyIdentityHeader(token: string | undefined, secret: Buffer): IdentityPayload | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, mac] = parts as [string, string];
  const expected = createHmac('sha256', secret).update(body).digest();
  const provided = fromB64u(mac);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  let payload: IdentityPayload;
  try {
    payload = JSON.parse(fromB64u(body).toString('utf8')) as IdentityPayload;
  } catch {
    return null;
  }
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (!payload.userId || !payload.username) return null;
  return payload;
}
