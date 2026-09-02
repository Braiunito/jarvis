/**
 * Paso de contraseña opcional: scrypt de node:crypto, sin dependencias ni criptografía casera.
 * Las contraseñas son un arranque y una vía de recuperación; el factor principal es la passkey.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string, salt: Buffer, keylen: number, options: Record<string, number>,
) => Promise<Buffer>;

const KEYLEN = 64;
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEYLEN, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, N, r, p, salt, expected] = stored.split('$');
  if (!N || !r || !p || !salt || !expected) return false;
  const derived = await scryptAsync(password, Buffer.from(salt, 'base64'), KEYLEN,
    { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  const expectedBuf = Buffer.from(expected, 'base64');
  // Longitud primero: timingSafeEqual lanza si no coinciden en vez de devolver false.
  return derived.length === expectedBuf.length && timingSafeEqual(derived, expectedBuf);
}
