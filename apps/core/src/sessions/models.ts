/**
 * Qué modelos se ofrecen al mandar trabajo, y qué cuenta como modelo.
 *
 * No hay una lista oficial que consultar: ninguna de las tres CLI expone «qué modelos tengo». Lo
 * que sí hay es lo que la flota ya ha usado —el índice guarda el último modelo de cada sesión y
 * cada trabajo lanzado desde aquí guarda el que se pidió—, y eso tiene una virtud que una lista
 * escrita a mano no tiene: si se usó, existe. Para Claude se añaden además sus alias, que la CLI
 * resuelve al más reciente de cada familia y por eso no caducan cuando sale una versión.
 */
import type { ModelOption, Provider } from '@jarvis/contracts';
import { isModelId } from '@jarvis/contracts';

/** Lo que el campo `model` trae a veces y no es un modelo sino quién lo sirve. */
const VENDORS = new Set(['openai', 'anthropic', 'google', 'azure', 'ollama', 'openrouter']);

/**
 * El modelo, o `null` si lo que hay no lo es.
 *
 * Fuera quedan el `<synthetic>` que Claude Code pone en los mensajes que escribe él (un error de
 * la API, un turno cortado) y un proveedor a secas, que es lo que el índice guarda para Codex
 * cuando no encuentra el modelo.
 */
export function cleanModel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.startsWith('<') || VENDORS.has(value.toLowerCase())) return null;
  return value;
}

/** Los alias que entiende cada CLI, en el orden en que se ofrecen. */
export const MODEL_ALIASES: Record<Provider, string[]> = {
  claude: ['opus', 'sonnet', 'haiku'],
  codex: [],
  opencode: [],
};

export interface ModelUse {
  provider: string;
  model: string | null | undefined;
  at: string | null | undefined;
}

/**
 * El catálogo: primero los alias, después lo usado, lo más reciente antes.
 *
 * Lo que no pasaría la validación de un trabajo no se ofrece: elegirlo acabaría en un rechazo.
 */
export function modelCatalog(uses: ModelUse[]): ModelOption[] {
  const providers = Object.keys(MODEL_ALIASES) as Provider[];
  const seen = new Map<string, ModelOption>();
  for (const use of uses) {
    const provider = use.provider as Provider;
    const id = cleanModel(use.model);
    if (!providers.includes(provider) || !id || !isModelId(id)) continue;
    // Un trabajo mandado con `opus` guarda `opus`: ya está arriba, como alias.
    if (MODEL_ALIASES[provider].includes(id)) continue;
    const key = `${provider}\n${id}`;
    const at = use.at || null;
    const previous = seen.get(key);
    if (!previous) {
      seen.set(key, { provider, id, kind: 'seen', lastUsedAt: at });
    } else if (at && (!previous.lastUsedAt || at > previous.lastUsedAt)) {
      previous.lastUsedAt = at;
    }
  }

  const aliases: ModelOption[] = providers.flatMap((provider) =>
    MODEL_ALIASES[provider].map((id) => ({ provider, id, kind: 'alias' as const, lastUsedAt: null })));
  const used = [...seen.values()].sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''));
  return [...aliases, ...used];
}
