/**
 * Servidores MCP que el core **consume**.
 *
 * ADR-004 dijo que MCP era un adaptador para modelos externos —Jarvis lo expone, no lo llama— y
 * eso sigue siendo verdad para la API de la aplicación: el navegador nunca habla MCP y ninguna
 * pantalla depende de que un servidor MCP esté vivo. Lo que cambia con ADR-009 es la otra
 * dirección: el core puede ser **cliente** de servidores declarados en su configuración, y lo que
 * obtiene de ellos entra por un caso de uso propio (`McpService`) con su allowlist, su auditoría
 * y su estado de salud, igual que el índice de sesiones.
 *
 * La diferencia con «una tool que llama a una API HTTP» —que el toolbox prohíbe— es exactamente
 * ésa: aquí hay un servicio del dominio en medio, no una llamada suelta escondida en el catálogo.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Iso8601 } from './common.js';

/**
 * En qué se agrupa una capacidad para poder enseñarla sin volcar el catálogo entero.
 *
 * Las áreas no son decoración: son lo que hace que un modelo pequeño pueda navegar 108
 * herramientas sin que quepan todas en su contexto. Se piden por área, no de una vez.
 */
export const MCP_AREAS = [
  'sistema', 'servicios', 'procesos', 'red', 'disco', 'ficheros',
  'docker', 'paquetes', 'usuarios', 'camaras', 'sesiones', 'otras',
] as const;
export type McpArea = (typeof MCP_AREAS)[number];
export const McpAreaSchema = Type.Union(MCP_AREAS.map((area) => Type.Literal(area)));

/**
 * Una capacidad: una herramienta de un servidor MCP, ya filtrada por la allowlist.
 *
 * El nombre cualificado (`servidor.herramienta`) es la identidad pública. Sin cualificar, dos
 * servidores con una `read_text_file` cada uno serían indistinguibles en la auditoría, que es
 * justo donde peor sienta la ambigüedad.
 */
export const McpCapability = Type.Object({
  name: Type.String({ maxLength: 160 }),
  server: Type.String({ maxLength: 64 }),
  tool: Type.String({ maxLength: 128 }),
  area: McpAreaSchema,
  summary: Type.String({ maxLength: 400 }),
  /**
   * Si la herramienta tiene efectos sobre la máquina.
   *
   * El servidor lo insinúa —el MCP de Zeus etiqueta sus tools con `write` o con `read`— y esa
   * etiqueta se usa, pero **no manda**: la última palabra la tiene la configuración del core, que
   * puede declarar un servidor entero de sólo lectura y entonces ninguna etiqueta lo abre. Creerle
   * a un servidor sobre si escribe es fiarse justo de quien tiene el efecto.
   */
  writes: Type.Boolean(),
  /** El esquema de entrada tal como lo publica el servidor. Sólo se pide cuando hace falta. */
  inputSchema: Type.Optional(Type.Unknown()),
});
export type McpCapability = Static<typeof McpCapability>;

export const MCP_SERVER_STATUSES = ['ok', 'stale', 'failed', 'disabled'] as const;
export type McpServerStatus = (typeof MCP_SERVER_STATUSES)[number];

/**
 * El estado de un servidor, para Salud y para la pantalla.
 *
 * `url` va sin credencial nunca: si el servidor lleva token, se dice que lo lleva y no cuál es.
 */
export const McpServerState = Type.Object({
  name: Type.String({ maxLength: 64 }),
  url: Type.String({ maxLength: 512 }),
  status: Type.Union(MCP_SERVER_STATUSES.map((status) => Type.Literal(status))),
  toolCount: Type.Integer({ minimum: 0 }),
  /** Cuántas quedaron fuera por la allowlist. Un catálogo recortado lo dice. */
  filteredOut: Type.Integer({ minimum: 0 }),
  writesAllowed: Type.Boolean(),
  authenticated: Type.Boolean(),
  lastOkAt: Type.Union([Iso8601, Type.Null()]),
  lastError: Type.Union([Type.String(), Type.Null()]),
  serverInfo: Type.Union([Type.String(), Type.Null()]),
});
export type McpServerState = Static<typeof McpServerState>;

/** El resultado de invocar una capacidad, ya acotado. Nunca se recorta en silencio (ADR-007). */
export const McpCallResult = Type.Object({
  ok: Type.Boolean(),
  name: Type.String(),
  content: Type.Unknown(),
  truncated: Type.Boolean(),
  originalChars: Type.Optional(Type.Integer({ minimum: 0 })),
  /**
   * Argumentos que la herramienta no declara y se quitaron antes de llamar.
   *
   * Existe porque un modelo pequeño extrapola: en producción le pasó `seconds` a una capacidad que
   * no recibe nada, copiando el parámetro de otra del mismo lote. Se ajusta y **se dice**, porque
   * alterar en silencio lo que alguien pidió lleva a concluir sobre una consulta que no se hizo.
   */
  dropped: Type.Optional(Type.Array(Type.String())),
  durationMs: Type.Integer({ minimum: 0 }),
});
export type McpCallResult = Static<typeof McpCallResult>;
