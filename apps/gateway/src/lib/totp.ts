/**
 * TOTP (RFC 6238) sobre HMAC-OTP (RFC 4226), con node:crypto y nada más.
 *
 * Es el tercer paso para el que se diseñó la cadena: añadirlo fue escribir este fichero y nombrar
 * `totp` en la política, no tocar el flujo de login (decisión D8).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const DIGITS = 6;
const STEP_SECONDS = 30;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = String(input).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export const generateSecret = (): string => base32Encode(randomBytes(20));

function hotp(secret: Buffer, counter: number): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(buffer).digest();
  // Truncado dinámico, RFC 4226 §5.3: el nibble bajo del último byte elige el offset.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24)
    | ((digest[offset + 1]! & 0xff) << 16)
    | ((digest[offset + 2]! & 0xff) << 8)
    | (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export const generateCode = (base32Secret: string, at = Date.now()): string =>
  hotp(base32Decode(base32Secret), Math.floor(at / 1000 / STEP_SECONDS));

/**
 * Verifica un código.
 *
 * Dos detalles fáciles de equivocar: la ventana (los relojes derivan y teclear tarda segundos,
 * así que se acepta un paso a cada lado) y el replay (un código vale un paso entero, de modo que
 * sin recordar el último aceptado, quien lo vea teclear puede reutilizarlo).
 */
export function verifyCode(base32Secret: string, code: string, {
  at = Date.now(), window = 1, lastCounter = null,
}: { at?: number; window?: number; lastCounter?: number | null } = {}):
{ ok: boolean; counter?: number; reason?: string } {
  const cleaned = String(code || '').replace(/\D/g, '');
  if (cleaned.length !== DIGITS) return { ok: false, reason: 'a code is six digits' };

  const secret = base32Decode(base32Secret);
  const current = Math.floor(at / 1000 / STEP_SECONDS);

  for (let drift = -window; drift <= window; drift += 1) {
    const counter = current + drift;
    const expected = Buffer.from(hotp(secret, counter));
    const provided = Buffer.from(cleaned);
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      if (lastCounter !== null && counter <= lastCounter) {
        return { ok: false, reason: 'that code was already used' };
      }
      return { ok: true, counter };
    }
  }
  return { ok: false, reason: 'invalid code' };
}

export function provisioningUri({ secret, account, issuer = 'Jarvis Bastion' }: {
  secret: string; account: string; issuer?: string;
}): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Códigos de recuperación: guardados con hash y de un solo uso, como el de enrolamiento. */
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const raw = randomBytes(5).toString('hex').toUpperCase();
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

export { DIGITS, STEP_SECONDS };
