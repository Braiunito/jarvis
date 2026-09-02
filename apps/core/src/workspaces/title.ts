/**
 * Poner nombre a un workspace.
 *
 * Un identificador de sesión no dice nada, y los que ponen las CLIs dicen menos todavía: Claude
 * nombra sus sesiones `Claude a758cca7` y Codex arrastra su preámbulo entero
 * —`<environment_context><cwd>/home/zeus</cwd>…`— como si fuera un título. Ninguno de los dos sirve
 * para reconocer un trabajo en una lista, que es para lo único que existe un título.
 *
 * Cuatro reglas gobiernan esto, y vienen de haberlo hecho mal antes:
 *
 *   1. **El título que escribe una persona gana siempre.** No es un valor más reciente: es una
 *      decisión, y el producto no tiene por qué revisarla porque un modelo tenga otra idea.
 *   2. **Sólo se renombra lo que no sirve.** Un título bueno —lo escriba quien lo escriba— se
 *      queda. Lo que se sustituye es el hash, el preámbulo y el vacío.
 *   3. **Frescura.** Un título recién puesto no se vuelve a generar: entrar dos veces seguidas en
 *      un workspace no puede costar dos llamadas al modelo ni cambiar el nombre a mitad de mirar.
 *   4. **Sin modelo, o con el modelo agotado, hay nombre igual.** Se cae a las primeras palabras
 *      del mensaje de la persona, que es peor título pero nunca es un hash.
 */
import type { Database as Db } from 'better-sqlite3';
import type { Clock } from '../platform/clock.js';
import { isSubstantive } from '../sessions/message-kind.js';

export interface TitleModel {
  /** Devuelve un título corto, o null si no puede. Nunca lanza hacia arriba. */
  summarize(input: { prompt: string; result: string | null }): Promise<string | null>;
}

/**
 * Modelos que hay que mandar callar.
 *
 * Qwen contesta a una petición de título con un monólogo `<think>` y se queda sin tokens antes de
 * escribir el título: `finish_reason: "length"` y nada aprovechable. Con `reasoning_effort: "none"`
 * responde el título y para. Grok no lo necesita, y mandárselo a un modelo que no lo entiende es
 * pedir un 400, así que se envía sólo a quien le hace falta.
 */
export const QUIET_REASONING = /^(qwen|deepseek-r1|.*-thinking)/i;

/** Cliente de un modelo pequeño compatible con la API de OpenAI, que es lo que hay a mano. */
export class OpenAiCompatibleTitleModel implements TitleModel {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #model: string;

  constructor({ apiKey, baseUrl, model }: { apiKey: string; baseUrl: string; model: string }) {
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#model = model;
  }

  async summarize({ prompt, result }: { prompt: string; result: string | null }): Promise<string | null> {
    const controller = new AbortController();
    /*
     * Quince segundos, no ocho.
     *
     * Medido contra el modelo real (`qwen/qwen3.6-27b` en Groq): con `reasoning_effort: "none"`
     * contesta en 6,3 s, y sin él se va a 14,6 s pensando y devuelve `finish_reason: "length"` sin
     * título. Con el corte en 8 s, un día lento abortaba una llamada que iba a contestar bien, y el
     * workspace se quedaba con el nombre del heurístico sin que nada lo explicara. Nadie espera a
     * esto: corre en segundo plano.
     */
    const timer = setTimeout(() => controller.abort(), 15_000);
    const family = this.#model.split('/').pop() ?? this.#model;
    try {
      const response = await fetch(`${this.#baseUrl}/v1/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#apiKey}` },
        body: JSON.stringify({
          model: this.#model,
          max_tokens: 40,
          temperature: 0.2,
          ...(QUIET_REASONING.test(family) ? { reasoning_effort: 'none' } : {}),
          messages: [
            {
              role: 'system',
              content: 'Nombra en español, con 3 a 6 palabras en minúscula, sin comillas ni punto '
                + 'final, el asunto del que trata esta sesión de trabajo. Resume de qué va el hilo '
                + 'entero: no copies una frase suelta ni el último comentario. Describe el asunto, '
                + 'no la acción de pedirlo. Ignora los preámbulos de la herramienta —bloques '
                + '<environment_context>, comandos como /model o /clear, rutas y fechas— y nombra '
                + 'el problema del que se habla.',
            },
            { role: 'user', content: `Petición: ${prompt.slice(0, 800)}\n\nResultado: ${(result ?? '').slice(0, 800)}` },
          ],
        }),
      });
      if (!response.ok) return null;
      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const text = body.choices?.[0]?.message?.content?.trim();
      if (!text) return null;
      const cleaned = cleanTitle(stripThinking(text));
      // Un modelo que devuelve su monólogo, una disculpa o un título tan malo como el que había no
      // vale como respuesta: mejor el heurístico local que un nombre peor.
      return cleaned && !looksAutomatic(cleaned) ? cleaned : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Un modelo que piensa en voz alta deja el razonamiento delante del título. */
function stripThinking(text: string): string {
  const withoutBlocks = text.replace(/<think>[\s\S]*?<\/think>/gi, ' ').replace(/<think>[\s\S]*$/i, ' ');
  const lines = withoutBlocks.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.at(-1) ?? withoutBlocks;
}

/**
 * Un título que no sirve para reconocer nada.
 *
 * Se mira lo que hay escrito, no de dónde vino: da igual que lo pusiera el índice, una CLI o una
 * versión anterior de esto. Los casos son concretos y salen de mirar sesiones reales.
 */
export function looksAutomatic(title: string | null | undefined, sessionId?: string | null): boolean {
  const text = (title ?? '').trim();
  if (!text) return true;

  // Demasiado largo para un título: es un mensaje entero pegado en el sitio equivocado.
  if (text.length > 120) return true;

  // El identificador de la sesión, tal cual o con el nombre del agente delante.
  if (sessionId && sessionId.length >= 6 && text.toLowerCase().includes(sessionId.toLowerCase())) return true;
  if (/^(claude|codex|opencode|session|sesión|chat|conversation)[\s\-_:]*[0-9a-f-]{6,}$/i.test(text)) return true;

  // Un hash o un UUID a secas.
  if (/^[0-9a-f]{8,}$/i.test(text)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) return true;

  // El preámbulo que Codex arrastra, o cualquier cosa que empiece por una etiqueta o por JSON.
  if (/^[<{[]/.test(text)) return true;
  if (/<\/?[a-z_]+>/i.test(text)) return true;

  // Una ruta, un comando, o algo sin una sola letra.
  if (/^[~/.]/.test(text)) return true;
  if (!/\p{L}/u.test(text)) return true;

  // Los nombres de relleno que ponen las herramientas cuando no saben qué poner.
  if (/^(new (session|chat)|untitled|sin título|sin titulo|nueva sesión|nueva sesion|trabajo sin título)$/i.test(text)) {
    return true;
  }

  // Mayoría de símbolos: identificadores, rutas con guiones, volcados.
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  if (letters / text.length < 0.5) return true;

  return false;
}

/**
 * Sin modelo, el título sale del propio mensaje: peor nombre, pero nombre al fin y al cabo.
 *
 * Lo que se manda al agente puede llevar delante el preámbulo de estrategia, el bloque de
 * adjuntos o el `<environment_context>` de la CLI. Lo que pidió la persona es lo último que queda
 * tras quitar todo eso: un workspace llamado «You are running on the bastion» no le sirve a nadie.
 */
export function titleFromPrompt(prompt: string): string {
  const withoutPreamble = prompt
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, ' ')
    // Los comandos de la CLI se quitan enteros, con su contenido: dejar sólo las etiquetas fuera
    // producía nombres como «/model model», que es lo que se veía en la lista.
    .replace(/<command-(name|message|args)>[\s\S]*?<\/command-\1>/gi, ' ')
    .replace(/<local-command-[a-z]+>[\s\S]*?<\/local-command-[a-z]+>/gi, ' ')
    .replace(/<[^>]{1,120}>/g, ' ');
  const blocks = withoutPreamble.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  const last = blocks.at(-1) ?? withoutPreamble;
  const cleaned = last
    .replace(/\[jarvis[^\]]*\][^\n]*/gi, ' ')
    .replace(/@@\w+(?::\d+)?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = cleaned.split(' ').filter(Boolean).slice(0, 7).join(' ');
  return cleanTitle(words || 'trabajo sin título');
}

function cleanTitle(text: string): string {
  return text
    .replace(/^["'«»\s]+|["'«».\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

/**
 * El presupuesto de llamadas al modelo.
 *
 * Los modelos que se usan aquí —Grok y Qwen en su capa gratuita— tienen límites por minuto que se
 * agotan con facilidad si cada visita a un workspace dispara una llamada. Este cubo no imita al
 * del proveedor: existe para que no lleguemos a verlo. Sin ficha se nombra con el heurístico
 * local y no se pide nada.
 */
class RateLimit {
  readonly #capacity: number;
  #stamps: number[] = [];

  constructor({ perMinute }: { perMinute: number }) {
    this.#capacity = Math.max(1, perMinute);
  }

  take(now: number): boolean {
    this.#stamps = this.#stamps.filter((at) => now - at < 60_000);
    if (this.#stamps.length >= this.#capacity) return false;
    this.#stamps.push(now);
    return true;
  }
}

export interface TitleServiceDeps {
  db: Db;
  clock: Clock;
  model: TitleModel | null;
  /** Llamadas al modelo por minuto en todo el proceso. */
  perMinute?: number;
  /** Cuánto tiempo se respeta un título recién puesto. */
  freshnessMs?: number;
}

interface TitleRow {
  title: string | null;
  title_source: string;
  titled_at: string | null;
  session_id: string;
}

export class TitleService {
  readonly #deps: TitleServiceDeps;
  readonly #limit: RateLimit;
  readonly #freshnessMs: number;
  /** Un workspace no se nombra dos veces a la vez, aunque se pida dos veces a la vez. */
  readonly #inFlight = new Set<string>();

  constructor(deps: TitleServiceDeps) {
    this.#deps = deps;
    this.#limit = new RateLimit({ perMinute: deps.perMinute ?? 8 });
    this.#freshnessMs = deps.freshnessMs ?? 60_000;
  }

  get hasModel(): boolean { return this.#deps.model !== null; }

  /** Lo que escribe una persona es definitivo. */
  setByUser(workspaceId: string, title: string): void {
    const at = this.#deps.clock.nowIso();
    this.#deps.db.prepare(
      "UPDATE workspaces SET title = ?, title_source = 'user', titled_at = ?, updated_at = ? WHERE id = ?",
    ).run(cleanTitle(title), at, at, workspaceId);
  }

  /**
   * ¿Merece la pena nombrar este workspace ahora?
   *
   * Se responde sin llamar a nadie: es lo que decide la interfaz al pintar y lo que evita una
   * llamada por visita.
   */
  needsTitle(workspaceId: string): boolean {
    const row = this.#read(workspaceId);
    if (!row) return false;
    if (row.title_source === 'user') return false;
    if (row.titled_at && this.#deps.clock.nowMs() - Date.parse(row.titled_at) < this.#freshnessMs) return false;
    return looksAutomatic(row.title, row.session_id);
  }

  /**
   * Nombrar al entrar en el workspace.
   *
   * Es el momento con más información y el que la persona está mirando: si el nombre es un hash,
   * se sustituye antes de que llegue a la lista. Devuelve el título nuevo, o null si no tocaba.
   */
  async nameOnOpen(
    workspaceId: string,
    material: { userMessages: string[]; lastResult?: string | null },
  ): Promise<string | null> {
    if (!this.needsTitle(workspaceId)) return null;
    if (this.#inFlight.has(workspaceId)) return null;
    this.#inFlight.add(workspaceId);
    try {
      // El primero dice de qué iba esto; el último, en qué anda ahora. Los dos juntos nombran
      // mejor que cualquiera por separado, y es lo que una persona recordaría del hilo.
      // Nada que venga de la CLI en vez de una persona: un `/model` no dice de qué va la sesión.
      const useful = material.userMessages
        .map((message) => message.trim())
        .filter((message) => message && isSubstantive(message));
      const first = useful[0] ?? '';
      const last = useful.at(-1) ?? '';
      const prompt = first === last ? first : `${first}\n\n${last}`;
      if (!prompt.trim()) return null;

      const generated = this.#deps.model && this.#limit.take(this.#deps.clock.nowMs())
        ? await this.#deps.model.summarize({ prompt, result: material.lastResult ?? null })
        : null;
      return this.#write(workspaceId, generated ?? titleFromPrompt(first || last));
    } finally {
      this.#inFlight.delete(workspaceId);
    }
  }

  /**
   * Nombra el workspace a partir de un run que acaba de terminar.
   *
   * Sigue existiendo porque un run terminado trae algo que el transcript todavía no tiene: lo que
   * salió. No pisa un título que ya sirve.
   */
  async nameFromRun(workspaceId: string, run: { prompt: string; resultSummary: string | null }): Promise<string | null> {
    if (!this.needsTitle(workspaceId)) return null;
    if (this.#inFlight.has(workspaceId)) return null;
    this.#inFlight.add(workspaceId);
    try {
      const generated = this.#deps.model && this.#limit.take(this.#deps.clock.nowMs())
        ? await this.#deps.model.summarize({ prompt: run.prompt, result: run.resultSummary })
        : null;
      return this.#write(workspaceId, generated ?? titleFromPrompt(run.prompt));
    } finally {
      this.#inFlight.delete(workspaceId);
    }
  }

  #read(workspaceId: string): TitleRow | undefined {
    return this.#deps.db.prepare('SELECT title, title_source, titled_at, session_id FROM workspaces WHERE id = ?')
      .get(workspaceId) as TitleRow | undefined;
  }

  /**
   * Escribe el nombre, salvo que mientras tanto lo haya escrito una persona.
   *
   * La condición va en el `WHERE` y no en un `if` de más arriba a propósito: entre leer y escribir
   * cabe un renombrado, y perder lo que alguien acaba de teclear por una llamada que empezó antes
   * es exactamente lo que estas reglas existen para evitar.
   */
  #write(workspaceId: string, title: string): string | null {
    const at = this.#deps.clock.nowIso();
    const changed = this.#deps.db.prepare(
      `UPDATE workspaces SET title = ?, title_source = 'auto', titled_at = ?, updated_at = ?
       WHERE id = ? AND title_source != 'user'`,
    ).run(title, at, at, workspaceId);
    return changed.changes > 0 ? title : null;
  }
}
