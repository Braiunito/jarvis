/**
 * Retención de eventos: qué queda de un trabajo cuando deja de ser reciente (ADR-007).
 *
 * El event log es la evidencia de lo que hizo un agente, y por eso no se borra por edad sin más.
 * Pero lo que pesa en él no es la historia: son las salidas de herramienta y los volcados crudos,
 * que se cuentan en megabytes y dejan de mirarse a los pocos días. La política del ADR-007
 * distingue las dos cosas y esto la aplica:
 *
 *   · trabajo activo          → intacto, nunca se toca lo que todavía está pasando
 *   · terminado < 7 días      → intacto
 *   · entre 7 y 30 días       → el payload pesado se sustituye por su huella y un resumen
 *   · más de 30 días          → sólo sobreviven los eventos estructurales
 *
 * Dos reglas gobiernan el fichero. La primera: **`seq` es identidad pública y durable**, así que
 * aquí no se renumera nada ni se reutiliza un hueco; compactar reescribe el payload de una fila y
 * barrer borra filas enteras, pero el número que tenía un evento sigue siendo suyo para siempre.
 * La segunda: **nada se recorta en silencio**, así que un payload compactado dice que lo está,
 * con qué huella y cuántos bytes ocupaba.
 */
import { createHash } from 'node:crypto';
import type { Database as Db } from 'better-sqlite3';
import { TERMINAL_RUN_STATUSES, type RunEventType } from '@jarvis/contracts';
import type { Clock } from '../platform/clock.js';

/**
 * Lo que cuenta qué pasó: en qué estado quedó, dónde se ejecutó, cómo terminó.
 *
 * Esto sobrevive a cualquier edad. Es barato —son unas pocas filas por trabajo— y es lo único que
 * hace que un run de hace medio año siga siendo legible como historia en vez de un identificador
 * huérfano.
 */
const STRUCTURAL: ReadonlySet<string> = new Set<RunEventType>([
  'run.status',
  'run.target',
  'run.cancel_requested',
  'agent.started',
  'agent.result',
  'agent.error',
]);

/**
 * Lo que pesa: la salida de las herramientas, el volcado crudo del agente y el ruido del runner.
 *
 * Son los que el ADR llama «payload pesado (tool/output)», y los únicos que se compactan en la
 * ventana de 7 a 30 días. El texto y el razonamiento se dejan enteros mientras el trabajo sigue
 * siendo reciente: son lo que alguien vuelve a leer, no lo que llena el disco.
 */
const HEAVY: ReadonlySet<string> = new Set<RunEventType>([
  'agent.tool',
  'agent.raw',
  'runner.stderr',
]);

export interface RetentionPolicy {
  /** Días desde que terminó un trabajo hasta que su payload pesado se compacta. */
  compactAfterDays: number;
  /** Días hasta que sólo se conservan los eventos estructurales. */
  dropAfterDays: number;
  /** Cuánto texto se conserva como resumen de un payload compactado. */
  summaryChars: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  compactAfterDays: 7,
  dropAfterDays: 30,
  summaryChars: 200,
};

/** Lo que queda de un payload pesado cuando se compacta. */
export interface CompactedPayload {
  compacted: true;
  digest: string;
  originalBytes: number;
  summary: string | null;
}

export interface RetentionReport {
  at: string;
  compactedEvents: number;
  droppedEvents: number;
  /** Bytes de payload que deja de ocupar la base. Es una estimación honesta, no una promesa. */
  bytesFreed: number;
  runsTouched: number;
}

const clip = (text: string, max: number): string =>
  (text.length <= max ? text : `${text.slice(0, max)}…`);

/**
 * Una línea que diga de qué iba el payload que ya no está.
 *
 * Se busca por orden lo que un humano reconocería —el nombre de la herramienta, la nota que dejó
 * el adaptador, el texto— y si no hay nada de eso se dice qué campos traía. Enseñar «6 campos:
 * name, input, …» no es gran cosa, pero es mucho más que un hueco sin explicación.
 */
export function summarize(payload: unknown, maxChars: number): string | null {
  if (payload === null || payload === undefined) return null;
  if (typeof payload === 'string') return payload.trim() ? clip(payload, maxChars) : null;
  if (typeof payload !== 'object') return clip(String(payload), maxChars);

  const record = payload as Record<string, unknown>;
  for (const key of ['name', 'note', 'text', 'message', 'subtype']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return clip(value.trim(), maxChars);
  }
  const keys = Object.keys(record);
  if (!keys.length) return null;
  return clip(`${keys.length} campos: ${keys.slice(0, 8).join(', ')}`, maxChars);
}

/** El payload que sustituye al original: su huella, su tamaño y de qué iba. */
export function compactPayload(json: string, summaryChars: number): CompactedPayload {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(json);
  } catch {
    // Un payload que no es JSON válido no debería existir, pero si existe se compacta igual: la
    // huella y el tamaño siguen valiendo, y perder la fila por un dato malo sería peor.
    parsed = null;
  }
  return {
    compacted: true,
    digest: `sha256:${createHash('sha256').update(json, 'utf8').digest('hex')}`,
    originalBytes: Buffer.byteLength(json, 'utf8'),
    summary: summarize(parsed, summaryChars),
  };
}

const placeholders = (values: readonly unknown[]): string => values.map(() => '?').join(', ');

const daysBefore = (nowMs: number, days: number): string =>
  new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();

/**
 * Aplica la política una vez y cuenta lo que hizo.
 *
 * Va en una transacción por dos motivos: para que nadie lea media compactación, y porque escribir
 * fila a fila en SQLite con `synchronous = FULL` fuera de transacción es órdenes de magnitud más
 * lento, y esto puede tocar miles de filas de golpe.
 *
 * `COALESCE(finished_at, created_at)` es a propósito: un run terminado siempre debería tener
 * `finished_at`, pero uno que se quedó a medias por un corte del core puede no tenerlo, y la edad
 * de algo que no se sabe cuándo acabó se cuenta desde que empezó. Sin ese respaldo, esas filas se
 * quedarían para siempre.
 */
export function applyRetention({ db, clock, policy = DEFAULT_RETENTION }: {
  db: Db;
  clock: Clock;
  policy?: RetentionPolicy;
}): RetentionReport {
  const at = clock.nowIso();
  const nowMs = clock.nowMs();
  const compactBefore = daysBefore(nowMs, policy.compactAfterDays);
  const dropBefore = daysBefore(nowMs, policy.dropAfterDays);
  const terminal = [...TERMINAL_RUN_STATUSES];
  const heavy = [...HEAVY];
  const structural = [...STRUCTURAL];
  const touched = new Set<string>();

  /**
   * Se pregunta primero a `runs` y sólo después por los eventos de cada trabajo.
   *
   * `runs` tiene una fila por trabajo; `run_events`, cientos por trabajo. Bajando en ese orden,
   * cada consulta de eventos entra por la clave primaria `(run_id, seq)`. Al revés —recorrer los
   * eventos y mirar de quién es cada uno— se lee entera la tabla grande cada seis horas para
   * descubrir que casi nada ha caducado, que es justo el trabajo que esta limpieza existe para
   * ahorrar.
   */
  const candidates = db.prepare(
    `SELECT id AS runId, COALESCE(finished_at, created_at) AS endedAt
       FROM runs
      WHERE status IN (${placeholders(terminal)})
        AND COALESCE(finished_at, created_at) <= ?`,
  ).all(...terminal, compactBefore) as Array<{ runId: string; endedAt: string }>;

  const empty: RetentionReport = { at, compactedEvents: 0, droppedEvents: 0, bytesFreed: 0, runsTouched: 0 };
  if (!candidates.length) return empty;

  return db.transaction((): RetentionReport => {
    const heavyOf = db.prepare(
      `SELECT seq AS seq, payload_json AS json, payload_bytes AS bytes
         FROM run_events
        WHERE run_id = ? AND compacted = 0 AND type IN (${placeholders(heavy)})`,
    );
    const update = db.prepare(
      'UPDATE run_events SET payload_json = ?, payload_bytes = ?, compacted = 1 WHERE run_id = ? AND seq = ?',
    );
    const weighOf = db.prepare(
      `SELECT COUNT(*) AS rows, COALESCE(SUM(payload_bytes), 0) AS bytes
         FROM run_events
        WHERE run_id = ? AND type NOT IN (${placeholders(structural)})`,
    );
    const purge = db.prepare(
      `DELETE FROM run_events WHERE run_id = ? AND type NOT IN (${placeholders(structural)})`,
    );

    let compactedEvents = 0;
    let droppedEvents = 0;
    let bytesFreed = 0;

    for (const { runId, endedAt } of candidates) {
      /**
       * Pasados los 30 días sólo queda el esqueleto.
       *
       * Se pesa antes de borrar porque después ya no hay a quién preguntarle cuánto ocupaba, y un
       * informe que no sabe cuánto liberó no sirve para decidir si esto hace falta.
       */
      if (endedAt <= dropBefore) {
        const weight = weighOf.get(runId, ...structural) as { rows: number; bytes: number };
        if (!weight.rows) continue;
        purge.run(runId, ...structural);
        droppedEvents += weight.rows;
        bytesFreed += weight.bytes;
        touched.add(runId);
        continue;
      }

      // Entre 7 y 30 días: se va el peso, no la historia.
      const rows = heavyOf.all(runId, ...heavy) as Array<{ seq: number; json: string; bytes: number }>;
      for (const row of rows) {
        const replacement = JSON.stringify(compactPayload(row.json, policy.summaryChars));
        const bytes = Buffer.byteLength(replacement, 'utf8');
        // Un payload ya pequeño puede crecer al compactarlo —sólo la huella ocupa 71 caracteres—,
        // y reescribir una fila para dejarla más grande es trabajo a cambio de nada.
        if (bytes >= row.bytes) continue;
        update.run(replacement, bytes, runId, row.seq);
        compactedEvents += 1;
        bytesFreed += row.bytes - bytes;
        touched.add(runId);
      }
    }

    return { at, compactedEvents, droppedEvents, bytesFreed, runsTouched: touched.size };
  })();
}

export interface RetentionSupervisorDeps {
  db: Db;
  clock: Clock;
  intervalMs: number;
  policy?: RetentionPolicy;
  onError?: (error: Error) => void;
}

/**
 * El que se acuerda de aplicarla.
 *
 * Mismo patrón que el barrido de spools y por el mismo motivo: una pasada al arrancar —si no, un
 * core recién levantado pasa horas diciendo «sin datos», que es indistinguible de «esto está
 * roto»— y luego una cada intervalo. El temporizador va con `unref` para que no sostenga vivo al
 * proceso, y los errores no se propagan: que la limpieza falle no puede tumbar el core.
 *
 * A diferencia del barrido de spools, esto no depende de que haya hosts alcanzables: la base es
 * local y se limpia aunque la flota entera esté apagada.
 */
export class RetentionSupervisor {
  readonly #deps: RetentionSupervisorDeps;
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;

  /** Se llama cuando una pasada termina, para que Salud pueda decir cuándo fue. */
  onSweep: ((at: string, report: RetentionReport) => void) | null = null;

  constructor(deps: RetentionSupervisorDeps) {
    this.#deps = deps;
  }

  start(): void {
    this.#stopped = false;
    this.tick();
    this.#schedule();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.tick();
      this.#schedule();
    }, this.#deps.intervalMs);
    this.#timer.unref?.();
  }

  tick(): RetentionReport | null {
    const { db, clock, policy, onError } = this.#deps;
    try {
      const report = applyRetention({ db, clock, ...(policy ? { policy } : {}) });
      this.onSweep?.(report.at, report);
      return report;
    } catch (error) {
      onError?.(error as Error);
      return null;
    }
  }
}
