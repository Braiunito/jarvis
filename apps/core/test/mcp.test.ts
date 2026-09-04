/**
 * El cliente MCP y el caso de uso que lo gobierna (ADR-009).
 *
 * Lo que se prueba no es que un servidor MCP conteste —eso es suyo— sino las cuatro cosas de las
 * que depende que enchufar 108 herramientas a un asistente sea seguro y no un puerto abierto:
 * que el saludo del transporte se hace entero, que la allowlist manda sobre lo que diga el
 * servidor, que una herramienta con efectos no se ejecuta sin permiso, y que lo que vuelve va
 * acotado y lo dice.
 *
 * El servidor falso imita al de Zeus en lo que importa y en lo que duele: contesta
 * `text/event-stream` **hasta para el `initialize`**, entrega la sesión en una cabecera, y exige
 * la notificación `initialized` antes de atender nada. Los tres detalles son de los que no se ven
 * en un diagrama y tumban la integración.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/platform/clock.js';
import { migrate, openDatabase } from '../src/platform/db.js';
import { AuditLog } from '../src/platform/audit.js';
import { McpHttpClient } from '../src/mcp/client.js';
import { McpService, summarize } from '../src/mcp/service.js';
import { DEFAULT_DENIED_TOOLS, parseMcpServers, parsePairs } from '../src/mcp/config.js';
import { fitToSchema } from '../src/mcp/service.js';
import { readSseEvents } from '../src/platform/sse-read.js';

const NOW = '2026-09-04T12:00:00.000Z';

/** Una tool como la publica fastmcp: con sus tags dentro de `_meta`. */
const tool = (name: string, tags: string[], description = `hace ${name}`): Record<string, unknown> => ({
  name,
  title: name,
  description,
  inputSchema: { type: 'object', properties: {} },
  _meta: { fastmcp: { tags } },
});

const DEFAULT_TOOLS = [
  tool('system_health_snapshot', ['system', 'diagnostic', 'safe'], 'Snapshot único para diagnóstico inicial.\n\nMás detalle.'),
  tool('docker_logs', ['docker', 'logs', 'safe']),
  tool('docker_restart', ['docker', 'write']),
  // La que enseñó la lección: `admin` sin `write`. Apagar el servidor no lleva etiqueta de escritura.
  tool('poweroff_server', ['system', 'admin']),
  tool('reboot_server', ['system', 'admin']),
  tool('camwall_overview', ['camwall', 'safe']),
  tool('listening_ports', ['network', 'safe']),
];

interface FakeServerOptions {
  tools?: Array<Record<string, unknown>>;
  /** Páginas de `tools/list`, para probar que se recorren todas. */
  pages?: Array<Array<Record<string, unknown>>>;
  /** Cuántas veces la sesión caduca antes de aguantar. */
  expireSessions?: number;
  callResult?: unknown;
  callIsError?: boolean;
}

interface FakeServer {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  calls: Array<{ method: string; params: unknown; sessionId: string | null }>;
  handshakes: number;
}

function fakeMcpServer(options: FakeServerOptions = {}): FakeServer {
  const calls: FakeServer['calls'] = [];
  const state = { handshakes: 0, expired: options.expireSessions ?? 0, initialized: new Set<string>() };

  const sse = (payload: unknown): Response => new Response(
    // Con un evento nombrado y línea en blanco al final, como manda el protocolo.
    `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

  const server: FakeServer = {
    handshakes: 0,
    calls,
    async fetch(_url, init) {
      const message = JSON.parse(String(init.body)) as { id?: number; method: string; params?: unknown };
      const headers = (init.headers ?? {}) as Record<string, string>;
      const sessionId = headers['mcp-session-id'] ?? null;
      calls.push({ method: message.method, params: message.params ?? null, sessionId });

      if (message.method === 'initialize') {
        state.handshakes += 1;
        server.handshakes = state.handshakes;
        const id = `sesion-${state.handshakes}`;
        const response = sse({
          jsonrpc: '2.0', id: message.id,
          result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'Zeus System MCP', version: '4.0.2' } },
        });
        return new Response(response.body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'mcp-session-id': id },
        });
      }

      if (message.method === 'notifications/initialized') {
        if (sessionId) state.initialized.add(sessionId);
        return new Response(null, { status: 202 });
      }

      // Una sesión caducada contesta 404, que es «esa sesión ya no existe», no «no hay endpoint».
      if (state.expired > 0) {
        state.expired -= 1;
        return new Response('unknown session', { status: 404 });
      }
      // Un servidor estricto no atiende a quien no completó el saludo.
      if (!sessionId || !state.initialized.has(sessionId)) {
        return new Response('not initialized', { status: 400 });
      }

      if (message.method === 'tools/list') {
        if (options.pages) {
          const cursor = (message.params as { cursor?: string } | null)?.cursor;
          const page = cursor ? Number.parseInt(cursor, 10) : 0;
          const tools = options.pages[page] ?? [];
          const hasMore = page + 1 < options.pages.length;
          return sse({
            jsonrpc: '2.0', id: message.id,
            result: { tools, ...(hasMore ? { nextCursor: String(page + 1) } : {}) },
          });
        }
        return sse({ jsonrpc: '2.0', id: message.id, result: { tools: options.tools ?? DEFAULT_TOOLS } });
      }

      if (message.method === 'tools/call') {
        return sse({
          jsonrpc: '2.0', id: message.id,
          result: {
            content: [{ type: 'text', text: 'texto plano' }],
            structuredContent: options.callResult ?? { ok: true },
            isError: options.callIsError ?? false,
          },
        });
      }

      return sse({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });
    },
  };
  return server;
}

function buildService(server: FakeServer, overrides: Partial<Parameters<typeof parseMcpServers>[0]> = {}): McpService {
  const db = openDatabase({ path: ':memory:' });
  migrate(db);
  const clock = fixedClock(NOW);
  return new McpService({
    servers: parseMcpServers({ servers: 'zeus=http://zeus.test/mcp', ...overrides }),
    clock,
    audit: new AuditLog(db, clock),
    fetchImpl: server.fetch,
  });
}

describe('MCP · el transporte', () => {
  let server: FakeServer;

  beforeEach(() => {
    server = fakeMcpServer();
  });

  it('saluda entero: initialize, la sesión de la cabecera y la notificación initialized', async () => {
    const client = new McpHttpClient({ url: 'http://zeus.test/mcp', fetchImpl: server.fetch });
    const tools = await client.listTools();

    expect(tools).toHaveLength(DEFAULT_TOOLS.length);
    expect(client.serverInfo).toBe('Zeus System MCP 4.0.2');
    // El orden importa: sin `initialized` por medio, un servidor estricto rechaza el `tools/list`.
    expect(server.calls.map((call) => call.method))
      .toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    // Y la sesión viaja en todo lo que va después del saludo.
    expect(server.calls[2]?.sessionId).toBe('sesion-1');
  });

  it('saluda una sola vez aunque le lleguen varias peticiones a la vez', async () => {
    const client = new McpHttpClient({ url: 'http://zeus.test/mcp', fetchImpl: server.fetch });
    await Promise.all([client.listTools(), client.listTools(), client.listTools()]);
    // Sin el saludo compartido, cada llamada abriría su propia sesión y sólo valdría la última.
    expect(server.handshakes).toBe(1);
  });

  it('una sesión caducada se rehace y la llamada se reintenta una vez', async () => {
    const expiring = fakeMcpServer({ expireSessions: 1 });
    const client = new McpHttpClient({ url: 'http://zeus.test/mcp', fetchImpl: expiring.fetch });
    const tools = await client.listTools();

    expect(tools.length).toBeGreaterThan(0);
    expect(expiring.handshakes).toBe(2);
  });

  it('recorre todas las páginas de tools/list', async () => {
    const paged = fakeMcpServer({
      pages: [[tool('uno', ['safe'])], [tool('dos', ['safe'])], [tool('tres', ['safe'])]],
    });
    const client = new McpHttpClient({ url: 'http://zeus.test/mcp', fetchImpl: paged.fetch });
    // Quedarse con la primera página es servir un catálogo incompleto sin enterarse.
    expect((await client.listTools()).map((one) => one.name)).toEqual(['uno', 'dos', 'tres']);
  });

  it('lee los tags de _meta.fastmcp', async () => {
    const client = new McpHttpClient({ url: 'http://zeus.test/mcp', fetchImpl: server.fetch });
    const tools = await client.listTools();
    expect(tools.find((one) => one.name === 'docker_restart')?.tags).toEqual(['docker', 'write']);
  });

  it('un servidor que no responde da un error de upstream, no uno interno', async () => {
    const client = new McpHttpClient({
      url: 'http://zeus.test/mcp',
      fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    await expect(client.listTools()).rejects.toThrow(/could not reach/i);
  });
});

describe('MCP · el catálogo y sus límites', () => {
  let server: FakeServer;

  beforeEach(() => {
    server = fakeMcpServer();
  });

  it('agrupa por área usando los tags del servidor', async () => {
    const service = buildService(server);
    const areas = Object.fromEntries((await service.areas()).map((entry) => [entry.area, entry.count]));

    expect(areas['docker']).toBe(2);
    expect(areas['camaras']).toBe(1);
    expect(areas['red']).toBe(1);
    // `poweroff_server` y `reboot_server` caen fuera por la denegación por defecto, así que
    // «sistema» sólo tiene el snapshot.
    expect(areas['sistema']).toBe(1);
  });

  it('deniega por defecto lo que no tiene vuelta atrás, aunque nadie lo pida', async () => {
    const service = buildService(server);
    const names = (await service.capabilities()).map((capability) => capability.tool);

    for (const denied of DEFAULT_DENIED_TOOLS) expect(names).not.toContain(denied);
    // Y no es que el servidor no las publique: es que este core no las sirve.
    expect(DEFAULT_TOOLS.map((one) => one['name'])).toContain('poweroff_server');
  });

  it('trata como efecto el tag admin, no sólo write', async () => {
    /*
     * En el servidor de casa las cuatro `admin` —reboot, poweroff y las dos de apt— caen antes por
     * la denegación de fábrica, así que para ver la regla hace falta una que sí llegue. La regla
     * es la que importa: `admin` sin `write` seguiría siendo un efecto, y un clasificador que sólo
     * mirase `write` daría por inofensivo apagar el servidor.
     */
    const conAdmin = fakeMcpServer({
      tools: [tool('rotar_claves', ['system', 'admin']), ...DEFAULT_TOOLS],
    });
    const service = buildService(conAdmin);
    const byName = Object.fromEntries((await service.capabilities()).map((one) => [one.tool, one.writes]));

    expect(byName['rotar_claves']).toBe(true);
    expect(byName['docker_restart']).toBe(true);
    expect(byName['docker_logs']).toBe(false);
  });

  it('una herramienta sin etiquetas se considera con efectos si el servidor puede escribir', async () => {
    const sinTags = fakeMcpServer({ tools: [{ name: 'misterio', description: 'quién sabe', inputSchema: {} }] });
    const abierto = buildService(sinTags, { servers: 'zeus=http://zeus.test/mcp', writeServers: 'zeus' });
    // Falla cerrado: lo que no se sabe, se pide.
    expect((await abierto.capabilities())[0]?.writes).toBe(true);
  });

  it('la allowlist manda sobre lo que publique el servidor', async () => {
    const service = buildService(server, { allow: 'zeus.docker_logs' });
    const capabilities = await service.capabilities();
    expect(capabilities.map((one) => one.tool)).toEqual(['docker_logs']);
    // Y se dice cuántas quedaron fuera: un catálogo recortado no se recorta en silencio.
    expect((await service.states())[0]?.filteredOut).toBe(DEFAULT_TOOLS.length - 1);
  });

  it('busca por nombre antes que por descripción', async () => {
    const service = buildService(server);
    const found = await service.search('docker', 5);
    expect(found[0]?.tool).toMatch(/^docker/);
    // Y devuelve el esquema, porque el paso siguiente es llamar.
    expect(found[0]?.inputSchema).toBeDefined();
  });

  it('el resumen es la primera frase, no el docstring entero', () => {
    const largo = {
      name: 'gpu_status',
      title: null,
      description: 'Ocupación de la iGPU por motor.\n\nUn párrafo larguísimo que explica cosas.',
      inputSchema: {},
      tags: [],
    };
    expect(summarize(largo)).toBe('Ocupación de la iGPU por motor');
  });
});

describe('MCP · ejecutar', () => {
  it('una lectura se ejecuta y queda en la auditoría', async () => {
    const server = fakeMcpServer();
    const service = buildService(server);
    const result = await service.call('docker_logs', { container: 'camwall' }, { actor: 'braian' });

    expect(result.ok).toBe(true);
    expect(result.name).toBe('zeus.docker_logs');
    expect(server.calls.some((call) => call.method === 'tools/call')).toBe(true);
  });

  it('una herramienta con efectos no se ejecuta sin permiso', async () => {
    const service = buildService(fakeMcpServer(), { writeServers: 'zeus' });
    await expect(service.call('docker_restart', {}, { actor: 'braian' }))
      .rejects.toThrow(/hace falta que la persona lo autorice/);
  });

  it('un servidor de sólo lectura no ejecuta una escritura ni con permiso', async () => {
    // El interruptor del core gana al del servidor: no se delega la seguridad de esto en el otro lado.
    const service = buildService(fakeMcpServer());
    await expect(service.call('docker_restart', {}, { actor: 'braian', allowWrites: true }))
      .rejects.toThrow(/sólo lectura/);
  });

  it('con permiso, la escritura sí se ejecuta', async () => {
    const service = buildService(fakeMcpServer(), { writeServers: 'zeus' });
    const result = await service.call('docker_restart', { container: 'camwall' }, { actor: 'braian', allowWrites: true });
    expect(result.ok).toBe(true);
  });

  it('lo que vuelve se acota y dice que se acotó', async () => {
    const server = fakeMcpServer({ callResult: { texto: 'x'.repeat(20_000) } });
    const service = buildService(server);
    const result = await service.call('docker_logs', {}, { actor: 'braian' });

    expect(result.truncated).toBe(true);
    expect(result.originalChars).toBeGreaterThan(1200);
    expect(String(result.content)).toHaveLength(1201); // el recorte más la marca
  });

  it('una capacidad que no existe se distingue de una que falla', async () => {
    const service = buildService(fakeMcpServer());
    await expect(service.call('no_existe', {}, { actor: 'braian' })).rejects.toThrow(/no existe la capacidad/);
  });

  it('un servidor caído deja el catálogo viejo utilizable y lo marca', async () => {
    let vivo = true;
    const server = fakeMcpServer();
    const service = buildService({
      ...server,
      fetch: (url, init) => (vivo ? server.fetch(url, init) : Promise.reject(new Error('ECONNREFUSED'))),
    });

    expect((await service.capabilities()).length).toBeGreaterThan(0);
    vivo = false;
    const states = await service.states();
    // Sigue sabiendo qué había, y no miente sobre que lo acaba de comprobar.
    expect(states[0]?.status).toBe('ok');
    expect(states[0]?.toolCount).toBeGreaterThan(0);
  });
});

describe('MCP · cómo se declara en el entorno', () => {
  it('lee pares nombre=valor y aguanta la basura', () => {
    const pairs = parsePairs(' zeus=http://a/mcp , roto , = , otro=http://b/mcp ');
    expect([...pairs.entries()]).toEqual([['zeus', 'http://a/mcp'], ['otro', 'http://b/mcp']]);
  });

  it('un servidor es de sólo lectura salvo que se le nombre expresamente', () => {
    const [solo] = parseMcpServers({ servers: 'zeus=http://a/mcp' });
    expect(solo?.readOnly).toBe(true);
    const [escribe] = parseMcpServers({ servers: 'zeus=http://a/mcp', writeServers: 'zeus' });
    expect(escribe?.readOnly).toBe(false);
  });

  it('las denegaciones del operador se suman a las de fábrica, no las sustituyen', () => {
    const [zeus] = parseMcpServers({ servers: 'zeus=http://a/mcp', deny: 'zeus.docker_stop' });
    expect(zeus?.deny).toContain('docker_stop');
    for (const denied of DEFAULT_DENIED_TOOLS) expect(zeus?.deny).toContain(denied);
  });

  it('una denegación sin servidor vale para todos', () => {
    const servers = parseMcpServers({ servers: 'a=http://a/mcp,b=http://b/mcp', deny: 'grep_text' });
    for (const server of servers) expect(server.deny).toContain('grep_text');
  });

  it('el token va por servidor y no acaba en la url', () => {
    const [zeus] = parseMcpServers({ servers: 'zeus=http://a/mcp', tokens: 'zeus=secreto' });
    expect(zeus?.token).toBe('secreto');
    expect(zeus?.url).toBe('http://a/mcp');
  });
});

describe('SSE · leer lo que llega', () => {
  const stream = (text: string): ReadableStream<Uint8Array> => new Response(text).body as ReadableStream<Uint8Array>;

  const collect = async (text: string): Promise<Array<{ event: string; data: string }>> => {
    const events = [];
    for await (const event of readSseEvents(stream(text))) events.push({ event: event.event, data: event.data });
    return events;
  };

  it('separa eventos con \\n\\n y con \\r\\n\\r\\n', async () => {
    // El segundo separador es legal y algunos proxys lo imponen; comerse un byte de más deja el
    // siguiente campo llamándose «\rdata», que no casa con nada y se pierde en silencio.
    expect(await collect('data: uno\n\ndata: dos\r\n\r\ndata: tres\n\n'))
      .toEqual([
        { event: 'message', data: 'uno' },
        { event: 'message', data: 'dos' },
        { event: 'message', data: 'tres' },
      ]);
  });

  it('junta las líneas de data y respeta el nombre del evento', async () => {
    expect(await collect('event: chat.message\ndata: {"a":1,\ndata: "b":2}\n\n'))
      .toEqual([{ event: 'chat.message', data: '{"a":1,\n"b":2}' }]);
  });

  it('ignora los comentarios de latido', async () => {
    expect(await collect(': keepalive\n\ndata: real\n\n')).toEqual([{ event: 'message', data: 'real' }]);
  });

  it('entrega el último evento aunque el servidor cierre sin la línea en blanco', async () => {
    expect(await collect('data: final')).toEqual([{ event: 'message', data: 'final' }]);
  });
});


/**
 * Argumentos que el modelo se inventa por analogía.
 *
 * Pasó en el primer turno real en producción: le dio `seconds: 60` a `system_health_snapshot` y
 * `top: 10` a `disk_usage`, ninguna de las cuales recibe nada. No fue aleatorio —en el mismo lote
 * viajaban `cpu_sampled(seconds, top)` y `memory_pressure(top)`— y por eso se repetiría.
 *
 * Es un caso distinto del JSON truncado: aquí los argumentos **parsean perfectamente**, y quien
 * los rechaza es la función que hay al otro lado.
 */
describe('ajustar los argumentos a lo que la herramienta declara', () => {
  const sinParametros = { type: 'object', properties: {}, additionalProperties: false };
  const conParametros = {
    type: 'object',
    properties: { seconds: { type: 'integer' }, top: { type: 'integer' } },
    additionalProperties: false,
  };

  it('quita lo que no está declarado y dice cuál', () => {
    const fitted = fitToSchema({ seconds: 60 }, sinParametros);
    expect(fitted.args).toEqual({});
    expect(fitted.dropped).toEqual(['seconds']);
  });

  it('deja pasar lo declarado y sólo quita lo demás', () => {
    const fitted = fitToSchema({ seconds: 3, top: 6, inventado: 1 }, conParametros);
    expect(fitted.args).toEqual({ seconds: 3, top: 6 });
    expect(fitted.dropped).toEqual(['inventado']);
  });

  it('un esquema sin properties significa «no recibe nada», no «recibe cualquier cosa»', () => {
    // Es lo contrario del defecto de JSON Schema, y a propósito: una tool MCP no valida un
    // documento, llama a una función, y una clave que sobra es un argumento con nombre inexistente.
    expect(fitToSchema({ top: 10 }, { type: 'object' }).dropped).toEqual(['top']);
  });

  it('respeta al servidor que dice expresamente que admite más', () => {
    const abierto = { type: 'object', properties: {}, additionalProperties: true };
    expect(fitToSchema({ lo_que_sea: 1 }, abierto).args).toEqual({ lo_que_sea: 1 });
    expect(fitToSchema({ lo_que_sea: 1 }, abierto).dropped).toEqual([]);
  });

  it('sin esquema no hay nada contra lo que ajustar, y decide el servidor', () => {
    expect(fitToSchema({ a: 1 }, undefined).args).toEqual({ a: 1 });
  });
});

describe('MCP · llamar con argumentos que sobran', () => {
  it('la consulta se hace igual, sin ellos, y el resultado lo cuenta', async () => {
    const server = fakeMcpServer();
    const service = buildService(server);
    // `docker_logs` del servidor falso no declara `seconds`.
    const result = await service.call('docker_logs', { seconds: 60 }, { actor: 'braian' });

    expect(result.ok).toBe(true);
    expect(result.dropped).toEqual(['seconds']);
    // Y al servidor le llegó la llamada limpia, no la que traía el argumento inventado.
    const call = server.calls.find((entry) => entry.method === 'tools/call');
    expect((call?.params as { arguments?: unknown })?.arguments).toEqual({});
  });
});
