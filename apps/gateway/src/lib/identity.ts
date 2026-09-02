/**
 * La identidad interna que el gateway firma para el core (ADR-001).
 *
 * La cookie del usuario nunca cruza esta frontera: el core recibe un token corto, firmado con un
 * secreto distinto del de sesión, que dice quién actúa y para qué petición. Así un core
 * comprometido no puede reproducir sesiones web, y una petición directa al core sin pasar por el
 * gateway se rechaza.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const IDENTITY_HEADER = 'x-jarvis-identity';
export const REQUEST_ID_HEADER = 'x-jarvis-request-id';

export interface InternalIdentity {
  userId: string;
  username: string;
  requestId: string;
  exp: number;
}

const b64u = (value: string | Buffer): string => Buffer.from(value).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (value: string): Buffer =>
  Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export function signIdentity(identity: Omit<InternalIdentity, 'exp'>, secret: Buffer, ttlSeconds = 60): string {
  const payload: InternalIdentity = { ...identity, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const body = b64u(JSON.stringify(payload));
  const mac = b64u(createHmac('sha256', secret).update(body).digest());
  return `${body}.${mac}`;
}

export function verifyIdentity(token: string | undefined, secret: Buffer): InternalIdentity | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, mac] = parts as [string, string];
  const expected = createHmac('sha256', secret).update(body).digest();
  const provided = fromB64u(mac);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  let payload: InternalIdentity;
  try {
    payload = JSON.parse(fromB64u(body).toString('utf8')) as InternalIdentity;
  } catch {
    return null;
  }
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (!payload.userId || !payload.username) return null;
  return payload;
}
