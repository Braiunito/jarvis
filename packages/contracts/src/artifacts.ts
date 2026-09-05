/**
 * Lo que el asistente enseña cuando una frase no basta.
 *
 * Un artifact no es un mensaje más largo: es contenido con forma —una tabla, un volcado, un
 * gráfico, una página— que el asistente decide **cómo** se presenta. Existe porque hasta ahora
 * todo lo que averiguaba salía por el mismo sitio, un párrafo de texto, y comparar el disco de
 * tres máquinas en prosa se lee mal por mucho que la prosa sea buena.
 *
 * Dos decisiones que lo gobiernan todo:
 *
 * 1. **El puntero y el cuerpo viajan por separado.** En el mensaje va una referencia de unos
 *    cientos de bytes (ver `ChatRef` con `kind: 'artifact'`); el cuerpo vive en su propia tabla.
 *    Es porque los últimos mensajes del hilo son también el contexto que se le da al modelo en
 *    cada turno: meter ahí una tabla de doscientas filas se paga en tokens para siempre.
 * 2. **La presentación la elige quien produce el contenido**, no la interfaz. El asistente sabe
 *    si lo que acaba de reunir es un apunte que se lee de paso o un informe que hay que mirar
 *    entero; la pantalla no puede saberlo mirando el tamaño.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Iso8601 } from './common.js';

/**
 * De qué está hecho el artifact.
 *
 * La lista es cerrada a propósito: cada entrada tiene un renderizador escrito y probado, y un
 * `kind` que la interfaz no sepa pintar es peor que no tenerlo, porque el asistente cree que ha
 * enseñado algo.
 */
export const ARTIFACT_KINDS = ['markdown', 'table', 'json', 'code', 'chart', 'html'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export const ArtifactKindSchema = Type.Union(ARTIFACT_KINDS.map((kind) => Type.Literal(kind)));

/**
 * Dónde se enseña.
 *
 * `inline` — dentro de la burbuja, siempre visible. Es parte de la respuesta.
 * `panel`  — una hoja al lado que se consulta mientras se sigue leyendo el hilo.
 * `modal`  — toma la pantalla. Para lo que hay que mirar entero antes de seguir.
 */
export const ARTIFACT_PRESENTATIONS = ['inline', 'panel', 'modal'] as const;
export type ArtifactPresentation = (typeof ARTIFACT_PRESENTATIONS)[number];
export const ArtifactPresentationSchema = Type.Union(
  ARTIFACT_PRESENTATIONS.map((presentation) => Type.Literal(presentation)),
);

/** Una tabla. Las celdas son escalares: si hace falta anidar, eso es un `json`. */
export const TableBody = Type.Object({
  columns: Type.Array(Type.Object({
    key: Type.String({ minLength: 1 }),
    label: Type.String(),
    align: Type.Optional(Type.Union([Type.Literal('left'), Type.Literal('right')])),
  }), { minItems: 1 }),
  rows: Type.Array(Type.Record(
    Type.String(),
    Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
  )),
});
export type TableBody = Static<typeof TableBody>;

/**
 * Un gráfico, y sólo de las tres formas que la interfaz sabe dibujar.
 *
 * Está acotado al catálogo real de `ui/charts.tsx` —histograma, anillo y medidor— en vez de
 * admitir series arbitrarias, porque aquí no hay librería de gráficos y no la va a haber por
 * esto: un `chart` genérico obligaría a traer unos 70 KiB para dibujar lo que ya se dibuja.
 * Que el contrato diga la verdad sobre lo que se puede pintar es más útil que prometer de más.
 *
 * El color no viene de fuera: lo pone la interfaz con sus propios tokens, que es lo que hace que
 * se vea igual en claro y en oscuro.
 */
export const ChartBody = Type.Union([
  Type.Object({
    shape: Type.Literal('bars'),
    label: Type.String(),
    points: Type.Array(Type.Object({
      at: Type.String(),
      value: Type.Number(),
      /** La parte del valor que salió mal, si la distinción importa. */
      bad: Type.Optional(Type.Number()),
    }), { minItems: 1 }),
  }),
  Type.Object({
    shape: Type.Literal('donut'),
    caption: Type.String(),
    total: Type.Number(),
    slices: Type.Array(Type.Object({
      key: Type.String({ minLength: 1 }),
      label: Type.String(),
      value: Type.Number(),
    }), { minItems: 1 }),
  }),
  Type.Object({
    shape: Type.Literal('meter'),
    label: Type.String(),
    value: Type.Number(),
    max: Type.Number(),
    tone: Type.Optional(Type.Union([
      Type.Literal('accent'), Type.Literal('ok'), Type.Literal('warn'), Type.Literal('danger'),
    ])),
  }),
]);
export type ChartBody = Static<typeof ChartBody>;

/**
 * El artifact completo, con su cuerpo. Sólo se sirve cuando alguien lo abre.
 *
 * `body` es siempre texto: para `table` y `chart` es el JSON de los esquemas de arriba, ya
 * validado al escribirlo. Se guarda serializado y no como columnas porque un artifact es
 * inmutable —nace con el turno y no se edita— y nadie va a consultarlo por sus campos.
 */
export const ChatArtifact = Type.Object({
  id: Type.String(),
  conversationId: Type.String(),
  /** El mensaje del que cuelga. Nulo mientras el turno no ha cerrado todavía. */
  messageId: Type.Union([Type.String(), Type.Null()]),
  kind: ArtifactKindSchema,
  presentation: ArtifactPresentationSchema,
  title: Type.String(),
  /** Una línea diciendo qué se mira y de dónde salió. La procedencia se dice, no se adivina. */
  caption: Type.Union([Type.String(), Type.Null()]),
  /** Sólo para `kind: 'code'`. */
  language: Type.Union([Type.String(), Type.Null()]),
  body: Type.String(),
  bytes: Type.Integer({ minimum: 0 }),
  /** Si hubo que recortarlo. Lo que va acotado lo dice, igual que en las herramientas. */
  truncated: Type.Boolean(),
  createdAt: Iso8601,
});
export type ChatArtifact = Static<typeof ChatArtifact>;
