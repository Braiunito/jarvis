/**
 * Lo que cuesta pensar, contado en casa.
 *
 * Existe porque el proveedor no lo dice: una clave de proyecto de OpenAI **no puede leer el saldo**
 * de la cuenta —`/v1/organization/costs` contesta 403 por falta de scope, y el endpoint de saldo
 * exige una sesión de navegador, no una clave—. Así que lo único honesto es contar los tokens
 * donde se gastan, que es aquí, y ponerles precio con una tarifa configurada.
 *
 * De ahí la regla que gobierna todo esto: **lo que se ve es una estimación de lo gastado, no el
 * saldo de la cuenta**, y la interfaz tiene que decirlo. Confundir «he contado 3,20 $» con «te
 * quedan 6,80 $» es la clase de error que se descubre cuando la clave deja de funcionar a mitad
 * de una conversación.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Iso8601 } from './common.js';

/** Tarifa de un modelo, en dólares por millón de tokens. */
export const ModelPrice = Type.Object({
  model: Type.String(),
  input: Type.Number({ minimum: 0 }),
  /**
   * Los tokens que el proveedor no tuvo que volver a leer.
   *
   * Van aparte porque cuestan un orden de magnitud menos —en gpt-5-nano, $0,005 contra $0,05— y
   * son la mayor parte del prompt en una conversación: el catálogo de herramientas no cambia entre
   * vueltas. Meterlos en el mismo saco haría que el gasto pareciera diez veces mayor.
   */
  cached: Type.Number({ minimum: 0 }),
  output: Type.Number({ minimum: 0 }),
});
export type ModelPrice = Static<typeof ModelPrice>;

export const SpendByModel = Type.Object({
  model: Type.String(),
  source: Type.String(),
  turns: Type.Integer({ minimum: 0 }),
  promptTokens: Type.Integer({ minimum: 0 }),
  cachedTokens: Type.Integer({ minimum: 0 }),
  completionTokens: Type.Integer({ minimum: 0 }),
  /** Null cuando no hay tarifa configurada para ese modelo: se cuentan tokens, no se inventa precio. */
  usd: Type.Union([Type.Number(), Type.Null()]),
});
export type SpendByModel = Static<typeof SpendByModel>;

export const SpendSummary = Type.Object({
  /** Desde cuándo se cuenta: la fecha de la última recarga, si se declaró. */
  since: Type.Union([Iso8601, Type.Null()]),
  spentUsd: Type.Number({ minimum: 0 }),
  turns: Type.Integer({ minimum: 0 }),
  /** Lo que ha costado de media una vuelta, con los datos de verdad y no con una suposición. */
  avgTurnUsd: Type.Union([Type.Number(), Type.Null()]),
  byModel: Type.Array(SpendByModel),
  /**
   * Lo que se declaró haber cargado, si se declaró.
   *
   * Es un dato que pone la persona, no algo que se lea de la cuenta. Sin él no se enseña «te
   * queda» nada: un resto calculado sobre un presupuesto inventado es peor que no dar ninguno.
   */
  budgetUsd: Type.Union([Type.Number(), Type.Null()]),
  remainingUsd: Type.Union([Type.Number(), Type.Null()]),
  /** Cuántas conversaciones más entran con lo que queda, al ritmo real medido. Aproximado. */
  remainingTurns: Type.Union([Type.Integer(), Type.Null()]),
  /** Modelos que se usaron y para los que no hay tarifa: su gasto no está contado. Se dice. */
  unpriced: Type.Array(Type.String()),
});
export type SpendSummary = Static<typeof SpendSummary>;
