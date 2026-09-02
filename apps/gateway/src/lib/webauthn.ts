/**
 * Verificación WebAuthn / passkey sólo con node:crypto.
 *
 * Cada comprobación cierra un agujero concreto:
 *   challenge   de un solo uso y generado por el servidor, o la ceremonia se replica
 *   origin      ata la aserción a este sitio, para que una página de phishing no la retransmita
 *   rpIdHash    la visión del propio autenticador sobre para quién firma
 *   UP          una persona tocó físicamente el autenticador
 *   UV          esa persona se verificó con huella, cara o PIN
 *   signCount   un contador que retrocede significa que la credencial puede estar clonada
 *
 * La attestation NO se verifica a propósito: juzgarla exige el servicio de metadatos de FIDO, y
 * aquí el ancla de confianza es el código de enrolamiento entregado por terminal, no el
 * fabricante del autenticador.
 *
 * Contrato AUTH-WEBAUTHN-01. El formato almacenado es el de `users.json` v1: JWK, no COSE
 * (ADR-006).
 */
import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from 'node:crypto';
import { decode, decodeItem, type CborValue } from './cbor.js';

export class WebAuthnError extends Error {
  override name = 'WebAuthnError';
}

export const b64u = {
  encode(buf: Buffer | Uint8Array): string {
    return Buffer.from(buf).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str: string): Buffer {
    if (typeof str !== 'string') throw new WebAuthnError('expected a base64url string');
    const padded = str.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64');
  },
};

export const newChallenge = (): string => b64u.encode(randomBytes(32));

/**
 * Handle de usuario opaco y permanente. Nunca se deriva del nombre ni del email: algunos
 * autenticadores lo guardan para siempre, así que no puede llevar datos personales ni cambiar.
 */
export const newUserId = (): string => b64u.encode(randomBytes(32));

export interface AuthenticatorFlags {
  userPresent: boolean;
  userVerified: boolean;
  backupEligible: boolean;
  backedUp: boolean;
  attestedCredentialData: boolean;
  extensionData: boolean;
}

export interface ParsedAuthenticatorData {
  rpIdHash: Buffer;
  flags: AuthenticatorFlags;
  signCount: number;
  aaguid: Buffer | null;
  credentialId: Buffer | null;
  cosePublicKey: CborValue | null;
  rawLength: number;
}

export function parseAuthenticatorData(authData: Buffer): ParsedAuthenticatorData {
  if (authData.length < 37) throw new WebAuthnError('authenticator data is too short');
  const rpIdHash = authData.subarray(0, 32);
  const flagsByte = authData.readUInt8(32);
  const flags: AuthenticatorFlags = {
    userPresent: (flagsByte & 0x01) !== 0,
    userVerified: (flagsByte & 0x04) !== 0,
    backupEligible: (flagsByte & 0x08) !== 0,
    backedUp: (flagsByte & 0x10) !== 0,
    attestedCredentialData: (flagsByte & 0x40) !== 0,
    extensionData: (flagsByte & 0x80) !== 0,
  };
  const signCount = authData.readUInt32BE(33);

  let aaguid: Buffer | null = null;
  let credentialId: Buffer | null = null;
  let cosePublicKey: CborValue | null = null;
  let cursor = 37;

  if (flags.attestedCredentialData) {
    if (authData.length < cursor + 18) throw new WebAuthnError('attested credential data is truncated');
    aaguid = authData.subarray(cursor, cursor + 16);
    cursor += 16;
    const credIdLength = authData.readUInt16BE(cursor);
    cursor += 2;
    if (authData.length < cursor + credIdLength) throw new WebAuthnError('credential id is truncated');
    credentialId = authData.subarray(cursor, cursor + credIdLength);
    cursor += credIdLength;
    // La clave COSE es de longitud variable; el decoder dice dónde acabó para que un bloque de
    // extensiones posterior no se trague dentro de la clave.
    const parsed = decodeItem(authData, cursor);
    cosePublicKey = parsed.value;
    cursor = parsed.offset;
  }

  return { rpIdHash, flags, signCount, aaguid, credentialId, cosePublicKey, rawLength: cursor };
}

const COSE = { kty: 1, alg: 3, crv: -1, x: -2, y: -3, n: -1, e: -2 } as const;
const EC_CURVES: Record<number, string> = { 1: 'P-256', 2: 'P-384', 3: 'P-521' };
const SUPPORTED_ALGS = new Set([-7, -8, -257]); // ES256, EdDSA(Ed25519), RS256

export interface StoredJwk {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
}

/** Convierte un COSE_Key en el JWK que se guarda como JSON y se reimporta en cada login. */
export function coseToJwk(cose: CborValue | null): { alg: number; jwk: StoredJwk } {
  if (!(cose instanceof Map)) throw new WebAuthnError('credential public key is not a CBOR map');
  const kty = cose.get(COSE.kty);
  const alg = cose.get(COSE.alg) as number;
  if (!SUPPORTED_ALGS.has(alg)) throw new WebAuthnError(`unsupported COSE algorithm ${alg}`);

  if (kty === 2) {
    const crv = EC_CURVES[cose.get(COSE.crv) as number];
    if (!crv) throw new WebAuthnError(`unsupported EC curve ${String(cose.get(COSE.crv))}`);
    return {
      alg,
      jwk: {
        kty: 'EC', crv,
        x: b64u.encode(cose.get(COSE.x) as Buffer),
        y: b64u.encode(cose.get(COSE.y) as Buffer),
      },
    };
  }
  if (kty === 3) {
    return {
      alg,
      jwk: { kty: 'RSA', n: b64u.encode(cose.get(COSE.n) as Buffer), e: b64u.encode(cose.get(COSE.e) as Buffer) },
    };
  }
  if (kty === 1) {
    if (cose.get(COSE.crv) !== 6) throw new WebAuthnError('unsupported OKP curve');
    return { alg, jwk: { kty: 'OKP', crv: 'Ed25519', x: b64u.encode(cose.get(COSE.x) as Buffer) } };
  }
  throw new WebAuthnError(`unsupported COSE key type ${String(kty)}`);
}

function verifySignature({ alg, jwk, data, signature }: {
  alg: number; jwk: StoredJwk; data: Buffer; signature: Buffer;
}): boolean {
  const key = createPublicKey({ key: jwk as never, format: 'jwk' });
  if (alg === -8) return cryptoVerify(null, data, key, signature);
  if (alg === -7 || alg === -257) return cryptoVerify('sha256', data, key, signature);
  throw new WebAuthnError(`unsupported algorithm ${alg}`);
}

interface ClientData {
  type?: string;
  challenge?: string;
  origin?: string;
  tokenBinding?: { status?: string; id?: string };
}

function parseClientData(clientDataJSON: Buffer, { expectedType, expectedChallenge, allowedOrigins }: {
  expectedType: string; expectedChallenge: string; allowedOrigins: readonly string[];
}): ClientData {
  let clientData: ClientData;
  try {
    clientData = JSON.parse(clientDataJSON.toString('utf8')) as ClientData;
  } catch {
    throw new WebAuthnError('clientDataJSON is not valid JSON');
  }
  if (clientData.type !== expectedType) {
    throw new WebAuthnError(`wrong ceremony type: expected ${expectedType}, got ${String(clientData.type)}`);
  }
  if (clientData.challenge !== expectedChallenge) {
    throw new WebAuthnError('challenge mismatch (replayed or expired ceremony)');
  }
  if (!allowedOrigins.includes(clientData.origin ?? '')) {
    throw new WebAuthnError(`origin ${String(clientData.origin)} is not allowed`);
  }
  if (clientData.tokenBinding?.status === 'present' && !clientData.tokenBinding.id) {
    throw new WebAuthnError('malformed token binding');
  }
  return clientData;
}

function checkRpIdAndFlags(authData: ParsedAuthenticatorData, { rpId, requireUserVerification }: {
  rpId: string; requireUserVerification: boolean;
}): void {
  const expected = createHash('sha256').update(rpId).digest();
  if (!authData.rpIdHash.equals(expected)) {
    throw new WebAuthnError('rpIdHash does not match the configured relying party id');
  }
  if (!authData.flags.userPresent) throw new WebAuthnError('user presence flag is not set');
  if (requireUserVerification && !authData.flags.userVerified) {
    throw new WebAuthnError('user verification required: the authenticator did not verify the user '
      + '(fingerprint, face or PIN)');
  }
}

export interface CredentialResponse {
  id?: string;
  rawId?: string;
  response?: {
    clientDataJSON?: string;
    attestationObject?: string;
    authenticatorData?: string;
    signature?: string;
    userHandle?: string;
    transports?: string[];
  };
}

export interface StoredCredential {
  credentialId: string;
  publicKeyJwk: StoredJwk;
  alg: number;
  signCount: number;
  aaguid: string | null;
  transports: string[];
  backedUp: boolean;
  attestationFormat: string;
  createdAt: string;
  name?: string;
  lastUsedAt?: string | null;
}

export function verifyRegistration({
  credential, expectedChallenge, rpId, allowedOrigins, requireUserVerification = true,
}: {
  credential: CredentialResponse | undefined;
  expectedChallenge: string;
  rpId: string;
  allowedOrigins: readonly string[];
  requireUserVerification?: boolean;
}): StoredCredential {
  const response = credential?.response;
  if (!response?.clientDataJSON || !response?.attestationObject) {
    throw new WebAuthnError('malformed registration response');
  }
  const clientDataJSON = b64u.decode(response.clientDataJSON);
  parseClientData(clientDataJSON, { expectedType: 'webauthn.create', expectedChallenge, allowedOrigins });

  const attestation = decode(b64u.decode(response.attestationObject));
  if (!(attestation instanceof Map)) throw new WebAuthnError('attestation object is not a CBOR map');
  const authDataBuf = attestation.get('authData');
  if (!Buffer.isBuffer(authDataBuf)) throw new WebAuthnError('attestation object has no authData');

  const authData = parseAuthenticatorData(authDataBuf);
  checkRpIdAndFlags(authData, { rpId, requireUserVerification });
  if (!authData.flags.attestedCredentialData || !authData.credentialId) {
    throw new WebAuthnError('registration response carries no credential');
  }

  const { alg, jwk } = coseToJwk(authData.cosePublicKey);

  return {
    credentialId: b64u.encode(authData.credentialId),
    publicKeyJwk: jwk,
    alg,
    signCount: authData.signCount,
    aaguid: authData.aaguid ? authData.aaguid.toString('hex') : null,
    transports: Array.isArray(response.transports) ? response.transports : [],
    backedUp: authData.flags.backedUp,
    attestationFormat: String(attestation.get('fmt') ?? 'none'),
    createdAt: new Date().toISOString(),
  };
}

export function verifyAssertion({
  credential, expectedChallenge, rpId, allowedOrigins, storedCredential, requireUserVerification = true,
}: {
  credential: CredentialResponse | undefined;
  expectedChallenge: string;
  rpId: string;
  allowedOrigins: readonly string[];
  storedCredential: StoredCredential;
  requireUserVerification?: boolean;
}): { signCount: number; userVerified: boolean; backedUp: boolean } {
  const response = credential?.response;
  if (!response?.clientDataJSON || !response?.authenticatorData || !response?.signature) {
    throw new WebAuthnError('malformed assertion response');
  }
  const clientDataJSON = b64u.decode(response.clientDataJSON);
  parseClientData(clientDataJSON, { expectedType: 'webauthn.get', expectedChallenge, allowedOrigins });

  const authDataBuf = b64u.decode(response.authenticatorData);
  const authData = parseAuthenticatorData(authDataBuf);
  checkRpIdAndFlags(authData, { rpId, requireUserVerification });

  // El autenticador firma authenticatorData concatenado con el hash del client data.
  const signedData = Buffer.concat([authDataBuf, createHash('sha256').update(clientDataJSON).digest()]);
  const ok = verifySignature({
    alg: storedCredential.alg,
    jwk: storedCredential.publicKeyJwk,
    data: signedData,
    signature: b64u.decode(response.signature),
  });
  if (!ok) throw new WebAuthnError('signature verification failed');

  // Un contador que no avanza significa que dos autenticadores responden por una credencial. Los
  // que nunca implementan el contador reportan 0 siempre, y eso es legítimo.
  const previous = storedCredential.signCount || 0;
  if (authData.signCount !== 0 || previous !== 0) {
    if (authData.signCount <= previous) {
      throw new WebAuthnError('signature counter did not advance: the credential may be cloned');
    }
  }

  return {
    signCount: authData.signCount,
    userVerified: authData.flags.userVerified,
    backedUp: authData.flags.backedUp,
  };
}
