import { Type, type Static } from '@sinclair/typebox';
import { Iso8601, Provider } from './common.js';

/**
 * Con qué modelo trabaja un agente.
 *
 * El identificador acaba de argumento de la CLI remota —`claude --model X`, `codex -m X`—, así
 * que lo que se acepta es un nombre de modelo y nada más: letras, cifras y los separadores que de
 * verdad usan (`claude-opus-5-5`, `gpt-5.6-sol`, `anthropic/claude-sonnet-5`,
 * `claude-opus-5-5[1m]`). Que no pueda empezar por guion es lo que impide colar una bandera en el
 * hueco del valor.
 */
export const MODEL_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:/@\\[\\]-]{0,127}$';
const MODEL_ID = new RegExp(MODEL_ID_PATTERN);
export const isModelId = (value: string): boolean => MODEL_ID.test(value);

export const ModelId = Type.String({ pattern: MODEL_ID_PATTERN, maxLength: 128 });

/**
 * Un modelo que se puede elegir al mandar trabajo.
 *
 * `alias` lo resuelve la propia CLI al más reciente de su familia (`opus`, `sonnet`): no caduca
 * cuando sale una versión nueva. `seen` es un identificador exacto que ya se usó en la flota, en
 * una sesión del índice o en un trabajo lanzado desde aquí: si se usó, existe.
 */
export const ModelOption = Type.Object({
  provider: Provider,
  id: ModelId,
  kind: Type.Union([Type.Literal('alias'), Type.Literal('seen')]),
  /** Cuándo se usó por última vez. `null` en un alias, que no se usa: se resuelve. */
  lastUsedAt: Type.Union([Iso8601, Type.Null()]),
});
export type ModelOption = Static<typeof ModelOption>;

export const ModelCatalog = Type.Object({
  models: Type.Array(ModelOption),
});
export type ModelCatalog = Static<typeof ModelCatalog>;
