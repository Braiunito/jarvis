/**
 * Un autenticador falso sobre node:crypto, más el pequeño *codificador* CBOR que necesita.
 *
 * Existe para poder ejercitar la verificación WebAuthn de punta a punta —generación de claves,
 * firmas y attestation objects reales— sin navegador ni llave USB. Sólo el lado del test codifica
 * CBOR; el código de producción nunca lo necesita.
 */
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from 'node:crypto';

const b64u = (buf: Buffer | Uint8Array): string => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (str: string): Buffer =>
  Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function head(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 0x100) return Buffer.from([(major << 5) | 24, value]);
  if (value < 0x10000) {
    const b = Buffer.alloc(3);
    b.writeUInt8((major << 5) | 25, 0);
    b.writeUInt16BE(value, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b.writeUInt8((major << 5) | 26, 0);
  b.writeUInt32BE(value, 1);
  return b;
}

export type CborInput = number | string | boolean | Buffer | CborInput[] | Map<CborInput, CborInput>;

export function cborEncode(value: CborInput): Buffer {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (typeof value === 'boolean') return Buffer.from([value ? 0xf5 : 0xf4]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cborEncode)]);
  if (value instanceof Map) {
    const parts = [head(5, value.size)];
    for (const [k, v] of value) parts.push(cborEncode(k), cborEncode(v));
    return Buffer.concat(parts);
  }
  throw new Error(`cborEncode: unsupported value ${typeof value}`);
}

export const FLAG = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 } as const;

export type FakeAlgorithm = 'ES256' | 'RS256' | 'EdDSA';

export class FakeAuthenticator {
  readonly rpId: string;
  readonly origin: string;
  readonly credentialId: Buffer;
  signCount = 0;
  readonly coseAlg: number;
  readonly #publicKey: KeyObject;
  readonly #privateKey: KeyObject;

  constructor({ rpId = 'localhost', origin = 'http://localhost:8080', algorithm = 'ES256' as FakeAlgorithm } = {}) {
    this.rpId = rpId;
    this.origin = origin;
    this.credentialId = randomBytes(32);

    if (algorithm === 'ES256') {
      const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      this.#publicKey = pair.publicKey;
      this.#privateKey = pair.privateKey;
      this.coseAlg = -7;
    } else if (algorithm === 'RS256') {
      const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
      this.#publicKey = pair.publicKey;
      this.#privateKey = pair.privateKey;
      this.coseAlg = -257;
    } else {
      const pair = generateKeyPairSync('ed25519');
      this.#publicKey = pair.publicKey;
      this.#privateKey = pair.privateKey;
      this.coseAlg = -8;
    }
  }

  coseKey(): Buffer {
    const jwk = this.#publicKey.export({ format: 'jwk' }) as Record<string, string>;
    const map = new Map<CborInput, CborInput>();
    if (this.coseAlg === -7) {
      map.set(1, 2); map.set(3, -7); map.set(-1, 1);
      map.set(-2, fromB64u(jwk['x'] as string)); map.set(-3, fromB64u(jwk['y'] as string));
    } else if (this.coseAlg === -257) {
      map.set(1, 3); map.set(3, -257);
      map.set(-1, fromB64u(jwk['n'] as string)); map.set(-2, fromB64u(jwk['e'] as string));
    } else {
      map.set(1, 1); map.set(3, -8); map.set(-1, 6); map.set(-2, fromB64u(jwk['x'] as string));
    }
    return cborEncode(map);
  }

  authData({ includeCredential, flags, signCount, rpId = this.rpId }: {
    includeCredential: boolean; flags: number; signCount: number; rpId?: string;
  }): Buffer {
    const parts = [createHash('sha256').update(rpId).digest(), Buffer.from([flags])];
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(signCount);
    parts.push(counter);
    if (includeCredential) {
      const credIdLen = Buffer.alloc(2);
      credIdLen.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), credIdLen, this.credentialId, this.coseKey());
    }
    return Buffer.concat(parts);
  }

  clientData(type: string, challenge: string, origin = this.origin): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8');
  }

  /** Una respuesta con la forma de `navigator.credentials.create()`. */
  register({ challenge, userVerified = true, rpId, origin }: {
    challenge: string; userVerified?: boolean; rpId?: string; origin?: string;
  }) {
    const flags = FLAG.UP | FLAG.AT | (userVerified ? FLAG.UV : 0);
    const authData = this.authData({ includeCredential: true, flags, signCount: this.signCount, ...(rpId ? { rpId } : {}) });
    const attestationObject = cborEncode(new Map<CborInput, CborInput>([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', authData],
    ]));
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64u(this.clientData('webauthn.create', challenge, origin)),
        attestationObject: b64u(attestationObject),
        transports: ['internal'],
      },
    };
  }

  /**
   * Una respuesta con la forma de `navigator.credentials.get()`.
   *
   * `userHandle` se entrega ya decodificado a texto, que es como lo manda el front: el
   * autenticador guarda los bytes UTF-8 del userId opaco.
   */
  authenticate({ challenge, userVerified = true, signCount, rpId, origin, userHandle }: {
    challenge: string; userVerified?: boolean; signCount?: number; rpId?: string;
    origin?: string; userHandle?: string | null;
  }) {
    this.signCount = signCount === undefined ? this.signCount + 1 : signCount;
    const flags = FLAG.UP | (userVerified ? FLAG.UV : 0);
    const authData = this.authData({ includeCredential: false, flags, signCount: this.signCount, ...(rpId ? { rpId } : {}) });
    const clientDataJSON = this.clientData('webauthn.get', challenge, origin);
    const signedData = Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]);
    const signature = this.coseAlg === -8
      ? cryptoSign(null, signedData, this.#privateKey)
      : cryptoSign('sha256', signedData, this.#privateKey);
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: userHandle ?? null,
      },
    };
  }
}
