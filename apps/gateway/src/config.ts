/**
 * Configuración, resuelta una vez desde el entorno. Todo tiene un valor por defecto seguro salvo
 * el relying party id, que debe coincidir con el dominio que ve el navegador o WebAuthn falla en
 * silencio.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const env = process.env;
const bool = (value: string | undefined, fallback: boolean): boolean =>
  value === undefined ? fallback : /^(1|true|yes|on)$/i.test(value);
const list = (value: string | undefined): string[] =>
  value ? value.split(',').map((s) => s.trim()).filter(Boolean) : [];

const dataDir = env['JARVIS_DATA_DIR'] || '/var/lib/jarvis';

/**
 * Crear el directorio de datos no se hace al importar: muchos módulos importan esta configuración
 * sólo por un puerto o una lista, y obligar a cada uno a tener /var/lib/jarvis escribible
 * convierte una lectura en un crash.
 */
export function ensureDataDir(): string {
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

/** El secreto de firma de sesión se genera una vez y se persiste: reiniciar no echa a nadie. */
let cachedSecret: Buffer | null = null;
function sessionSecret(): Buffer {
  if (cachedSecret) return cachedSecret;
  if (env['JARVIS_SESSION_SECRET']) {
    cachedSecret = Buffer.from(env['JARVIS_SESSION_SECRET'], 'utf8');
    return cachedSecret;
  }
  ensureDataDir();
  const file = join(dataDir, 'session.key');
  if (!existsSync(file)) writeFileSync(file, randomBytes(48).toString('base64'), { mode: 0o600 });
  cachedSecret = Buffer.from(readFileSync(file, 'utf8'), 'base64');
  return cachedSecret;
}

/**
 * El secreto con el que el gateway firma la identidad que le pasa al core. Distinto del de
 * sesión a propósito: son dos confianzas distintas y no deben poder sustituirse una por otra.
 */
let cachedInternalSecret: Buffer | null = null;
function internalSecret(): Buffer {
  if (cachedInternalSecret) return cachedInternalSecret;
  if (env['JARVIS_INTERNAL_SECRET']) {
    cachedInternalSecret = Buffer.from(env['JARVIS_INTERNAL_SECRET'], 'utf8');
    return cachedInternalSecret;
  }
  ensureDataDir();
  const file = join(dataDir, 'internal.key');
  if (!existsSync(file)) writeFileSync(file, randomBytes(48).toString('base64'), { mode: 0o600 });
  cachedInternalSecret = Buffer.from(readFileSync(file, 'utf8'), 'base64');
  return cachedInternalSecret;
}

const rpId = env['JARVIS_RP_ID'] || 'localhost';
const port = Number(env['JARVIS_PORT'] || 8080);
const origins = list(env['JARVIS_ORIGINS']);

/**
 * Orígenes aceptados cuando el despliegue no los nombra.
 *
 * El binding de origen es lo que impide reproducir aquí una aserción capturada por una página de
 * phishing, así que una lista derivada nunca puede ser más generosa que lo que el navegador puede
 * producir: WebAuthn sólo existe en contexto seguro, es decir https, con una excepción —
 * localhost, que los navegadores tratan como seguro sobre http plano.
 */
function derivedOrigins(): string[] {
  if (rpId === 'localhost') return [`https://${rpId}`, `http://${rpId}:${port}`];
  return [`https://${rpId}`];
}

export const config = {
  bind: env['JARVIS_BIND'] || '0.0.0.0',
  port,
  dataDir,
  staticDir: env['JARVIS_STATIC_DIR'] || '/srv/jarvis-web',

  rpId,
  rpName: env['JARVIS_RP_NAME'] || 'Jarvis Bastion',
  origins: origins.length ? origins : derivedOrigins(),

  // Cadena de pasos de autenticación. Añadir un factor es añadir un paso, jamás reescribir el
  // flujo (decisión D8).
  authPolicy: (env['JARVIS_AUTH_POLICY'] || 'passkey').split('+').map((s) => s.trim()).filter(Boolean),
  requireUserVerification: bool(env['JARVIS_REQUIRE_USER_VERIFICATION'], true),

  get sessionSecret(): Buffer { return sessionSecret(); },
  get internalSecret(): Buffer { return internalSecret(); },
  sessionTtlSeconds: Number(env['JARVIS_SESSION_TTL'] || 12 * 3600),
  insecureCookies: bool(env['JARVIS_INSECURE_COOKIES'], false),

  /**
   * ESCOTILLA TEMPORAL — ver docs/security.md.
   *
   * Las passkeys son imposibles sobre HTTP plano: fuera de un contexto seguro el navegador no
   * expone WebAuthn. Hasta que haya certificado, esto permite entrar con contraseña. Está apagada
   * por defecto, se anuncia en todas partes y cada uso se audita como tal.
   */
  insecureLogin: bool(env['JARVIS_INSECURE_LOGIN'], false),
  insecureLoginLanOnly: bool(env['JARVIS_INSECURE_LOGIN_LAN_ONLY'], true),

  challengeTtlSeconds: Number(env['JARVIS_CHALLENGE_TTL'] || 300),
  enrollmentTtlSeconds: Number(env['JARVIS_ENROLLMENT_TTL'] || 15 * 60),

  loginMaxAttempts: Number(env['JARVIS_LOGIN_MAX_ATTEMPTS'] || 5),
  loginWindowSeconds: Number(env['JARVIS_LOGIN_WINDOW'] || 300),

  /**
   * Si se puede creer a X-Forwarded-For. Apagado salvo que el despliegue declare un proxy
   * delante: sin uno, esa cabecera es un valor que elige quien llama.
   */
  trustProxy: bool(env['JARVIS_TRUST_PROXY'], false),

  /** El core. Es el único upstream: el navegador no habla con nada más. */
  coreUrl: env['JARVIS_CORE_URL'] || 'http://core:8770',
  coreTimeoutMs: Number(env['JARVIS_CORE_TIMEOUT_MS'] || 30_000),
} as const;

export function describeConfig() {
  return {
    rpId: config.rpId,
    origins: config.origins,
    authPolicy: config.authPolicy,
    requireUserVerification: config.requireUserVerification,
    secureCookies: !config.insecureCookies,
    insecureLogin: config.insecureLogin,
    insecureLoginLanOnly: config.insecureLoginLanOnly,
    trustProxy: config.trustProxy,
    coreUrl: config.coreUrl,
  };
}

/** Rangos privados, según RFC 1918 / RFC 4193, más loopback. */
export function isPrivateAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  const ip = String(address).replace(/^::ffff:/, '');
  if (ip === '::1' || ip.startsWith('127.')) return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (ip.startsWith('169.254.')) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
  if (/^fe80:/i.test(ip)) return true;
  return false;
}
