/**
 * Los artifacts de una conversación: guardarlos, validarlos y servirlos.
 *
 * Un artifact es contenido con forma que el asistente decide enseñar, y aquí vive **el cuerpo**.
 * El puntero va en el mensaje (`ChatRef` con `kind: 'artifact'`) porque los últimos mensajes del
 * hilo son también el contexto que se le pasa al modelo en cada turno: si el cuerpo viajase ahí,
 * una tabla de doscientas filas se pagaría en tokens mientras dure la conversación.
 *
 * La validación es a mano y no por esquema compilado a propósito: lo que hace falta no es un
 * booleano, es **un mensaje que el modelo pueda usar para corregirse en la siguiente vuelta**.
 * «falta la columna `host` en la fila 3» le sirve; «no valida» le cuesta un turno entero.
 */
import type { Database as Db } from 'better-sqlite3';
import {
  ARTIFACT_KINDS, ARTIFACT_PRESENTATIONS,
  type ArtifactKind, type ArtifactPresentation, type ChatArtifact,
} from '@jarvis/contracts';
import type { Clock } from '../platform/clock.js';
import { newArtifactId } from '../platform/ids.js';

/** Lo que cabe en un artifact. Por encima se recorta y se dice que se recortó (ADR-007). */
export const MAX_ARTIFACT_BYTES = 256 * 1024;
/** Lo que cabe en una conversación entera, para que un hilo largo no engorde sin techo. */
export const MAX_CONVERSATION_ARTIFACT_BYTES = 2 * 1024 * 1024;
/**
 * Cuánto cuerpo `inline` viaja sin que nadie lo pida.
 *
 * Los `inline` son parte de la respuesta, así que tienen que llegar con ella —en la carga inicial
 * y en el frame del stream— o el turno que acabas de esperar treinta segundos pinta un hueco. Pero
 * eso los pone en el camino caliente, y por eso hay techo: pasado el presupuesto, el resto se pide
 * como los demás.
 */
export const INLINE_BUDGET_BYTES = 64 * 1024;
/** Cuántos puede dejar un turno. Tres cosas se miran; doce son un volcado con otro nombre. */
export const MAX_ARTIFACTS_PER_TURN = 3;

/** Lo que el preview enseña en el chip sin traerse el cuerpo. */
const PREVIEW_CHARS = 120;

export interface NewArtifact {
  kind: ArtifactKind;
  presentation: ArtifactPresentation;
  title: string;
  body: string;
  language?: string | null;
  caption?: string | null;
}

export interface ArtifactRejection {
  code: 'BAD_INPUT' | 'TOO_MANY';
  message: string;
  hint?: string;
}

interface ArtifactRow {
  id: string; conversation_id: string; message_id: string | null;
  kind: string; presentation: string; title: string;
  caption: string | null; language: string | null;
  body: string; bytes: number; truncated: number; created_at: string;
}

const toArtifact = (row: ArtifactRow): ChatArtifact => ({
  id: row.id,
  conversationId: row.conversation_id,
  messageId: row.message_id,
  kind: row.kind as ArtifactKind,
  presentation: row.presentation as ArtifactPresentation,
  title: row.title,
  caption: row.caption,
  language: row.language,
  body: row.body,
  bytes: row.bytes,
  truncated: row.truncated === 1,
  createdAt: row.created_at,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Lo justo para saber qué hay detrás del botón, sin traerse el cuerpo.
 *
 * En lo que se lee, la primera línea. En lo que tiene forma —una tabla, un gráfico, un JSON— la
 * primera línea no existe, y decir sólo el título deja un botón que pone «Resultado» sin que nadie
 * sepa si detrás hay tres filas o trescientas. Se dice **el tamaño en sus propias unidades**: filas
 * y columnas, porciones, claves. Los bytes no se los dice a nadie.
 */
export function previewOf(kind: ArtifactKind, body: string): string | null {
  if (kind === 'table' || kind === 'chart' || kind === 'json') return shapeOf(kind, body);
  const line = body.split('\n').map((part) => part.trim()).find((part) => part.length > 0);
  if (!line) return null;
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS)}…` : line;
}

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

function shapeOf(kind: ArtifactKind, body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (kind === 'table' && isRecord(parsed)) {
    const rows = Array.isArray(parsed['rows']) ? parsed['rows'].length : 0;
    const columns = Array.isArray(parsed['columns']) ? parsed['columns'].length : 0;
    return `${plural(rows, 'fila', 'filas')} · ${plural(columns, 'columna', 'columnas')}`;
  }
  if (kind === 'chart' && isRecord(parsed)) {
    const shape = String(parsed['shape'] ?? '');
    if (shape === 'donut' && Array.isArray(parsed['slices'])) {
      return plural(parsed['slices'].length, 'porción', 'porciones');
    }
    if (shape === 'bars' && Array.isArray(parsed['points'])) {
      return plural(parsed['points'].length, 'punto', 'puntos');
    }
    if (shape === 'meter' && typeof parsed['value'] === 'number') {
      return `${parsed['value']} de ${String(parsed['max'] ?? '')}`;
    }
    return null;
  }
  if (Array.isArray(parsed)) return plural(parsed.length, 'elemento', 'elementos');
  if (isRecord(parsed)) return plural(Object.keys(parsed).length, 'clave', 'claves');
  return null;
}

/**
 * Comprueba que el cuerpo es lo que dice ser.
 *
 * `table` y `chart` llevan JSON con forma fija, y aquí es donde se le dice al modelo exactamente
 * qué falta. El resto es texto y no hay nada que comprobar: un markdown mal escrito se ve raro,
 * no rompe nada, y devolvérselo para que lo reescriba cuesta una vuelta contra el modelo por una
 * coma.
 */
export function validateBody(kind: ArtifactKind, body: string): ArtifactRejection | null {
  if (kind !== 'table' && kind !== 'chart') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      code: 'BAD_INPUT',
      message: `el cuerpo de un ${kind} tiene que ser JSON y no se pudo leer`,
      hint: kind === 'table'
        ? '{"columns":[{"key":"host","label":"Máquina"}],"rows":[{"host":"zeus"}]}'
        : '{"shape":"meter","label":"Disco","value":60,"max":100}',
    };
  }

  if (kind === 'table') return validateTable(parsed);
  return validateChart(parsed);
}

function validateTable(parsed: unknown): ArtifactRejection | null {
  if (!isRecord(parsed) || !Array.isArray(parsed['columns']) || !Array.isArray(parsed['rows'])) {
    return {
      code: 'BAD_INPUT',
      message: 'una tabla necesita `columns` y `rows`, las dos listas',
      hint: '{"columns":[{"key":"host","label":"Máquina"}],"rows":[{"host":"zeus"}]}',
    };
  }
  const columns = parsed['columns'] as unknown[];
  if (columns.length === 0) {
    return { code: 'BAD_INPUT', message: 'una tabla sin columnas no se puede pintar' };
  }
  const keys: string[] = [];
  for (const column of columns) {
    if (!isRecord(column) || typeof column['key'] !== 'string' || !column['key']) {
      return {
        code: 'BAD_INPUT',
        message: 'cada columna necesita `key` y `label`',
        hint: '{"key":"host","label":"Máquina"}',
      };
    }
    keys.push(column['key']);
  }
  const rows = parsed['rows'] as unknown[];
  for (const [index, row] of rows.entries()) {
    if (!isRecord(row)) {
      return { code: 'BAD_INPUT', message: `la fila ${index + 1} no es un objeto` };
    }
    // Se avisa de la columna que falta, no de que «no valida»: es lo que se puede arreglar.
    const missing = keys.find((key) => !(key in row));
    if (missing) {
      return {
        code: 'BAD_INPUT',
        message: `falta la columna \`${missing}\` en la fila ${index + 1}`,
        hint: `las columnas declaradas son ${keys.join(', ')}`,
      };
    }
  }
  return null;
}

const CHART_SHAPES = ['bars', 'donut', 'meter'] as const;

function validateChart(parsed: unknown): ArtifactRejection | null {
  const shapes = CHART_SHAPES.join(', ');
  if (!isRecord(parsed) || typeof parsed['shape'] !== 'string') {
    return { code: 'BAD_INPUT', message: 'un gráfico necesita `shape`', hint: `las formas son ${shapes}` };
  }
  const shape = parsed['shape'];
  if (shape === 'bars') {
    const points = parsed['points'];
    if (!Array.isArray(points) || points.length === 0) {
      return { code: 'BAD_INPUT', message: 'un gráfico de barras necesita `points` con al menos uno',
        hint: '{"shape":"bars","label":"Trabajos por hora","points":[{"at":"10:00","value":3}]}' };
    }
    const bad = points.findIndex((point) => !isRecord(point) || typeof point['value'] !== 'number');
    if (bad >= 0) {
      return { code: 'BAD_INPUT', message: `el punto ${bad + 1} necesita \`at\` y \`value\` numérico` };
    }
    return null;
  }
  if (shape === 'donut') {
    const slices = parsed['slices'];
    if (!Array.isArray(slices) || slices.length === 0) {
      return { code: 'BAD_INPUT', message: 'un anillo necesita `slices` con al menos una',
        hint: '{"shape":"donut","caption":"Trabajos","total":9,"slices":[{"key":"ok","label":"Bien","value":7}]}' };
    }
    const bad = slices.findIndex((slice) => !isRecord(slice) || typeof slice['value'] !== 'number');
    if (bad >= 0) {
      return { code: 'BAD_INPUT', message: `la porción ${bad + 1} necesita \`key\`, \`label\` y \`value\` numérico` };
    }
    return null;
  }
  if (shape === 'meter') {
    if (typeof parsed['value'] !== 'number' || typeof parsed['max'] !== 'number') {
      return { code: 'BAD_INPUT', message: 'un medidor necesita `value` y `max` numéricos',
        hint: '{"shape":"meter","label":"Disco","value":60,"max":100}' };
    }
    return null;
  }
  return {
    code: 'BAD_INPUT',
    message: `no sé dibujar un gráfico \`${shape}\``,
    // Se dicen las tres que existen en vez de prometer un gráfico genérico que aquí no hay.
    hint: `las formas que sé pintar son ${shapes}`,
  };
}

/**
 * `html` nunca va dentro de la burbuja.
 *
 * Un documento que ejecuta JavaScript no puede aparecer solo mientras lees: se mira a propósito,
 * detrás de un clic y con su código fuente al lado. Ver antes de renderizar.
 */
export function presentationFor(kind: ArtifactKind, asked: ArtifactPresentation): ArtifactPresentation {
  if (kind === 'html' && asked === 'inline') return 'panel';
  return asked;
}

export class ArtifactRepository {
  readonly #db: Db;
  readonly #clock: Clock;

  constructor(deps: { db: Db; clock: Clock }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
  }

  /** Lo que ya ocupan los artifacts de una conversación. */
  bytesIn(conversationId: string): number {
    const row = this.#db
      .prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM chat_artifacts WHERE conversation_id = ?')
      .get(conversationId) as { total: number };
    return row.total;
  }

  create(conversationId: string, input: NewArtifact): ChatArtifact | ArtifactRejection {
    if (!ARTIFACT_KINDS.includes(input.kind)) {
      return { code: 'BAD_INPUT', message: `no sé enseñar un \`${input.kind}\``,
        hint: `los tipos son ${ARTIFACT_KINDS.join(', ')}` };
    }
    if (!ARTIFACT_PRESENTATIONS.includes(input.presentation)) {
      return { code: 'BAD_INPUT', message: `\`${input.presentation}\` no es una forma de presentarlo`,
        hint: `las formas son ${ARTIFACT_PRESENTATIONS.join(', ')}` };
    }
    const title = input.title.trim();
    if (!title) return { code: 'BAD_INPUT', message: 'falta el título', hint: 'cinco palabras que digan qué es' };

    const rejection = validateBody(input.kind, input.body);
    if (rejection) return rejection;

    if (this.bytesIn(conversationId) >= MAX_CONVERSATION_ARTIFACT_BYTES) {
      return { code: 'TOO_MANY', message: 'esta conversación ya no admite más contenido adjunto',
        hint: 'resume lo que has encontrado en el texto de tu respuesta' };
    }

    const raw = Buffer.from(input.body, 'utf8');
    const truncated = raw.byteLength > MAX_ARTIFACT_BYTES;
    // Se recorta por bytes y se reconstruye el texto: cortar por caracteres deja el techo en algo
    // que no es el techo cuando el contenido lleva acentos, que aquí es siempre.
    const body = truncated ? raw.subarray(0, MAX_ARTIFACT_BYTES).toString('utf8') : input.body;

    const artifact: ChatArtifact = {
      id: newArtifactId(),
      conversationId,
      messageId: null,
      kind: input.kind,
      presentation: presentationFor(input.kind, input.presentation),
      title,
      caption: input.caption?.trim() || null,
      language: input.kind === 'code' ? (input.language?.trim() || null) : null,
      body,
      bytes: Buffer.byteLength(body, 'utf8'),
      truncated,
      createdAt: this.#clock.nowIso(),
    };

    this.#db.prepare(`
      INSERT INTO chat_artifacts
        (id, conversation_id, message_id, kind, presentation, title, caption, language,
         body, bytes, truncated, created_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      artifact.id, conversationId, artifact.kind, artifact.presentation, artifact.title,
      artifact.caption, artifact.language, artifact.body, artifact.bytes,
      artifact.truncated ? 1 : 0, artifact.createdAt,
    );
    return artifact;
  }

  /** Ata al mensaje del turno lo que el modelo dejó preparado mientras razonaba. */
  attach(artifactIds: readonly string[], messageId: string): void {
    if (artifactIds.length === 0) return;
    const statement = this.#db.prepare('UPDATE chat_artifacts SET message_id = ? WHERE id = ? AND message_id IS NULL');
    const all = this.#db.transaction((ids: readonly string[]) => {
      for (const id of ids) statement.run(messageId, id);
    });
    all(artifactIds);
  }

  get(conversationId: string, artifactId: string): ChatArtifact | null {
    const row = this.#db
      .prepare('SELECT * FROM chat_artifacts WHERE id = ? AND conversation_id = ?')
      .get(artifactId, conversationId) as ArtifactRow | undefined;
    return row ? toArtifact(row) : null;
  }

  /**
   * Los cuerpos que viajan con la conversación: los `inline` ya atados, bajo presupuesto.
   *
   * Van en orden de escritura y se cortan al llegar al techo, así que lo que se pierde es lo más
   * viejo del hilo —que ya se leyó— y no lo que acaba de llegar.
   */
  inlineFor(conversationId: string, budget = INLINE_BUDGET_BYTES): ChatArtifact[] {
    const rows = this.#db.prepare(`
      SELECT * FROM chat_artifacts
      WHERE conversation_id = ? AND message_id IS NOT NULL AND presentation = 'inline'
      ORDER BY created_at DESC, id DESC
    `).all(conversationId) as ArtifactRow[];

    const picked: ChatArtifact[] = [];
    let spent = 0;
    for (const row of rows) {
      if (spent + row.bytes > budget) break;
      spent += row.bytes;
      picked.push(toArtifact(row));
    }
    return picked.reverse();
  }

  /** Los `inline` de un mensaje concreto, para que el frame del stream llegue completo. */
  inlineOf(messageId: string, budget = INLINE_BUDGET_BYTES): ChatArtifact[] {
    const rows = this.#db.prepare(`
      SELECT * FROM chat_artifacts
      WHERE message_id = ? AND presentation = 'inline'
      ORDER BY created_at ASC, id ASC
    `).all(messageId) as ArtifactRow[];

    const picked: ChatArtifact[] = [];
    let spent = 0;
    for (const row of rows) {
      if (spent + row.bytes > budget) break;
      spent += row.bytes;
      picked.push(toArtifact(row));
    }
    return picked;
  }
}
