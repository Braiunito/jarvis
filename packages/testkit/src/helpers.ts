import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Un directorio temporal que el test borra al terminar. */
export function tempDir(prefix = 'jarvis-test-'): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

/** La ruta del ssh falso, que es lo que convierte «probar durabilidad» en algo local. */
export const fakeSshPath = (): string =>
  resolve(fileURLToPath(new URL('../bin/fake-ssh.mjs', import.meta.url)));

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Espera a que una condición se cumpla, con un mensaje útil cuando no lo hace.
 *
 * Un `sleep` fijo o falla en una máquina lenta o pierde el tiempo en una rápida; esto hace ni una
 * cosa ni la otra.
 */
export async function waitFor<T>(
  probe: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  { timeoutMs = 15_000, intervalMs = 100, what = 'la condición' }: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  for (;;) {
    last = await probe();
    if (predicate(last)) return last;
    if (Date.now() > deadline) {
      throw new Error(`timeout esperando ${what}; último valor: ${JSON.stringify(last)?.slice(0, 400)}`);
    }
    await sleep(intervalMs);
  }
}
