/**
 * Cliente MCP sobre Streamable HTTP.
 *
 * Habla el transporte que sirve el MCP de sistema de Zeus: JSON-RPC por POST, con la respuesta
 * llegando como `application/json` o como `text/event-stream` según le apetezca al servidor —el de
 * Zeus contesta lo segundo hasta para el `initialize`—, y una sesión que vive en la cabecera
 * `mcp-session-id`.
 *
 * Lo que este fichero **no** hace es tan importante como lo que hace: no decide qué herramientas
 * se pueden llamar, no audita y no sabe quién pregunta. Eso es del `McpService`, que es el caso de
 * uso. Aquí sólo está el sobre.
 *
 * Tres cosas que cuestan caro si se olvidan y por eso están escritas:
 *
 *  1. Después de `initialize` hay que mandar `notifications/initialized`. Sin eso, un servidor
 *     estricto rechaza todo lo que venga después y el fallo se lee como «no hay herramientas».
 *  2. La sesión caduca. Un 404 con sesión puesta significa «esa sesión ya no existe», no «no
 *     existe el endpoint»: se rehace el saludo y se reintenta una vez.
 *  3. `tools/list` pagina. Un servidor con 108 herramientas puede devolverlas en varias tandas, y
 *     quedarse con la primera es servir un catálogo incompleto sin enterarse.
 */
import { readSseEvents } from '../platform/sse-read.js';

/** La versión del protocolo que se pide. El servidor contesta con la suya y se acepta la que dé. */
const PROTOCOL_VERSION = '2025-06-18';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface McpToolDescriptor {
  name: string;
  title: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * Las etiquetas del servidor (`_meta.fastmcp.tags` en el de Zeus: `docker`, `read`, `write`…).
   *
   * Se leen y se usan para clasificar, pero no mandan sobre si algo escribe: eso lo decide la
   * configuración del core. Un servidor que se equivoca al etiquetarse no debería poder abrir una
   * puerta con sólo decir que está abierta.
   */
  tags: string[];
}

export interface McpToolResult {
  content: unknown;
  isError: boolean;
  /** El texto plano de los bloques, por si quien llama prefiere eso al contenido estructurado. */
  text: string;
}

export interface McpClientOptions {
  url: string;
  token?: string | undefined;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  clientName?: string;
  clientVersion?: string;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** Un fallo del servidor MCP se distingue de un fallo de red: sube con el código que dio. */
export class McpError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, { code = 'MCP_FAILED', retryable = false }: { code?: string; retryable?: boolean } = {}) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.retryable = retryable;
  }
}

export class McpHttpClient {
  readonly #url: string;
  readonly #token: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;
  readonly #clientName: string;
  readonly #clientVersion: string;
  #nextId = 1;
  /**
   * El saludo en curso o ya hecho.
   *
   * Es una promesa y no un valor porque el arranque de un turno dispara varias llamadas casi a la
   * vez: sin esto, cada una abriría su propia sesión contra el servidor y sólo la última quedaría
   * viva. Guardar la promesa hace que todas esperen al mismo saludo.
   */
  #handshake: Promise<{ sessionId: string | null; info: string | null }> | null = null;
  #info: string | null = null;

  constructor(options: McpClientOptions) {
    this.#url = options.url;
    this.#token = options.token || undefined;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#fetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.#clientName = options.clientName ?? 'jarvis-core';
    this.#clientVersion = options.clientVersion ?? '0.1.0';
  }

  get url(): string { return this.#url; }
  get serverInfo(): string | null { return this.#info; }
  get authenticated(): boolean { return Boolean(this.#token); }

  /** Olvida la sesión. El siguiente uso vuelve a saludar. */
  reset(): void {
    this.#handshake = null;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const tools: McpToolDescriptor[] = [];
    let cursor: string | undefined;
    // Un servidor que devuelve cursores para siempre no puede tener el bucle abierto: 20 páginas
    // son 10.000 herramientas, muy por encima de lo que ningún catálogo razonable sirve.
    for (let page = 0; page < 20; page += 1) {
      const result = await this.#request('tools/list', cursor ? { cursor } : {}) as {
        tools?: unknown[]; nextCursor?: string | null;
      };
      for (const raw of result.tools ?? []) {
        const tool = toDescriptor(raw);
        if (tool) tools.push(tool);
      }
      const next = result.nextCursor;
      if (!next || typeof next !== 'string') return tools;
      cursor = next;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = await this.#request('tools/call', { name, arguments: args }) as {
      content?: Array<{ type?: string; text?: string }>;
      structuredContent?: unknown;
      isError?: boolean;
    };
    const text = (result.content ?? [])
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n');
    return {
      // El contenido estructurado es lo que se le pasa al modelo cuando existe: ya viene tipado y
      // ahorra que el modelo reparsee un JSON que el servidor había serializado dentro de un texto.
      content: result.structuredContent !== undefined ? result.structuredContent : (text || null),
      isError: result.isError === true,
      text,
    };
  }

  // ---- transporte ---------------------------------------------------------

  async #request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const first = await this.#ensureSession();
    try {
      return await this.#rpc(method, params, first.sessionId);
    } catch (error) {
      // Sesión caducada: se rehace el saludo una vez. Reintentar más sería esconder un servidor
      // que va y viene detrás de una latencia multiplicada.
      if (error instanceof McpError && error.code === 'MCP_SESSION_LOST') {
        this.#handshake = null;
        const again = await this.#ensureSession();
        return await this.#rpc(method, params, again.sessionId);
      }
      throw error;
    }
  }

  #ensureSession(): Promise<{ sessionId: string | null; info: string | null }> {
    if (this.#handshake) return this.#handshake;
    const handshake = this.#handshakeOnce();
    this.#handshake = handshake;
    // Un saludo fallido no se cachea: el servidor puede estar arrancando y el siguiente intento
    // tiene que volver a preguntar de verdad.
    handshake.catch(() => {
      if (this.#handshake === handshake) this.#handshake = null;
    });
    return handshake;
  }

  async #handshakeOnce(): Promise<{ sessionId: string | null; info: string | null }> {
    const { body, sessionId } = await this.#post({
      jsonrpc: '2.0',
      id: this.#nextId++,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: this.#clientName, version: this.#clientVersion },
      },
    }, null);

    const result = unwrap(body);
    const server = (result as { serverInfo?: { name?: string; version?: string } } | null)?.serverInfo;
    this.#info = server?.name ? `${server.name}${server.version ? ` ${server.version}` : ''}` : null;

    // Sin esto, un servidor estricto rechaza todo lo que venga después.
    await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);
    return { sessionId, info: this.#info };
  }

  async #rpc(method: string, params: Record<string, unknown>, sessionId: string | null): Promise<unknown> {
    const { body } = await this.#post({ jsonrpc: '2.0', id: this.#nextId++, method, params }, sessionId);
    return unwrap(body);
  }

  async #post(
    message: Record<string, unknown>,
    sessionId: string | null,
  ): Promise<{ body: JsonRpcResponse | null; sessionId: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(this.#url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          // Los dos, porque el servidor elige: el de Zeus contesta SSE hasta para el saludo.
          accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
          ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
        },
        body: JSON.stringify(message),
      });

      if (response.status === 404 && sessionId) {
        throw new McpError('the MCP session expired', { code: 'MCP_SESSION_LOST', retryable: true });
      }
      if (response.status === 401 || response.status === 403) {
        throw new McpError(`the MCP server rejected the credential (${response.status})`, { code: 'MCP_UNAUTHORIZED' });
      }
      if (!response.ok) {
        throw new McpError(`the MCP server answered ${response.status}`, {
          code: 'MCP_UNAVAILABLE', retryable: response.status >= 500,
        });
      }

      const returned = response.headers.get('mcp-session-id') ?? sessionId;
      // Una notificación se responde con 202 y sin cuerpo: no hay nada que leer y esperar a que
      // el stream cierre sería regalar el plazo entero por un mensaje que no lleva respuesta.
      if (response.status === 202) {
        await response.body?.cancel().catch(() => undefined);
        return { body: null, sessionId: returned };
      }

      return { body: await this.#readBody(response), sessionId: returned };
    } catch (error) {
      if (error instanceof McpError) throw error;
      if ((error as Error).name === 'AbortError') {
        throw new McpError(`the MCP server did not answer in ${this.#timeoutMs} ms`, {
          code: 'MCP_TIMEOUT', retryable: true,
        });
      }
      throw new McpError(`could not reach the MCP server: ${(error as Error).message}`, {
        code: 'MCP_UNAVAILABLE', retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** El cuerpo, venga como JSON o dentro de un stream de eventos. */
  async #readBody(response: Response): Promise<JsonRpcResponse | null> {
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('text/event-stream')) {
      const text = await response.text();
      if (!text.trim()) return null;
      return JSON.parse(text) as JsonRpcResponse;
    }
    // El primer evento que trae una respuesta JSON-RPC es la respuesta: en cuanto está, se sale
    // del bucle y eso cancela el stream. Lo que el servidor mande después son notificaciones que
    // a este cliente no le sirven.
    for await (const event of readSseEvents(response.body)) {
      if (!event.data.trim()) continue;
      const parsed = JSON.parse(event.data) as JsonRpcResponse;
      if (parsed.result !== undefined || parsed.error !== undefined) return parsed;
    }
    return null;
  }
}

/** Un error JSON-RPC es del servidor, no del transporte: se distingue para poder contarlo así. */
function unwrap(body: JsonRpcResponse | null): unknown {
  if (!body) throw new McpError('the MCP server answered without a body', { code: 'MCP_EMPTY' });
  if (body.error) {
    throw new McpError(body.error.message || 'the MCP tool failed', { code: 'MCP_TOOL_ERROR' });
  }
  return body.result ?? null;
}

function toDescriptor(raw: unknown): McpToolDescriptor | null {
  const tool = raw as {
    name?: unknown; title?: unknown; description?: unknown; inputSchema?: unknown;
    _meta?: { fastmcp?: { tags?: unknown } };
  } | null;
  if (!tool || typeof tool.name !== 'string' || !tool.name) return null;
  const tags = tool._meta?.fastmcp?.tags;
  return {
    name: tool.name,
    title: typeof tool.title === 'string' ? tool.title : null,
    description: typeof tool.description === 'string' ? tool.description : '',
    inputSchema: (tool.inputSchema && typeof tool.inputSchema === 'object')
      ? tool.inputSchema as Record<string, unknown>
      : { type: 'object', properties: {} },
    tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [],
  };
}
