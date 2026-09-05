/**
 * El contador de gasto del asistente.
 *
 * No lee el saldo de la cuenta: **no se puede**. Una clave de proyecto de OpenAI recibe un 403 al
 * pedir `/v1/organization/costs` —le falta el scope `api.usage.read`— y el endpoint del saldo
 * exige una sesión de navegador. Comprobado contra la clave de esta casa, no supuesto.
 *
 * Así que se cuenta donde se gasta. Cada vuelta contra un modelo pasa por `record()` con los
 * tokens que el propio proveedor informó, y el precio se aplica **al leer**, no al escribir: los
 * tokens son el hecho y la tarifa es un parámetro que puede cambiar o estar mal puesto. Guardando
 * el importe, una tarifa equivocada se congela en el histórico; guardando los tokens, corregirla
 * corrige también el pasado.
 */
import type { Database as Db } from 'better-sqlite3';
import type { ModelPrice, SpendByModel, SpendSummary } from '@jarvis/contracts';
import type { Clock } from '../platform/clock.js';
import { newSpendId } from '../platform/ids.js';

export interface SpendServiceDeps {
  db: Db;
  clock: Clock;
  /** Tarifas por modelo, en dólares por millón de tokens. */
  prices: readonly ModelPrice[];
  /** Lo que se declaró haber cargado. 0 = no se sabe, y entonces no se promete ningún resto. */
  budgetUsd?: number;
  /** Desde cuándo cuenta ese presupuesto: la última recarga. */
  since?: string;
  /** Cuántos días de detalle se guardan. Una fila por vuelta ocupa nada, pero no para siempre. */
  retentionDays?: number;
}

interface SpendRow {
  model: string;
  source: string;
  turns: number;
  prompt_tokens: number;
  cached_tokens: number;
  completion_tokens: number;
}

export class SpendService {
  readonly #deps: SpendServiceDeps;
  readonly #prices: Map<string, ModelPrice>;

  constructor(deps: SpendServiceDeps) {
    this.#deps = deps;
    this.#prices = new Map(deps.prices.map((price) => [price.model, price]));
  }

  /**
   * Apunta lo que costó una vuelta.
   *
   * Nunca lanza. Un fallo contando el gasto no puede tumbar la conversación que lo generó: se
   * perdería la respuesta por no haber podido apuntar su precio, que es exactamente al revés de
   * lo que importa.
   */
  record(entry: {
    model: string;
    source: string;
    conversationId?: string | null;
    promptTokens: number;
    cachedTokens: number;
    completionTokens: number;
  }): void {
    try {
      this.#deps.db.prepare(`INSERT INTO model_spend
        (id, at, model, source, conversation_id, prompt_tokens, cached_tokens, completion_tokens)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(newSpendId(), this.#deps.clock.nowIso(), entry.model, entry.source,
          entry.conversationId ?? null, entry.promptTokens, entry.cachedTokens, entry.completionTokens);
    } catch {
      // Contar el gasto es un extra; que falle no puede costar la respuesta.
    }
  }

  /** El precio de unos tokens, o null si ese modelo no tiene tarifa configurada. */
  #cost(row: SpendRow): number | null {
    const price = this.#prices.get(row.model);
    if (!price) return null;
    /*
     * Los cacheados se descuentan del prompt, no se suman.
     *
     * El proveedor informa `prompt_tokens` como el total y aparte cuántos venían de caché. Cobrar
     * los dos por separado sin restar contaría dos veces la mayor parte del prompt de una
     * conversación —el catálogo de herramientas, que no cambia entre vueltas— y el gasto saldría
     * casi el doble de lo que es.
     */
    const fresh = Math.max(0, row.prompt_tokens - row.cached_tokens);
    return (fresh * price.input + row.cached_tokens * price.cached + row.completion_tokens * price.output) / 1_000_000;
  }

  summary(): SpendSummary {
    const since = this.#deps.since ?? null;
    const rows = (since
      ? this.#deps.db.prepare(`SELECT model, source, COUNT(*) AS turns,
          SUM(prompt_tokens) AS prompt_tokens, SUM(cached_tokens) AS cached_tokens,
          SUM(completion_tokens) AS completion_tokens
          FROM model_spend WHERE at >= ? GROUP BY model, source`).all(since)
      : this.#deps.db.prepare(`SELECT model, source, COUNT(*) AS turns,
          SUM(prompt_tokens) AS prompt_tokens, SUM(cached_tokens) AS cached_tokens,
          SUM(completion_tokens) AS completion_tokens
          FROM model_spend GROUP BY model, source`).all()) as SpendRow[];

    const unpriced: string[] = [];
    const byModel: SpendByModel[] = rows.map((row) => {
      const usd = this.#cost(row);
      if (usd === null && !unpriced.includes(row.model)) unpriced.push(row.model);
      return {
        model: row.model,
        source: row.source,
        turns: row.turns,
        promptTokens: row.prompt_tokens,
        cachedTokens: row.cached_tokens,
        completionTokens: row.completion_tokens,
        usd,
      };
    });

    const spentUsd = byModel.reduce((total, entry) => total + (entry.usd ?? 0), 0);
    const turns = byModel.reduce((total, entry) => total + entry.turns, 0);
    const budgetUsd = this.#deps.budgetUsd && this.#deps.budgetUsd > 0 ? this.#deps.budgetUsd : null;
    const remainingUsd = budgetUsd === null ? null : Math.max(0, budgetUsd - spentUsd);
    /*
     * La media sale de las vueltas de verdad, no de una estimación.
     *
     * Y por eso el resto en conversaciones sólo se da cuando ya hay historia: con dos vueltas
     * medidas, «te quedan 41.000 consultas» es un número inventado con aspecto de dato.
     */
    const avgTurnUsd = turns >= 5 && spentUsd > 0 ? spentUsd / turns : null;

    return {
      since,
      spentUsd,
      turns,
      avgTurnUsd,
      byModel: byModel.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0)),
      budgetUsd,
      remainingUsd,
      remainingTurns: remainingUsd !== null && avgTurnUsd ? Math.floor(remainingUsd / avgTurnUsd) : null,
      unpriced,
    };
  }

  /** Tira el detalle viejo. El resumen de lo anterior no se pierde: se pierde el desglose por vuelta. */
  prune(): number {
    const days = this.#deps.retentionDays ?? 180;
    const cutoff = new Date(this.#deps.clock.nowMs() - days * 24 * 3600 * 1000).toISOString();
    return this.#deps.db.prepare('DELETE FROM model_spend WHERE at < ?').run(cutoff).changes;
  }
}

/**
 * Las tarifas, tal como se escriben en el entorno.
 *
 * `modelo:entrada/caché/salida` en dólares por millón, separadas por comas. Es pobre a propósito,
 * por lo de siempre: un JSON en una variable de Compose se escapa mal y el día que le falte una
 * coma el gasto se cuenta como cero sin decir nada.
 */
export function parseModelPrices(raw: string | undefined): ModelPrice[] {
  const prices: ModelPrice[] = [];
  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const colon = trimmed.lastIndexOf(':');
    if (colon <= 0) continue;
    const model = trimmed.slice(0, colon).trim();
    const parts = trimmed.slice(colon + 1).split('/').map((value) => Number(value.trim()));
    if (!model || parts.length !== 3 || parts.some((value) => !Number.isFinite(value) || value < 0)) continue;
    prices.push({ model, input: parts[0] as number, cached: parts[1] as number, output: parts[2] as number });
  }
  return prices;
}
