/**
 * Poner nombre a un workspace.
 *
 * Un identificador de sesión no dice nada, y «sin título» tampoco. El nombre sale de lo primero
 * que se pidió y de lo que salió, que es exactamente lo que una persona recordaría de ese trabajo.
 *
 * Dos reglas gobiernan esto:
 *   · el título que escribe una persona **gana siempre** y no se vuelve a tocar;
 *   · sin modelo configurado no se queda sin nombre: se cae a las primeras palabras del prompt.
 */
import type { Database as Db } from 'better-sqlite3';
import type { Clock } from '../platform/clock.js';

export interface TitleModel {
  /** Devuelve un título corto, o null si no puede. Nunca lanza hacia arriba. */
  summarize(input: { prompt: string; result: string | null }): Promise<string | null>;
}

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
    // Nombrar es un adorno útil: si tarda, no vale la pena esperarlo.
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(`${this.#baseUrl}/v1/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#apiKey}` },
        body: JSON.stringify({
          model: this.#model,
          max_tokens: 40,
          temperature: 0.2,
          messages: [
            {
              role: 'system',
              content: 'Nombra este trabajo en español con 3 a 6 palabras, en minúscula, sin comillas '
                + 'ni punto final. Describe el asunto, no la acción de pedirlo.',
            },
            { role: 'user', content: `Petición: ${prompt.slice(0, 800)}\n\nResultado: ${(result ?? '').slice(0, 800)}` },
          ],
        }),
      });
      if (!response.ok) return null;
      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const text = body.choices?.[0]?.message?.content?.trim();
      return text ? cleanTitle(text) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Sin modelo, el título sale del propio prompt: peor nombre, pero nombre al fin y al cabo.
 *
 * Lo que se manda al agente puede llevar delante el preámbulo de estrategia y el bloque de
 * adjuntos, separados por una línea en blanco. Lo que pidió la persona es el último bloque, así
 * que es de ahí de donde se saca el nombre: un workspace llamado «You are running on the bastion»
 * no le sirve a nadie.
 */
export function titleFromPrompt(prompt: string): string {
  const blocks = prompt.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  const last = blocks.at(-1) ?? prompt;
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

export interface TitleServiceDeps {
  db: Db;
  clock: Clock;
  model: TitleModel | null;
}

export class TitleService {
  readonly #deps: TitleServiceDeps;

  constructor(deps: TitleServiceDeps) {
    this.#deps = deps;
  }

  get hasModel(): boolean { return this.#deps.model !== null; }

  /** Lo que escribe una persona es definitivo. */
  setByUser(workspaceId: string, title: string): void {
    this.#deps.db.prepare("UPDATE workspaces SET title = ?, title_source = 'user', updated_at = ? WHERE id = ?")
      .run(cleanTitle(title), this.#deps.clock.nowIso(), workspaceId);
  }

  /**
   * Nombra el workspace a partir de un run que acaba de terminar.
   *
   * No toca nada si ya hay un título puesto por una persona, ni si el índice traía uno bueno.
   */
  async nameFromRun(workspaceId: string, run: { prompt: string; resultSummary: string | null }): Promise<string | null> {
    const row = this.#deps.db.prepare('SELECT title, title_source FROM workspaces WHERE id = ?')
      .get(workspaceId) as { title: string | null; title_source: string } | undefined;
    if (!row) return null;
    if (row.title_source === 'user') return null;
    if (row.title && row.title_source === 'index') return null;
    if (row.title && row.title_source === 'auto') return null;

    const generated = this.#deps.model
      ? await this.#deps.model.summarize({ prompt: run.prompt, result: run.resultSummary })
      : null;
    const title = generated ?? titleFromPrompt(run.prompt);

    this.#deps.db.prepare("UPDATE workspaces SET title = ?, title_source = 'auto', updated_at = ? WHERE id = ? AND title_source != 'user'")
      .run(title, this.#deps.clock.nowIso(), workspaceId);
    return title;
  }
}
