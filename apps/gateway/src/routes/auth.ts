/**
 * Autenticación: una cadena de pasos y las rutas que la conducen.
 *
 * `JARVIS_AUTH_POLICY` nombra los pasos ordenados que un login debe completar — `passkey` por
 * defecto, `password+passkey` si se quiere un secreto compartido delante del biométrico. Añadir
 * un factor más tarde es registrar un paso más y nombrarlo en la política; el flujo no cambia.
 * Ese es todo el sentido del diseño (decisión D8).
 *
 * Contratos AUTH-CHAIN-01, AUTH-SESSION-01, AUTH-INSECURE-01.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config, isPrivateAddress } from '../config.js';
import { audit } from '../lib/audit.js';
import { verifyPassword } from '../lib/password.js';
import { clientIp, createLimiter } from '../lib/ratelimit.js';
import { parseCookies, pending, session, SESSION_COOKIE } from '../lib/session.js';
import { canLogin, publicUser, users, type User } from '../lib/store.js';
import { verifyCode } from '../lib/totp.js';
import { newChallenge, verifyAssertion, verifyRegistration, WebAuthnError, type CredentialResponse } from '../lib/webauthn.js';

const limiter = createLimiter({
  maxAttempts: config.loginMaxAttempts,
  windowSeconds: config.loginWindowSeconds,
});

interface ChallengeEntry {
  challenge: string;
  purpose: 'assertion' | 'attestation';
  userId: string | null;
  expiresAt: number;
}

// Los challenges viven en memoria, son de un solo uso y caducan. Uno reutilizable haría
// reproducible cualquier ceremonia grabada.
const challenges = new Map<string, ChallengeEntry>();

function issueChallenge(purpose: ChallengeEntry['purpose'], userId: string | null): { id: string; challenge: string } {
  const id = randomUUID();
  const challenge = newChallenge();
  challenges.set(id, {
    challenge, purpose, userId,
    expiresAt: Date.now() + config.challengeTtlSeconds * 1000,
  });
  return { id, challenge };
}

function consumeChallenge(id: string | undefined, purpose: ChallengeEntry['purpose']): ChallengeEntry | null {
  if (!id) return null;
  const entry = challenges.get(id);
  if (!entry) return null;
  challenges.delete(id); // de un solo uso, incluso al fallar
  if (entry.purpose !== purpose || entry.expiresAt < Date.now()) return null;
  return entry;
}

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of challenges) if (entry.expiresAt < now) challenges.delete(id);
}, 60_000);
sweeper.unref();

/**
 * Qué pasos debe completar este login en concreto.
 *
 * Normalmente la política configurada, tal cual. La única excepción es la escotilla temporal
 * sobre HTTP: ahí el navegador no expone WebAuthn en absoluto, así que una política que exige
 * passkey no la puede satisfacer nadie.
 */
export function effectivePolicy(ip: string): { steps: string[]; insecure: boolean; refusedRemote?: boolean } {
  if (!config.insecureLogin) return { steps: [...config.authPolicy], insecure: false };
  if (config.insecureLoginLanOnly && !isPrivateAddress(ip)) {
    // Abierta en la LAN es una cosa; abierta a internet es otra completamente distinta.
    return { steps: [...config.authPolicy], insecure: false, refusedRemote: true };
  }
  return { steps: ['password'], insecure: true };
}

/**
 * Pasos ya completados, según un token pending opcional.
 *
 * Un token pending registra el progreso de exactamente una cuenta, así que un paso que enumera
 * sólo cuenta si el paso que se verifica ahora pertenece a esa misma cuenta. Sin esa comprobación
 * la cadena suma entre cuentas: alguien satisface el paso de passkey con su propia llave y luego
 * presenta ese token junto con la contraseña de la víctima.
 */
function readPending(token: string | undefined, expectedUserId?: string): { userId: string; completed: string[] } | null {
  if (!token) return null;
  const payload = pending.read(token);
  if (!payload) return null;
  if (expectedUserId && payload.sub !== expectedUserId) {
    audit('login.pending.account_mismatch', { expected: expectedUserId, presented: payload.sub });
    return null;
  }
  return { userId: payload.sub, completed: payload.completed ?? [] };
}

/** Registra un paso completado: o la cadena termina y se emite cookie, o se dice qué falta. */
function advance(reply: FastifyReply, user: User, completedSteps: string[], ip: string): FastifyReply {
  const { steps, insecure } = effectivePolicy(ip);
  const remaining = steps.filter((step) => !completedSteps.includes(step));
  if (remaining.length === 0) {
    limiter.succeed(`user:${user.username}`);
    limiter.succeed(`ip:${ip}`);
    audit(insecure ? 'login.success.insecure' : 'login.success',
      { username: user.username, ip, steps: completedSteps, insecure });
    return reply
      .header('Set-Cookie', session.cookie(session.issue(user)))
      .send({ authenticated: true, user: publicUser(user) });
  }
  return reply.send({
    authenticated: false,
    next: remaining[0],
    pending: pending.issue({ userId: user.userId, completed: completedSteps }),
  });
}

function throttle(request: FastifyRequest, reply: FastifyReply, keys: string[]): string | null {
  const ip = clientIp(request.raw, config.trustProxy);
  for (const key of [`ip:${ip}`, ...keys]) {
    const verdict = limiter.check(key);
    if (!verdict.allowed) {
      audit('login.throttled', { key, ip, retryAfter: verdict.retryAfter });
      void reply.code(429).header('Retry-After', String(verdict.retryAfter))
        .send({ error: `too many attempts; retry in ${verdict.retryAfter}s` });
      return null;
    }
  }
  return ip;
}

function penalize(ip: string, keys: string[]): void {
  limiter.fail(`ip:${ip}`);
  for (const key of keys) limiter.fail(key);
}

export interface SessionUser { sub: string; username: string }

interface AuthBody {
  username?: string;
  password?: string;
  pending?: string;
  challengeId?: string;
  credential?: CredentialResponse;
  code?: string;
  recoveryCode?: string;
  name?: string;
}

export function registerAuthRoutes(app: FastifyInstance, currentUser: (req: FastifyRequest) => SessionUser | null): void {
  /** Descripción pública de lo que debe hacer la página de login. No revela quién existe. */
  app.get('/auth/config', async (request, reply) => {
    const policy = effectivePolicy(clientIp(request.raw, config.trustProxy));
    return reply.send({
      rpId: config.rpId,
      rpName: config.rpName,
      steps: policy.steps,
      // Con `passkey` primero y sin necesidad de usuario, la página ofrece login de un toque.
      discoverableLogin: policy.steps[0] === 'passkey',
      userVerification: config.requireUserVerification ? 'required' : 'preferred',
      // La página muestra un aviso permanente mientras esto sea cierto.
      insecureLogin: policy.insecure,
    });
  });

  app.get('/auth/me', async (request, reply) => {
    const claims = currentUser(request);
    if (!claims) return reply.code(401).send({ error: 'not authenticated' });
    const user = users.findByUserId(claims.sub);
    if (!user || !user.enabled) return reply.code(401).send({ error: 'account is disabled' });
    return reply.send({
      authenticated: true,
      user: publicUser(user),
      insecureLogin: config.insecureLogin,
    });
  });

  app.post('/auth/logout', async (request, reply) => {
    const claims = currentUser(request);
    // Se revoca también en el servidor: borrar la cookie sólo se lo pide a este navegador.
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (token) session.revoke(token);
    if (claims) audit('logout', { username: claims.username });
    return reply.header('Set-Cookie', session.clearCookie()).send({ ok: true });
  });

  app.post('/auth/password/verify', async (request, reply) => {
    const clientAddress = clientIp(request.raw, config.trustProxy);
    const policy = effectivePolicy(clientAddress);
    if (!policy.steps.includes('password')) {
      if (policy.refusedRemote) {
        audit('login.insecure.refused_remote', { ip: clientAddress });
        return reply.code(403).send({ error: 'password login over plain HTTP is limited to the local network' });
      }
      return reply.code(404).send({ error: 'password step is not enabled' });
    }

    const body = (request.body ?? {}) as AuthBody;
    const username = String(body.username ?? '');
    const ip = throttle(request, reply, [`user:${username}`]);
    if (!ip) return reply;

    const user = users.findByUsername(username);
    const ok = user && await verifyPassword(String(body.password ?? ''), user.passwordHash);
    // Bajo la escotilla la cuenta se juzga contra la cadena de sólo contraseña, para que una
    // cuenta sin passkey no quede fuera por una política que no puede satisfacer.
    if (!ok || !canLogin(user, policy.steps)) {
      penalize(ip, [`user:${username}`]);
      audit(policy.insecure ? 'login.password.failed.insecure' : 'login.password.failed',
        { username, ip, insecure: policy.insecure });
      // Un solo mensaje para todos los fallos: usuario, contraseña o cuenta deshabilitada.
      return reply.code(401).send({ error: 'invalid credentials' });
    }
    const state = readPending(body.pending, user.userId);
    const completed = [...new Set([...(state?.completed ?? []), 'password'])];
    return advance(reply, user, completed, ip);
  });

  app.post('/auth/passkey/options', async (request, reply) => {
    const body = (request.body ?? {}) as AuthBody;
    const state = readPending(body.pending);
    const username = state ? null : body.username;
    const ip = throttle(request, reply, username ? [`user:${username}`] : []);
    if (!ip) return reply;

    const user = state ? users.findByUserId(state.userId) : (username ? users.findByUsername(username) : null);

    /**
     * La respuesta tiene exactamente la misma forma exista o no la cuenta: este endpoint es
     * público y cualquier cosa que varíe con el nombre es un oráculo de enumeración — uno que
     * además repartiría ids de credencial, que siguen a una persona entre servicios.
     */
    const { id, challenge } = issueChallenge('assertion', user?.userId ?? null);
    return reply.send({
      challengeId: id,
      publicKey: {
        challenge,
        rpId: config.rpId,
        allowCredentials: [],
        userVerification: config.requireUserVerification ? 'required' : 'preferred',
        timeout: config.challengeTtlSeconds * 1000,
      },
    });
  });

  app.post('/auth/passkey/verify', async (request, reply) => {
    const body = (request.body ?? {}) as AuthBody;
    const ip = throttle(request, reply, []);
    if (!ip) return reply;

    const entry = consumeChallenge(body.challengeId, 'assertion');
    if (!entry) return reply.code(400).send({ error: 'challenge expired or already used' });

    const credentialId = body.credential?.id ?? body.credential?.rawId;
    const found = users.findByCredentialId(credentialId);
    if (!found) {
      penalize(ip, []);
      audit('login.passkey.unknown_credential', { ip });
      return reply.code(401).send({ error: 'unknown credential' });
    }
    const { user, credential } = found;

    // Login de un toque: el autenticador devuelve el handle opaco que guardó al registrarse, y
    // así se resuelve la cuenta sin que el usuario teclee nada.
    const userHandle = body.credential?.response?.userHandle;
    if (userHandle && userHandle !== user.userId) {
      audit('login.passkey.handle_mismatch', { ip, username: user.username });
      return reply.code(401).send({ error: 'credential does not belong to this account' });
    }
    if (entry.userId && entry.userId !== user.userId) {
      return reply.code(401).send({ error: 'credential does not match the requested account' });
    }
    if (!canLogin(user)) {
      audit('login.passkey.disabled_account', { ip, username: user.username });
      return reply.code(401).send({ error: 'invalid credentials' });
    }

    let result;
    try {
      result = verifyAssertion({
        credential: body.credential,
        expectedChallenge: entry.challenge,
        rpId: config.rpId,
        allowedOrigins: config.origins,
        storedCredential: credential,
        requireUserVerification: config.requireUserVerification,
      });
    } catch (error) {
      penalize(ip, [`user:${user.username}`]);
      audit('login.passkey.failed', { ip, username: user.username, reason: (error as Error).message });
      if (error instanceof WebAuthnError) return reply.code(401).send({ error: error.message });
      throw error;
    }

    users.touchCredential(user.userId, credential.credentialId, result.signCount);
    const state = readPending(body.pending, user.userId);
    const completed = [...new Set([...(state?.completed ?? []), 'passkey'])];
    return advance(reply, users.findByUserId(user.userId) as User, completed, ip);
  });

  app.post('/auth/totp/verify', async (request, reply) => {
    if (!config.authPolicy.includes('totp')) {
      return reply.code(404).send({ error: 'the totp step is not enabled' });
    }
    const body = (request.body ?? {}) as AuthBody;
    const ip = throttle(request, reply, []);
    if (!ip) return reply;

    const state = readPending(body.pending);
    if (!state) return reply.code(401).send({ error: 'start the login again' });
    const user = users.findByUserId(state.userId);
    if (!user?.totp?.confirmed) return reply.code(401).send({ error: 'invalid credentials' });

    // Un código de recuperación es la vuelta cuando el teléfono ya no está. De un solo uso, y no
    // avanza el contador porque no es un código temporal.
    if (body.recoveryCode) {
      if (!users.useRecoveryCode(user.userId, body.recoveryCode)) {
        penalize(ip, [`user:${user.username}`]);
        audit('login.totp.bad_recovery', { ip, username: user.username });
        return reply.code(401).send({ error: 'invalid code' });
      }
      audit('login.totp.recovery_used', {
        ip, username: user.username,
        remaining: users.findByUserId(user.userId)?.totp?.recoveryCodes.length ?? 0,
      });
      return advance(reply, user, [...new Set([...state.completed, 'totp'])], ip);
    }

    const result = verifyCode(user.totp.secret, String(body.code ?? ''), { lastCounter: user.totp.lastCounter });
    if (!result.ok) {
      penalize(ip, [`user:${user.username}`]);
      audit('login.totp.failed', { ip, username: user.username, reason: result.reason });
      return reply.code(401).send({ error: result.reason ?? 'invalid code' });
    }
    // Se recuerda el contador para que el mismo código no valga dos veces dentro de su ventana.
    users.update(user.userId, (u) => { if (u.totp) u.totp.lastCounter = result.counter as number; });

    return advance(reply, users.findByUserId(user.userId) as User,
      [...new Set([...state.completed, 'totp'])], ip);
  });

  /**
   * El enrolamiento está cerrado por un código de un solo uso producido en la máquina con
   * `jarvis-users enroll`. No hay otra forma de atar una passkey a una cuenta, ni ninguna de
   * crear una cuenta desde la web.
   */
  app.post('/auth/enroll/options', async (request, reply) => {
    const body = (request.body ?? {}) as AuthBody;
    const ip = throttle(request, reply, []);
    if (!ip) return reply;

    const user = users.consumableEnrollment(String(body.code ?? '').trim().toUpperCase());
    if (!user || !user.enabled) {
      penalize(ip, []);
      audit('enroll.bad_code', { ip });
      return reply.code(401).send({ error: 'invalid or expired enrollment code' });
    }

    const { id, challenge } = issueChallenge('attestation', user.userId);
    return reply.send({
      challengeId: id,
      publicKey: {
        challenge,
        rp: { id: config.rpId, name: config.rpName },
        user: {
          // Opaco y permanente: algunos autenticadores lo guardan para siempre.
          id: user.userId,
          name: user.username,
          displayName: user.displayName,
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },    // ES256, lo que usa casi cualquier autenticador de plataforma
          { type: 'public-key', alg: -8 },    // Ed25519
          { type: 'public-key', alg: -257 },  // RS256, Windows Hello / TPM antiguos
        ],
        authenticatorSelection: {
          // Una credencial descubrible es lo que hace posible el login de un toque.
          residentKey: 'required',
          requireResidentKey: true,
          // Esta línea es la que obliga a la huella (o cara, o PIN) en cada login.
          userVerification: config.requireUserVerification ? 'required' : 'preferred',
        },
        excludeCredentials: user.credentials.map((c) => ({ id: c.credentialId, type: 'public-key' })),
        attestation: 'none',
        timeout: config.challengeTtlSeconds * 1000,
      },
    });
  });

  app.post('/auth/enroll/verify', async (request, reply) => {
    const body = (request.body ?? {}) as AuthBody;
    const ip = throttle(request, reply, []);
    if (!ip) return reply;

    const entry = consumeChallenge(body.challengeId, 'attestation');
    if (!entry) return reply.code(400).send({ error: 'challenge expired or already used' });
    const user = users.findByUserId(entry.userId ?? undefined);
    if (!user || !user.enabled) return reply.code(401).send({ error: 'account is not available' });

    let stored;
    try {
      stored = verifyRegistration({
        credential: body.credential,
        expectedChallenge: entry.challenge,
        rpId: config.rpId,
        allowedOrigins: config.origins,
        requireUserVerification: config.requireUserVerification,
      });
    } catch (error) {
      penalize(ip, []);
      audit('enroll.failed', { ip, username: user.username, reason: (error as Error).message });
      if (error instanceof WebAuthnError) return reply.code(400).send({ error: error.message });
      throw error;
    }

    if (user.credentials.some((c) => c.credentialId === stored.credentialId)) {
      return reply.code(409).send({ error: 'this passkey is already registered' });
    }

    users.addCredential(user.userId, stored, body.name);
    users.clearEnrollment(user.userId); // el código muere con su primer uso correcto
    audit('enroll.success', {
      ip, username: user.username, credentialId: stored.credentialId,
      aaguid: stored.aaguid, alg: stored.alg,
    });
    return reply.send({ ok: true, username: user.username, credentialId: stored.credentialId });
  });
}

export function resetChallengesForTests(): void {
  challenges.clear();
}
