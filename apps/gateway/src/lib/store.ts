/**
 * Almacén de usuarios: un único fichero JSON, cargado en memoria y escrito de forma atómica.
 *
 * No hay registro público en ninguna parte de este código. Una cuenta existe porque alguien
 * ejecutó `jarvis-users add` en la máquina, y sólo puede enrolar una passkey mientras viva un
 * código de un solo uso emitido por `jarvis-users enroll`. Ese paso por terminal es el ancla de
 * confianza del sistema entero.
 *
 * Contrato AUTH-STORE-01: el formato es `users.json` v1, idéntico al del stack legacy (ADR-006).
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config, ensureDataDir } from '../config.js';
import { newUserId, type StoredCredential } from './webauthn.js';

export interface TotpState {
  secret: string;
  confirmed: boolean;
  lastCounter: number | null;
  recoveryCodes: string[];
  createdAt: string;
}

export interface Enrollment {
  codeHash: string;
  expiresAt: string;
  issuedAt: string;
  id: string;
}

export interface User {
  userId: string;
  username: string;
  displayName: string;
  enabled: boolean;
  createdAt: string;
  passwordHash: string | null;
  credentials: StoredCredential[];
  enrollment: Enrollment | null;
  totp: TotpState | null;
}

interface StoreFile { version: number; users: User[] }

const FILE = (): string => join(config.dataDir, 'users.json');

function readAll(): StoreFile {
  const file = FILE();
  if (!existsSync(file)) return { version: 1, users: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as StoreFile;
    if (!Array.isArray(parsed.users)) throw new Error('missing users array');
    return parsed;
  } catch (error) {
    throw new Error(`user store at ${file} is corrupt: ${(error as Error).message}`);
  }
}

function writeAll(data: StoreFile): void {
  ensureDataDir();
  const file = FILE();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file); // atómico: un crash a mitad no puede dejar el store partido
}

/**
 * Un cerrojo mantenido durante el ciclo leer-modificar-escribir, para que dos *procesos* no se
 * pisen el trabajo.
 *
 * Dentro del gateway no hay carrera que arreglar: todo aquí es síncrono. La CLI es otro proceso y
 * corre contra el mismo fichero mientras el gateway sirve — `jarvis-users disable braian` justo
 * cuando un login escribe un contador de firma. Una cuenta que el operador cree deshabilitada y
 * no lo está no es un fallo que este producto pueda permitirse.
 */
const LOCK = (): string => `${FILE()}.lock`;
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 5;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock<T>(fn: () => T): T {
  ensureDataDir();
  const lock = LOCK();
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      writeFileSync(lock, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let heldFor: number;
      try {
        heldFor = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue; // se liberó mientras lo mirábamos
      }
      if (heldFor > LOCK_STALE_MS) {
        rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`the user store is locked by another process; if none is running, remove ${lock}`);
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Códigos cortos para poder teclearlos y largos para resistir adivinanza (~62 bits). */
function generateEnrollmentCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin parecidos: I/1, O/0
  const bytes = randomBytes(12);
  let code = '';
  for (let i = 0; i < bytes.length; i += 1) {
    if (i > 0 && i % 4 === 0) code += '-';
    code += alphabet[bytes[i]! % alphabet.length];
  }
  return code;
}

export const users = {
  list(): User[] { return readAll().users; },

  findByUsername(username: string | undefined): User | null {
    if (!username) return null;
    const wanted = String(username).toLowerCase();
    return readAll().users.find((u) => u.username.toLowerCase() === wanted) ?? null;
  },

  findByUserId(userId: string | undefined): User | null {
    if (!userId) return null;
    return readAll().users.find((u) => u.userId === userId) ?? null;
  },

  findByCredentialId(credentialId: string | undefined): { user: User; credential: StoredCredential } | null {
    if (!credentialId) return null;
    for (const user of readAll().users) {
      const credential = user.credentials.find((c) => c.credentialId === credentialId);
      if (credential) return { user, credential };
    }
    return null;
  },

  create({ username, displayName }: { username: string; displayName?: string }): User {
    return withLock(() => {
      const data = readAll();
      if (data.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
        throw new Error(`user ${username} already exists`);
      }
      const user: User = {
        // Opaco y permanente: es lo que el autenticador guarda y devuelve como userHandle.
        userId: newUserId(),
        username,
        displayName: displayName || username,
        enabled: true,
        createdAt: new Date().toISOString(),
        passwordHash: null,
        credentials: [],
        enrollment: null,
        totp: null,
      };
      data.users.push(user);
      writeAll(data);
      return user;
    });
  },

  update(userId: string, mutate: (user: User) => void): User {
    return withLock(() => {
      const data = readAll();
      const user = data.users.find((u) => u.userId === userId);
      if (!user) throw new Error('user not found');
      mutate(user);
      writeAll(data);
      return user;
    });
  },

  remove(username: string): boolean {
    return withLock(() => {
      const data = readAll();
      const before = data.users.length;
      data.users = data.users.filter((u) => u.username.toLowerCase() !== username.toLowerCase());
      if (data.users.length === before) return false;
      writeAll(data);
      return true;
    });
  },

  issueEnrollmentCode(userId: string, ttlSeconds = config.enrollmentTtlSeconds): string {
    const code = generateEnrollmentCode();
    this.update(userId, (user) => {
      user.enrollment = {
        codeHash: sha256(code).toString('base64'),
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
        issuedAt: new Date().toISOString(),
        id: randomUUID(),
      };
    });
    return code;
  },

  /** Resuelve un código a su usuario, o null. Nunca revela qué parte falló. */
  consumableEnrollment(code: string | undefined): User | null {
    if (!code) return null;
    const hash = sha256(code).toString('base64');
    for (const user of readAll().users) {
      if (!user.enrollment) continue;
      if (!constantTimeEquals(user.enrollment.codeHash, hash)) continue;
      if (new Date(user.enrollment.expiresAt).getTime() < Date.now()) return null;
      return user;
    }
    return null;
  },

  clearEnrollment(userId: string): void {
    this.update(userId, (user) => { user.enrollment = null; });
  },

  addCredential(userId: string, credential: StoredCredential, name?: string): User {
    return this.update(userId, (user) => {
      user.credentials.push({
        ...credential,
        name: name || `passkey-${user.credentials.length + 1}`,
        lastUsedAt: null,
      });
    });
  },

  touchCredential(userId: string, credentialId: string, signCount: number): User {
    return this.update(userId, (user) => {
      const credential = user.credentials.find((c) => c.credentialId === credentialId);
      if (credential) {
        credential.signCount = signCount;
        credential.lastUsedAt = new Date().toISOString();
      }
    });
  },

  setTotp(userId: string, { secret, recoveryCodes }: { secret: string; recoveryCodes: string[] }): User {
    return this.update(userId, (user) => {
      user.totp = {
        secret,
        confirmed: false,
        lastCounter: null,
        // Los códigos de recuperación se guardan con hash y son de un solo uso: un store filtrado
        // no puede ser una vía de entrada.
        recoveryCodes: recoveryCodes.map((code) => sha256(code).toString('base64')),
        createdAt: new Date().toISOString(),
      };
    });
  },

  confirmTotp(userId: string, counter: number): User {
    return this.update(userId, (user) => {
      if (!user.totp) return;
      user.totp.confirmed = true;
      user.totp.lastCounter = counter;
    });
  },

  clearTotp(userId: string): User {
    return this.update(userId, (user) => { user.totp = null; });
  },

  useRecoveryCode(userId: string, code: string): boolean {
    let accepted = false;
    const hash = sha256(String(code).trim().toUpperCase()).toString('base64');
    this.update(userId, (user) => {
      if (!user.totp?.recoveryCodes) return;
      const index = user.totp.recoveryCodes.findIndex((stored) => constantTimeEquals(stored, hash));
      if (index === -1) return;
      user.totp.recoveryCodes.splice(index, 1);
      accepted = true;
    });
    return accepted;
  },

  revokeCredential(userId: string, credentialId: string): boolean {
    let removed = false;
    this.update(userId, (user) => {
      const before = user.credentials.length;
      user.credentials = user.credentials.filter((c) => c.credentialId !== credentialId);
      removed = user.credentials.length < before;
    });
    return removed;
  },
};

/** Sólo puede autenticarse quien tenga la cuenta habilitada y cada factor exigido ya configurado. */
export function canLogin(user: User | null, steps: readonly string[] = config.authPolicy): boolean {
  if (!user || !user.enabled) return false;
  if (steps.includes('passkey') && user.credentials.length === 0) return false;
  if (steps.includes('totp') && !user.totp?.confirmed) return false;
  if (steps.includes('password') && !user.passwordHash) return false;
  return true;
}

export function publicUser(user: User) {
  return {
    username: user.username,
    displayName: user.displayName,
    credentials: user.credentials.map((c) => ({
      id: c.credentialId, name: c.name ?? 'passkey', createdAt: c.createdAt,
      lastUsedAt: c.lastUsedAt ?? null, transports: c.transports, backedUp: c.backedUp,
    })),
    totp: user.totp
      ? { confirmed: user.totp.confirmed, recoveryCodesLeft: user.totp.recoveryCodes.length }
      : null,
  };
}

export const userStoreFile = FILE;
