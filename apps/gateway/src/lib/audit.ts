/**
 * Rastro de auditoría append-only. Sólo eventos relevantes para seguridad; un JSON por línea para
 * poder seguirlo, enviarlo o filtrarlo sin un parser.
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, ensureDataDir } from '../config.js';

let ensuredDir: string | null = null;

export function audit(event: string, details: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...details });
  try {
    if (ensuredDir !== config.dataDir) {
      ensureDataDir();
      ensuredDir = config.dataDir;
    }
    appendFileSync(join(config.dataDir, 'audit.log'), `${line}\n`, { mode: 0o600 });
  } catch (error) {
    // Un log de auditoría no escribible tiene que ser ruidoso, pero no puede tumbar el servicio.
    console.error('[audit] could not write entry:', (error as Error).message);
  }
  if (process.env['JARVIS_VERBOSE']) console.log('[audit]', line);
}
