/**
 * Web Push sin dependencias: cifrado `aes128gcm` (RFC 8291 sobre RFC 8188) y VAPID (RFC 8292).
 *
 * Se escribe con `node:crypto` en vez de traer `web-push` porque son dos funciones y un vector de
 * prueba oficial contra el que comprobarlas (RFC 8291, apéndice A, en `test/webpush.test.ts`):
 * una dependencia con su árbol entero para algo que cabe aquí es más superficie, no menos.
 *
 * El navegador no valida nada de esto hasta que recibe el mensaje, y entonces lo descarta en
 * silencio si un byte no cuadra. Por eso la prueba fija los valores intermedios del RFC uno a uno
 * y no sólo «que se puede descifrar con lo mismo que lo cifró».
 */
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto';

export const b64u = (buffer: Buffer | Uint8Array): string => Buffer.from(buffer).toString('base64url');
export const fromB64u = (value: string): Buffer => Buffer.from(value.replace(/\s+/g, ''), 'base64url');

export interface VapidKeys {
  /** Punto P-256 sin comprimir (65 bytes), en base64url: lo que pide `applicationServerKey`. */
  publicKey: string;
  /** El escalar privado (32 bytes), en base64url. */
  privateKey: string;
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

/** Un par P-256 crudo como clave privada de `node:crypto`, para firmar el JWT de VAPID. */
function privateKeyObject(keys: VapidKeys) {
  const pub = fromB64u(keys.publicKey);
  return createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC', crv: 'P-256',
      x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)),
      d: keys.privateKey,
    },
  });
}

/** Comprueba que el par se corresponde: un `.env` copiado a medias no puede firmar en balde. */
export function assertVapidKeys(keys: VapidKeys): void {
  const pub = fromB64u(keys.publicKey);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('VAPID public key must be an uncompressed P-256 point');
  // Se deriva la pública desde la privada: la JWK de `node:crypto` se cree la x/y que le dan y no
  // detectaría un par cruzado.
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(fromB64u(keys.privateKey));
  if (!ecdh.getPublicKey().equals(pub)) throw new Error('VAPID private key does not match the public key');
}

/**
 * La cabecera `Authorization` de VAPID para un endpoint.
 *
 * `aud` es el origen del servicio de push, no la URL entera; `sub` es un contacto (`mailto:` o
 * `https:`) y Apple rechaza el JWT si no lo es.
 */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, nowSeconds: number): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: nowSeconds + 12 * 3600,
    sub: subject,
  })));
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key: privateKeyObject(keys), dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.publicKey}`;
}

const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer =>
  Buffer.from(hkdfSync('sha256', ikm, salt, info, length));

export interface EncryptOptions {
  /** Sólo para el vector del RFC: en producción el par efímero y la sal son nuevos cada vez. */
  ephemeralPrivateKey?: Buffer;
  salt?: Buffer;
}

/**
 * Cifra un mensaje para una suscripción (RFC 8291 §3.4) en un único registro `aes128gcm`.
 *
 * Devuelve el cuerpo listo para el POST: cabecera de 86 bytes (sal, tamaño de registro, clave
 * pública efímera) seguida del texto cifrado con su etiqueta.
 */
export function encryptPayload(
  plaintext: Buffer,
  subscription: { p256dh: string; auth: string },
  options: EncryptOptions = {},
): Buffer {
  const uaPublic = fromB64u(subscription.p256dh);
  const authSecret = fromB64u(subscription.auth);
  if (uaPublic.length !== 65) throw new Error('p256dh must be an uncompressed P-256 point');
  if (authSecret.length !== 16) throw new Error('auth secret must be 16 bytes');

  const ecdh = createECDH('prime256v1');
  if (options.ephemeralPrivateKey) ecdh.setPrivateKey(options.ephemeralPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = options.salt ?? randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  const recordSize = 4096;
  // Un único registro: el contenido más el delimitador 0x02 de «último registro», sin relleno.
  if (plaintext.length + 1 + 16 > recordSize) throw new Error('push payload too large for one record');
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(recordSize, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ciphertext]);
}

export interface PushTarget { endpoint: string; p256dh: string; auth: string }

export interface PushResult {
  ok: boolean;
  status: number;
  /** El servicio dice que la suscripción ya no existe: hay que olvidarla. */
  gone: boolean;
  error: string | null;
}

export type PushUrgency = 'very-low' | 'low' | 'normal' | 'high';

/** Manda un mensaje. No lanza: un dispositivo que falla no puede parar a los demás. */
export async function sendPush(target: PushTarget, payload: Buffer, {
  keys, subject, ttlSeconds = 24 * 3600, urgency = 'normal', topic, timeoutMs = 10_000, fetchImpl = fetch,
}: {
  keys: VapidKeys;
  subject: string;
  ttlSeconds?: number;
  urgency?: PushUrgency;
  /** Un mensaje con el mismo tema sustituye al anterior si aún no se entregó. */
  topic?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<PushResult> {
  try {
    const body = encryptPayload(payload, target);
    const response = await fetchImpl(target.endpoint, {
      method: 'POST',
      headers: {
        authorization: vapidAuthorization(target.endpoint, keys, subject, Math.floor(Date.now() / 1000)),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(ttlSeconds),
        urgency,
        ...(topic ? { topic } : {}),
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ok = response.status >= 200 && response.status < 300;
    const text = ok ? '' : (await response.text().catch(() => '')).slice(0, 300);
    return {
      ok,
      status: response.status,
      gone: response.status === 404 || response.status === 410,
      error: ok ? null : `${response.status} ${text}`.trim(),
    };
  } catch (error) {
    return { ok: false, status: 0, gone: false, error: (error as Error).message };
  }
}
