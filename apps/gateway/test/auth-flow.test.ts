/**
 * Contratos AUTH-*: la cadena de login completa contra un autenticador real (falso, pero con
 * claves y firmas de verdad) y el store en formato v1.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAuthenticator } from '@jarvis/testkit';
import { buildGateway } from '../src/app.js';
import { config } from '../src/config.js';
import { hashPassword } from '../src/lib/password.js';
import { resetLimitersForTests } from '../src/lib/ratelimit.js';
import { users, userStoreFile, type User } from '../src/lib/store.js';
import { resetChallengesForTests } from '../src/routes/auth.js';
import { session } from '../src/lib/session.js';

const app = buildGateway();

async function post(url: string, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url, payload: payload as object, headers });
}

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value).split(';')[0] as string;
}

let user: User;

beforeEach(() => {
  resetLimitersForTests();
  resetChallengesForTests();
  session.resetRevokedForTests();
  for (const existing of users.list()) users.remove(existing.username);
  user = users.create({ username: 'braian', displayName: 'Braian' });
});

/** Enrola una passkey como lo haría la persona: código por terminal, luego navegador. */
async function enroll(authenticator: FakeAuthenticator) {
  const code = users.issueEnrollmentCode(user.userId);
  const options = await post('/auth/enroll/options', { code });
  expect(options.statusCode).toBe(200);
  const body = options.json() as { challengeId: string; publicKey: { challenge: string; user: { id: string } } };
  const credential = authenticator.register({ challenge: body.publicKey.challenge });
  const verified = await post('/auth/enroll/verify', { challengeId: body.challengeId, credential });
  expect(verified.statusCode).toBe(200);
  return body;
}

async function loginWithPasskey(authenticator: FakeAuthenticator, { userHandle }: { userHandle?: string | null } = {}) {
  const options = await post('/auth/passkey/options', {});
  const body = options.json() as { challengeId: string; publicKey: { challenge: string } };
  const credential = authenticator.authenticate({
    challenge: body.publicKey.challenge,
    userHandle: userHandle === undefined ? user.userId : userHandle,
  });
  return post('/auth/passkey/verify', { challengeId: body.challengeId, credential });
}

describe('AUTH-STORE-01: formato v1', () => {
  it('el userId es opaco y no lleva nada personal', () => {
    expect(user.userId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(user.userId).not.toContain('braian');
  });

  it('el fichero en disco tiene la forma v1 y permisos privados', async () => {
    await enroll(new FakeAuthenticator());
    const stored = JSON.parse(readFileSync(userStoreFile(), 'utf8')) as { version: number; users: User[] };
    expect(stored.version).toBe(1);
    const saved = stored.users[0] as User;
    expect(Object.keys(saved).sort()).toEqual(
      ['createdAt', 'credentials', 'displayName', 'enabled', 'enrollment', 'passwordHash', 'totp', 'userId', 'username'],
    );
    const credential = saved.credentials[0]!;
    // La clave se guarda como JWK, no COSE: eso es lo que permite no re-enrolar en el cutover.
    expect(credential.publicKeyJwk.kty).toBe('EC');
    expect(credential.alg).toBe(-7);
    expect(credential).toHaveProperty('signCount');
    expect(credential).toHaveProperty('aaguid');
  });

  it('un código de enrolamiento sólo sirve una vez', async () => {
    const code = users.issueEnrollmentCode(user.userId);
    const first = await post('/auth/enroll/options', { code });
    expect(first.statusCode).toBe(200);
    const body = first.json() as { challengeId: string; publicKey: { challenge: string } };
    const authenticator = new FakeAuthenticator();
    await post('/auth/enroll/verify', {
      challengeId: body.challengeId,
      credential: authenticator.register({ challenge: body.publicKey.challenge }),
    });
    expect((await post('/auth/enroll/options', { code })).statusCode).toBe(401);
  });
});

describe('AUTH-WEBAUTHN-01', () => {
  it('una passkey enrolada entra y devuelve cookie de sesión', async () => {
    const authenticator = new FakeAuthenticator();
    await enroll(authenticator);
    const response = await loginWithPasskey(authenticator);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ authenticated: true, user: { username: 'braian' } });
    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });

  it.each(['RS256', 'EdDSA'] as const)('acepta también %s', async (algorithm) => {
    const authenticator = new FakeAuthenticator({ algorithm });
    await enroll(authenticator);
    expect((await loginWithPasskey(authenticator)).statusCode).toBe(200);
  });

  it('un challenge no se puede reutilizar', async () => {
    const authenticator = new FakeAuthenticator();
    await enroll(authenticator);
    const options = await post('/auth/passkey/options', {});
    const body = options.json() as { challengeId: string; publicKey: { challenge: string } };
    const first = await post('/auth/passkey/verify', {
      challengeId: body.challengeId,
      credential: authenticator.authenticate({ challenge: body.publicKey.challenge, userHandle: user.userId }),
    });
    expect(first.statusCode).toBe(200);
    const replay = await post('/auth/passkey/verify', {
      challengeId: body.challengeId,
      credential: authenticator.authenticate({ challenge: body.publicKey.challenge, userHandle: user.userId }),
    });
    expect(replay.statusCode).toBe(400);
  });

  it('rechaza un origen que no está permitido', async () => {
    const authenticator = new FakeAuthenticator();
    await enroll(authenticator);
    const options = await post('/auth/passkey/options', {});
    const body = options.json() as { challengeId: string; publicKey: { challenge: string } };
    const response = await post('/auth/passkey/verify', {
      challengeId: body.challengeId,
      credential: authenticator.authenticate({
        challenge: body.publicKey.challenge, origin: 'https://phishing.example', userHandle: user.userId,
      }),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: expect.stringContaining('origin') });
  });

  it('rechaza un rpId que no es el configurado', async () => {
    const authenticator = new FakeAuthenticator();
    await enroll(authenticator);
    const options = await post('/auth/passkey/options', {});
    const body = options.json() as { challengeId: string; publicKey: { challenge: string } };
    const response = await post('/auth/passkey/verify', {
      challengeId: body.challengeId,
      credential: authenticator.authenticate({ challenge: body.publicKey.challenge, rpId: 'otra.example', userHandle: user.userId }),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: expect.stringContaining('rpIdHash') });
  });

  it('exige verificación de usuario: sin huella ni PIN no se entra', async () => {
    const authenticator = new FakeAuthenticator();
    await enroll(authenticator);
    const options = await post('/auth/passkey/options', {});
    const body = options.json() as { challengeId: string; publicKey: { challenge: string } };
    const response = await post('/auth/passkey/verify', {
      challengeId: body.challengeId,
      credential: authenticator.authenticate({ challenge: body.publicKey.challenge, userVerified: false, userHandle: user.userId }),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: expect.stringContaining('user verification') });
  });

  it('un contador de firma que retrocede se rechaza: la credencial podría estar clonada', async () => {
    const authenticator = new FakeAuthenticator();
    await enroll(authenticator);
    await loginWithPasskey(authenticator); // deja el contador en 1
    const options = await post('/auth/passkey/options', {});
    const body = options.json() as { challengeId: string; publicKey: { challenge: string } };
    const response = await post('/auth/passkey/verify', {
      challengeId: body.challengeId,
      credential: authenticator.authenticate({ challenge: body.publicKey.challenge, signCount: 1, userHandle: user.userId }),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: expect.stringContaining('cloned') });
  });

  it('un userHandle de otra cuenta no vale', async () => {
    const authenticator = new FakeAuthenticator();
    await enroll(authenticator);
    const response = await loginWithPasskey(authenticator, { userHandle: 'otro-handle' });
    expect(response.statusCode).toBe(401);
  });

  it('una cuenta deshabilitada no entra aunque la firma sea válida', async () => {
    const authenticator = new FakeAuthenticator();
    await enroll(authenticator);
    users.update(user.userId, (u) => { u.enabled = false; });
    expect((await loginWithPasskey(authenticator)).statusCode).toBe(401);
  });

  it('las opciones de login no revelan si una cuenta existe', async () => {
    const known = await post('/auth/passkey/options', { username: 'braian' });
    const unknown = await post('/auth/passkey/options', { username: 'no-existe' });
    expect(known.statusCode).toBe(unknown.statusCode);
    const a = known.json() as { publicKey: unknown };
    const b = unknown.json() as { publicKey: unknown };
    expect(Object.keys(a.publicKey as object)).toEqual(Object.keys(b.publicKey as object));
    expect((a.publicKey as { allowCredentials: unknown[] }).allowCredentials).toEqual([]);
  });
});

describe('AUTH-SESSION-01', () => {
  it('/auth/me exige sesión y refleja el estado de la cuenta', async () => {
    const authenticator = new FakeAuthenticator();
    await enroll(authenticator);
    expect((await app.inject({ method: 'GET', url: '/auth/me' })).statusCode).toBe(401);

    const login = await loginWithPasskey(authenticator);
    const cookie = cookieFrom(login as never);
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ authenticated: true });

    users.update(user.userId, (u) => { u.enabled = false; });
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('logout revoca la sesión en el servidor, no sólo en el navegador', async () => {
    const authenticator = new FakeAuthenticator();
    await enroll(authenticator);
    const cookie = cookieFrom(await loginWithPasskey(authenticator) as never);
    await post('/auth/logout', {}, { cookie });
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('una cookie con percent-encoding inválido no tumba el gateway', async () => {
    const response = await app.inject({
      method: 'GET', url: '/auth/me', headers: { cookie: 'jarvis_session=%' },
    });
    expect(response.statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  it('un token pending no sirve como cookie de sesión', async () => {
    const authenticator = new FakeAuthenticator();
    await enroll(authenticator);
    const { pending } = await import('../src/lib/session.js');
    const token = pending.issue({ userId: user.userId, completed: ['passkey'] });
    const response = await app.inject({
      method: 'GET', url: '/auth/me', headers: { cookie: `jarvis_session=${token}` },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('AUTH-CHAIN-01', () => {
  it('el token pending de una cuenta no completa el paso de otra', async () => {
    const other = users.create({ username: 'otro' });
    users.update(other.userId, (u) => { u.passwordHash = null; });
    const { pending } = await import('../src/lib/session.js');
    const stolen = pending.issue({ userId: other.userId, completed: ['passkey'] });

    users.update(user.userId, (u) => { u.passwordHash = null; });
    const passwordHash = await hashPassword('secreta');
    users.update(user.userId, (u) => { u.passwordHash = passwordHash; });

    // La política por defecto es sólo passkey, así que el paso de password no está habilitado:
    // el contrato aquí es que presentar un pending ajeno nunca suma pasos.
    const response = await post('/auth/password/verify', {
      username: 'braian', password: 'secreta', pending: stolen,
    });
    expect([401, 404]).toContain(response.statusCode);
  });

  it('la configuración pública describe la cadena sin revelar cuentas', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/config' });
    expect(response.json()).toMatchObject({
      rpId: config.rpId,
      steps: ['passkey'],
      discoverableLogin: true,
      userVerification: 'required',
      insecureLogin: false,
    });
  });
});

describe('AUTH-RATE-01', () => {
  it('un intento repetido con credencial desconocida acaba throttleado', async () => {
    const authenticator = new FakeAuthenticator(); // nunca enrolada
    let lastStatus = 0;
    for (let i = 0; i < 8; i += 1) {
      const options = await post('/auth/passkey/options', {});
      const body = options.json() as { challengeId?: string; publicKey?: { challenge: string } };
      if (!body.publicKey) { lastStatus = options.statusCode; break; }
      const response = await post('/auth/passkey/verify', {
        challengeId: body.challengeId,
        credential: authenticator.authenticate({ challenge: body.publicKey.challenge }),
      });
      lastStatus = response.statusCode;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });
});
