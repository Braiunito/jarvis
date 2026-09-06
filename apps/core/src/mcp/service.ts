/**
 * Las capacidades MCP, como caso de uso del core.
 *
 * Éste es el sitio donde ADR-009 se cumple o se incumple. Una herramienta del Assistant no llama a
 * un servidor MCP: llama aquí, y aquí se decide qué existe, qué se puede ejecutar, con qué
 * identidad, cuánto se devuelve y qué queda escrito en la auditoría. Sin esta capa, «el modelo
 * tiene MCP» significa «el modelo tiene un puerto», que es otra cosa y bastante peor.
 *
 * El problema que ordena el diseño es de tamaño, y no se arregla con más contexto. El MCP de Zeus
 * publica 108 herramientas y su catálogo completo ocupa **8294 tokens**, medido con el `/tokenize`
 * del propio llama-server. Con los 4096 de contexto que tenía el modelo al principio no cabía
 * siquiera; con los 16384 de ahora cabe y ocupa la mitad, que es peor negocio de lo que parece.
 *
 * Lo decisivo es el reloj, no el sitio: ofrecerle 10 herramientas le cuesta 26 s elegir, y 40 le
 * cuestan 187 s. No degrada en línea recta. Por eso lo que se ofrece es un **buscador** y no una
 * lista —áreas primero, herramientas de un área después, esquema completo sólo de las que se van a
 * usar—, y por eso los lotes son de ocho o diez.
 */
import type { McpArea, McpCallResult, McpCapability, McpServerState } from '@jarvis/contracts';
import { JarvisError } from '@jarvis/contracts';
import type { ToolDefinition, ToolInputSchema } from '../assistant/types.js';
import type { Clock } from '../platform/clock.js';
import type { AuditLog } from '../platform/audit.js';
import { McpError, McpHttpClient, type FetchLike, type McpToolDescriptor } from './client.js';

/**
 * Un servidor declarado en la configuración. La allowlist no está vacía nunca por accidente:
 * `allow: []` significa «todas las que publique», y eso se escribe a mano sabiendo lo que se hace.
 */
export interface McpServerConfig {
  name: string;
  url: string;
  token?: string | undefined;
  /**
   * Ninguna herramienta con efectos se ejecuta contra este servidor.
   *
   * Es el interruptor de verdad, y por defecto está puesto. El MCP de Zeus ya arranca con
   * `MCP_ENABLE_WRITES=0`, pero apoyarse en eso sería confiar la seguridad de este core a la
   * configuración de otro proceso, en otra máquina, que alguien puede cambiar sin enterarse de que
   * esto existía.
   */
  readOnly: boolean;
  /**
   * Si se sirven sus herramientas sin etiquetar.
   *
   * Por defecto no: una herramienta que no dice si escribe no se puede clasificar, y clasificarla
   * de oído es afirmar algo sobre un proceso que no controlamos.
   */
  trustUntagged: boolean;
  /** Nombres exactos permitidos. Vacío = las que el servidor publique. */
  allow: string[];
  deny: string[];
}

export interface McpServiceDeps {
  servers: McpServerConfig[];
  clock: Clock;
  audit: AuditLog;
  /** Cuánto vale un catálogo antes de volver a pedirlo. Las herramientas no cambian cada minuto. */
  ttlMs?: number;
  /** Tope de lo que una llamada devuelve al modelo. Se recorta diciéndolo (ADR-007). */
  maxOutputChars?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

/**
 * De qué habla cada etiqueta.
 *
 * El orden importa: una herramienta lleva varias etiquetas —`docker_logs` es `docker`, `logs` y
 * `safe`— y el área es la primera que casa. Lo específico va antes que lo general, porque
 * «docker» dice mucho más que «system» sobre dónde buscarla.
 */
const AREA_BY_TAG: ReadonlyArray<readonly [string, McpArea]> = [
  ['camwall', 'camaras'],
  ['docker', 'docker'],
  ['systemd', 'servicios'],
  ['packages', 'paquetes'],
  ['users', 'usuarios'],
  ['network', 'red'],
  ['disk', 'disco'],
  ['filesystem', 'ficheros'],
  ['process', 'procesos'],
  ['gpu', 'sistema'],
  ['kernel', 'sistema'],
  ['system', 'sistema'],
  ['diagnostic', 'sistema'],
  ['security', 'sistema'],
  ['meta', 'otras'],
  ['sessions', 'sesiones'],
];

/**
 * Para servidores que no etiquetan nada, el nombre es lo único que hay.
 *
 * Es peor que las etiquetas y por eso va después, pero un servidor sin `_meta` no puede dejar el
 * catálogo entero en «otras»: un área que lo contiene todo no ayuda a buscar.
 */
const AREA_BY_PREFIX: ReadonlyArray<readonly [RegExp, McpArea]> = [
  [/^(camwall|cam_)/, 'camaras'],
  [/^docker/, 'docker'],
  [/(service|systemd|journal|unit)/, 'servicios'],
  [/^(package|apt)/, 'paquetes'],
  [/(login|user|ssh)/, 'usuarios'],
  [/^(ip_|dns|net|routing|arp|listening|established|socket|ping|tcp_|http_|interface|wifi)/, 'red'],
  [/(disk|inode|block_device|mount|smart)/, 'disco'],
  [/(file|directory|stat_path|grep_text|read_text|tail_text|largest)/, 'ficheros'],
  [/(process|pid|top_cpu|top_memory)/, 'procesos'],
  [/^(session|search_session|list_session|get_session|resume|index_stats|sync_host|list_hosts)/, 'sesiones'],
];

/**
 * Etiquetas que significan «esto tiene efectos».
 *
 * `admin` está aquí y no es un detalle: en el MCP de Zeus, `reboot_server` y `poweroff_server`
 * llevan `admin` y **no** llevan `write`. Un clasificador que sólo mirase `write` daría por
 * inofensivo apagar el servidor.
 */
const EFFECT_TAGS = new Set(['write', 'admin', 'destructive']);
/** Etiquetas que un servidor usa para decir «esto sólo mira». Se exigen para considerar algo seguro. */
const READ_TAGS = new Set(['safe', 'read', 'readonly']);

interface CachedCatalog {
  at: number;
  tools: McpToolDescriptor[];
  filteredOut: number;
  /** Las que no dicen qué hacen y por eso no se sirven. Ver `#catalogOf`. */
  untagged: number;
}

interface ServerRuntime {
  config: McpServerConfig;
  client: McpHttpClient;
  catalog: CachedCatalog | null;
  inflight: Promise<CachedCatalog> | null;
  lastOkAt: string | null;
  lastError: string | null;
}

export class McpService {
  readonly #runtimes: ServerRuntime[];
  readonly #clock: Clock;
  readonly #audit: AuditLog;
  readonly #ttlMs: number;
  readonly #maxOutputChars: number;

  constructor(deps: McpServiceDeps) {
    this.#clock = deps.clock;
    this.#audit = deps.audit;
    this.#ttlMs = deps.ttlMs ?? 10 * 60 * 1000;
    this.#maxOutputChars = deps.maxOutputChars ?? 1200;
    this.#runtimes = deps.servers.map((config) => ({
      config,
      client: new McpHttpClient({
        url: config.url,
        token: config.token,
        ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      }),
      catalog: null,
      inflight: null,
      lastOkAt: null,
      lastError: null,
    }));
  }

  /** Si no hay servidores, el asistente no ofrece capacidades que no existen. */
  get configured(): boolean { return this.#runtimes.length > 0; }

  get serverNames(): string[] { return this.#runtimes.map((runtime) => runtime.config.name); }

  // ---- catálogo -----------------------------------------------------------

  /**
   * Todas las capacidades visibles, ya filtradas por la allowlist.
   *
   * Un servidor caído no vacía el catálogo de los demás: se devuelve lo que hay y su estado se
   * cuenta aparte, en `states()`. La alternativa —fallar entero— convierte la avería de una
   * máquina en la desaparición de todas.
   */
  async capabilities({ schema = false }: { schema?: boolean } = {}): Promise<McpCapability[]> {
    const all: McpCapability[] = [];
    for (const runtime of this.#runtimes) {
      let catalog: CachedCatalog;
      try {
        catalog = await this.#catalogOf(runtime);
      } catch {
        continue;
      }
      for (const tool of catalog.tools) all.push(this.#toCapability(runtime, tool, { schema }));
    }
    return all;
  }

  /**
   * Las capacidades como herramientas que el modelo llama **por su nombre**.
   *
   * Es la alternativa al router, y con un modelo capaz es mejor por un motivo que no es la
   * velocidad: si la capacidad es una función declarada, el modelo **no puede inventarse el
   * nombre**. La API sólo acepta los que se le dieron. Toda una clase de fallos —`zeus.processes`,
   * `zeus.network_stats`, `check_ram_status`— deja de existir en vez de gestionarse.
   *
   * Medido contra gpt-5-nano con el catálogo entero delante: 1553 ms y acertó a la primera, contra
   * las dos vueltas que cuesta buscar. Y el catálogo completo son unos 5300 tokens de entrada, que
   * a $0,05 el millón es un cuarto de milésima de dólar por llamada.
   *
   * El nombre se aplana porque la API sólo admite `[A-Za-z0-9_-]`: `zeus.memory_info` no vale y
   * `mcp__zeus__memory_info` sí. El prefijo evita además que dos servidores con la misma
   * herramienta se pisen.
   */
  async asToolDefinitions(): Promise<Array<{ definition: ToolDefinition; capability: McpCapability }>> {
    /*
     * Con esquema, y aquí está el matiz que faltaba.
     *
     * `capabilities()` no lo pide, así que en modo directo el modelo veía las 108 capacidades
     * **sin un solo parámetro**: `docker_restart` sin `container`, `grep_text` sin patrón. Llamaba
     * sin argumentos, el servidor rechazaba y se perdía la vuelta. La enmienda de ADR-009 dice que
     * en directo «elige a la primera y no puede inventarse un nombre»; sin el esquema eso valía
     * para el nombre y no para lo que hay que pasarle.
     *
     * Y la descripción es la larga, no el resumen: en directo el modelo **nunca busca**, así que
     * la única ocasión de contarle qué hace la herramienta es ésta. El catálogo pasa de unos 5.300
     * tokens a unos 9.000, que a las tarifas de este escalón es una milésima de dólar por vuelta.
     */
    return (await this.capabilities({ schema: true })).map((capability) => ({
      capability,
      definition: {
        name: qualifiedToolName(capability),
        description: describe(capability),
        inputSchema: toInputSchema(capability.inputSchema),
        // Ejecutar una capacidad es una observación; lo que decide el turno son las otras.
        decides: false,
      },
    }));
  }

  /** Cuántas capacidades hay, sin traerlas. Para la interfaz, que sólo quiere el número. */
  async count(): Promise<number> {
    return (await this.capabilities()).length;
  }

  /**
   * Las áreas y cuánto hay en cada una.
   *
   * Es el primer paso del router y lo más barato que se le puede enseñar a un modelo pequeño:
   * doce líneas contra las 108 herramientas que no le caben.
   */
  async areas(): Promise<Array<{ area: McpArea; count: number }>> {
    const counts = new Map<McpArea, number>();
    for (const capability of await this.capabilities()) {
      counts.set(capability.area, (counts.get(capability.area) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([area, count]) => ({ area, count }))
      .sort((a, b) => b.count - a.count);
  }

  /** Las de un área, con resumen corto y sin esquema: sirve para elegir, no para llamar. */
  async byArea(area: McpArea, limit = 30): Promise<McpCapability[]> {
    return (await this.capabilities()).filter((capability) => capability.area === area).slice(0, limit);
  }

  /**
   * Búsqueda por texto sobre nombre y descripción.
   *
   * Devuelve **con esquema**, porque quien busca ya sabe lo que quiere y el paso siguiente es
   * llamar. Ahorra un viaje entero al modelo, que a 7,5 tokens por segundo son diez segundos.
   */
  async search(query: string, limit = 8): Promise<McpCapability[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const scored: Array<{ capability: McpCapability; score: number }> = [];

    for (const runtime of this.#runtimes) {
      let catalog: CachedCatalog;
      try {
        catalog = await this.#catalogOf(runtime);
      } catch {
        continue;
      }
      for (const tool of catalog.tools) {
        const name = tool.name.toLowerCase();
        const description = tool.description.toLowerCase();
        let score = 0;
        for (const term of terms) {
          // El nombre pesa más que la descripción: quien escribe «docker» quiere `docker_*`, no
          // las quince herramientas que mencionan Docker de pasada en su explicación.
          if (name.includes(term)) score += name === term ? 12 : 6;
          else if (tool.tags.some((tag) => tag.toLowerCase().includes(term))) score += 3;
          else if (description.includes(term)) score += 1;
        }
        if (score > 0) scored.push({ capability: this.#toCapability(runtime, tool, { schema: true }), score });
      }
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((entry) => entry.capability);
  }

  /** Capacidades concretas por nombre, con esquema. Para el lote de arranque y para `describe`. */
  async describe(names: readonly string[]): Promise<McpCapability[]> {
    const wanted = new Set(names);
    const found: McpCapability[] = [];
    for (const runtime of this.#runtimes) {
      let catalog: CachedCatalog;
      try {
        catalog = await this.#catalogOf(runtime);
      } catch {
        continue;
      }
      for (const tool of catalog.tools) {
        const qualified = `${runtime.config.name}.${tool.name}`;
        if (wanted.has(qualified) || wanted.has(tool.name)) {
          found.push(this.#toCapability(runtime, tool, { schema: true }));
        }
      }
    }
    return found;
  }

  // ---- ejecución ----------------------------------------------------------

  /**
   * Ejecuta una capacidad.
   *
   * `allowWrites` no lo decide el modelo ni el servidor: viene de quien llama, que sabe si hay una
   * aprobación detrás. Sin ella, una herramienta con efectos se rechaza con un error que se puede
   * leer —y que le dice al modelo cómo pedirla bien— en vez de con un fallo genérico.
   */
  async call(
    name: string,
    args: Record<string, unknown>,
    { actor, allowWrites = false, workspaceId }: {
      actor: string;
      allowWrites?: boolean;
      workspaceId?: string | undefined;
    },
  ): Promise<McpCallResult> {
    const started = this.#clock.nowMs();
    const resolved = await this.#resolve(name);
    if (!resolved) {
      throw new JarvisError('NOT_FOUND', `no existe la capacidad ${name}`, { scope: { capability: name } });
    }
    const { runtime, tool } = resolved;
    const writes = effectsOf(tool, runtime.config);

    if (writes && runtime.config.readOnly) {
      throw new JarvisError('FORBIDDEN',
        `${name} tiene efectos y ${runtime.config.name} está declarado de sólo lectura en este core`,
        { scope: { capability: name, server: runtime.config.name } });
    }
    if (writes && !allowWrites) {
      throw new JarvisError('FORBIDDEN',
        `${name} tiene efectos sobre la máquina: pídelo con request_capability y lo autoriza una persona`,
        { scope: { capability: name } });
    }

    /*
     * Los argumentos se ajustan al esquema **antes** de salir.
     *
     * Visto en el primer turno real en producción: el modelo le pasó `seconds: 60` a
     * `system_health_snapshot` y `top: 10` a `disk_usage`, y ninguna de las dos recibe argumentos.
     * No fue aleatorio y por eso importa: en el lote de arranque conviven `cpu_sampled(seconds,
     * top)` y `memory_pressure(top)`, y les pegó por analogía los parámetros de sus vecinas. Un
     * fallo por analogía se repite.
     *
     * Se arregla aquí y no pidiéndole al modelo que se fije, porque ya se le dice: el catálogo que
     * ve pone «sin parámetros» en esas dos. Decírselo mejor no lo va a arreglar; quitarle la
     * ocasión, sí.
     */
    const { args: safeArgs, dropped } = fitToSchema(args, tool.inputSchema);

    /*
     * Una escritura se apunta **antes** de intentarla.
     *
     * La auditoría de abajo va después del `try`, así que una escritura que el servidor rechaza no
     * dejaba rastro —y una que triunfa y se lleva el core por delante antes de apuntar, tampoco—.
     * Lo que hace falta registrar no es sólo lo que pasó: es lo que se intentó, que es la pregunta
     * que se hace quien investiga.
     */
    if (writes) {
      this.#audit.record({
        actorUser: actor,
        eventType: 'mcp.write.requested',
        ...(workspaceId ? { workspaceId } : {}),
        payload: {
          capability: `${runtime.config.name}.${tool.name}`,
          args: JSON.stringify(args).slice(0, 500),
        },
      });
    }

    let result;
    try {
      result = await runtime.client.callTool(tool.name, safeArgs);
      runtime.lastOkAt = this.#clock.nowIso();
      runtime.lastError = null;
    } catch (error) {
      runtime.lastError = (error as Error).message;
      if (writes) {
        this.#audit.record({
          actorUser: actor,
          eventType: 'mcp.write.failed',
          ...(workspaceId ? { workspaceId } : {}),
          payload: {
            capability: `${runtime.config.name}.${tool.name}`,
            error: (error as Error).message.slice(0, 300),
          },
        });
      }
      throw asJarvisError(error, name, runtime.config.name);
    }

    /*
     * La auditoría se escribe siempre, y con los argumentos.
     *
     * Es lo que separa esto de «el modelo tiene un puerto abierto»: dentro de un mes se puede
     * decir quién miró los logs de qué contenedor y cuándo. Los argumentos van serializados y
     * acotados, porque un `grep_text` puede traer un patrón enorme.
     */
    this.#audit.record({
      actorUser: actor,
      eventType: writes ? 'mcp.write' : 'mcp.read',
      ...(workspaceId ? { workspaceId } : {}),
      payload: {
        capability: `${runtime.config.name}.${tool.name}`,
        args: JSON.stringify(args).slice(0, 500),
        ok: !result.isError,
      },
    });

    const serialized = typeof result.content === 'string'
      ? result.content
      : JSON.stringify(result.content ?? null);
    const truncated = serialized.length > this.#maxOutputChars;

    return {
      ok: !result.isError,
      name: `${runtime.config.name}.${tool.name}`,
      content: truncated ? `${serialized.slice(0, this.#maxOutputChars)}…` : result.content,
      truncated,
      ...(truncated ? { originalChars: serialized.length } : {}),
      // Se dice lo que se quitó. Alterar en silencio lo que alguien pidió es cómo se acaba
      // concluyendo sobre una consulta que no fue la que se hizo.
      ...(dropped.length ? { dropped } : {}),
      durationMs: this.#clock.nowMs() - started,
    };
  }

  // ---- salud --------------------------------------------------------------

  /**
   * El estado de cada servidor, sondeándolo si hace falta.
   *
   * Se llama desde Salud, así que un servidor caído tiene que dar `failed` y no una excepción: la
   * pantalla que informa de una avería no puede caerse por la avería que informa.
   */
  async states(): Promise<McpServerState[]> {
    const states: McpServerState[] = [];
    for (const runtime of this.#runtimes) {
      try {
        const catalog = await this.#catalogOf(runtime);
        /*
         * Servir el catálogo viejo está bien; decir que todo va bien, no.
         *
         * `#catalogOf` devuelve lo cacheado cuando el refresco falla —y hace bien: el modelo sigue
         * sabiendo qué existe— pero entraba por la rama de éxito, así que Salud pintaba `ok` con el
         * servidor caído y `lastError` a `null`. Nadie veía por qué las capacidades empezaban a
         * fallar al llamarlas. Servir viejo y decir que es viejo es la regla de esta casa (ADR-007);
         * lo que faltaba era la segunda mitad.
         */
        const caducado = this.#clock.nowMs() - catalog.at >= this.#ttlMs;
        const stale = runtime.lastError !== null || caducado;
        states.push({
          name: runtime.config.name,
          url: runtime.config.url,
          status: stale ? 'stale' : 'ok',
          toolCount: catalog.tools.length,
          filteredOut: catalog.filteredOut,
          untagged: catalog.untagged,
          writesAllowed: !runtime.config.readOnly,
          authenticated: runtime.client.authenticated,
          lastOkAt: runtime.lastOkAt,
          lastError: runtime.lastError,
          serverInfo: runtime.client.serverInfo,
        });
      } catch (error) {
        states.push({
          name: runtime.config.name,
          url: runtime.config.url,
          // Un catálogo viejo sigue sirviendo si se dice que es viejo: `stale` distingue «se cayó
          // hace un momento y sé lo que tenía» de «nunca contestó».
          status: runtime.catalog ? 'stale' : 'failed',
          toolCount: runtime.catalog?.tools.length ?? 0,
          filteredOut: runtime.catalog?.filteredOut ?? 0,
          untagged: runtime.catalog?.untagged ?? 0,
          writesAllowed: !runtime.config.readOnly,
          authenticated: runtime.client.authenticated,
          lastOkAt: runtime.lastOkAt,
          lastError: (error as Error).message,
          serverInfo: runtime.client.serverInfo,
        });
      }
    }
    return states;
  }

  // ---- interno ------------------------------------------------------------

  async #resolve(name: string): Promise<{ runtime: ServerRuntime; tool: McpToolDescriptor } | null> {
    // `servidor.herramienta` es la forma cualificada; el nombre a secas vale mientras no haya dos
    // servidores que publiquen lo mismo, que es lo normal cuando sólo hay uno.
    const dot = name.indexOf('.');
    const server = dot > 0 ? name.slice(0, dot) : null;
    const bare = dot > 0 ? name.slice(dot + 1) : name;

    for (const runtime of this.#runtimes) {
      if (server && runtime.config.name !== server) continue;
      let catalog: CachedCatalog;
      try {
        catalog = await this.#catalogOf(runtime);
      } catch {
        continue;
      }
      const tool = catalog.tools.find((candidate) => candidate.name === bare);
      if (tool) return { runtime, tool };
    }
    return null;
  }

  async #catalogOf(runtime: ServerRuntime): Promise<CachedCatalog> {
    const fresh = runtime.catalog && this.#clock.nowMs() - runtime.catalog.at < this.#ttlMs;
    if (fresh && runtime.catalog) return runtime.catalog;
    // Varias herramientas del mismo turno piden el catálogo casi a la vez; sin esto, cada una
    // abriría su propio `tools/list` contra el servidor por el mismo dato.
    if (runtime.inflight) return runtime.inflight;

    const inflight = (async (): Promise<CachedCatalog> => {
      const published = await runtime.client.listTools();
      const allowed = published.filter((tool) => isAllowed(tool.name, runtime.config));
      /*
       * Lo que no dice qué hace, no se sirve.
       *
       * `effectsOf` daba por lectura una herramienta sin etiquetar en un servidor declarado de sólo
       * lectura, con el argumento de que ahí no hay daño posible. Pero `readOnly` es un interruptor
       * **de este core**, y quien decide si el servidor ejecuta es el servidor: si al otro lado
       * encienden las escrituras, ese «no hay daño posible» se convierte en un efecto sin tarjeta.
       * Estamos afirmando algo sobre un proceso que no controlamos.
       *
       * Así que se quedan fuera del catálogo, que es más honesto que ofrecerlas como lectura. Se
       * pueden recuperar por servidor con `JARVIS_MCP_TRUST_UNTAGGED`, que es donde alguien declara
       * —a mano y por escrito— que conoce ese servidor y responde por él.
       *
       * Sólo en los de sólo lectura. En uno con escrituras, `effectsOf` ya trata lo sin etiquetar
       * como si escribiera, así que pasa por tarjeta y esa protección sí funciona: quitarlas del
       * catálogo ahí sería cambiar «se pregunta» por «no existe», que es peor.
       *
       * Con el catálogo de esta casa no quita ninguna: las 112 de Zeus están etiquetadas. Es
       * protección latente, como la de ADR-010 §4, y por el mismo motivo se escribe aquí: para que
       * dentro de un año nadie la borre por «no hace nada».
       */
      const conocidas = runtime.config.trustUntagged || !runtime.config.readOnly
        ? allowed
        : allowed.filter((tool) => effectsDeclaredBy(tool));
      const catalog: CachedCatalog = {
        at: this.#clock.nowMs(),
        tools: conocidas,
        filteredOut: published.length - allowed.length,
        untagged: allowed.length - conocidas.length,
      };
      runtime.catalog = catalog;
      runtime.lastOkAt = this.#clock.nowIso();
      runtime.lastError = null;
      return catalog;
    })();

    runtime.inflight = inflight;
    try {
      return await inflight;
    } catch (error) {
      runtime.lastError = (error as Error).message;
      // Un catálogo viejo vale más que ninguno cuando el servidor se acaba de caer: el modelo
      // sigue sabiendo qué existe, y la llamada fallará con su propio error si de verdad no está.
      if (runtime.catalog) return runtime.catalog;
      throw error;
    } finally {
      if (runtime.inflight === inflight) runtime.inflight = null;
    }
  }

  #toCapability(
    runtime: ServerRuntime,
    tool: McpToolDescriptor,
    { schema = false }: { schema?: boolean } = {},
  ): McpCapability {
    return {
      name: `${runtime.config.name}.${tool.name}`,
      server: runtime.config.name,
      tool: tool.name,
      area: areaOf(tool),
      summary: summarize(tool),
      writes: effectsOf(tool, runtime.config),
      effectsDeclared: effectsDeclaredBy(tool),
      ...(schema ? { description: tool.description, inputSchema: tool.inputSchema } : {}),
    };
  }
}

/**
 * El resumen de una herramienta: su primera frase.
 *
 * Las descripciones largas son buenas cuando el modelo ya eligió —`gpu_status` explica en un
 * párrafo cómo distinguir un transcode por VAAPI de uno por software, y eso es justo lo que hace
 * que interprete bien el resultado— y son ruinosas cuando sólo hay que elegir: 241 tokens por
 * herramienta, y son 108. Corta para elegir, completa para usar.
 */
export function summarize(tool: McpToolDescriptor, max = 120): string {
  const first = tool.description.split(/\n\s*\n|\.\s|\n/)[0]?.trim() ?? '';
  const text = first || tool.title || tool.name;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function areaOf(tool: McpToolDescriptor): McpArea {
  const tags = new Set(tool.tags.map((tag) => tag.toLowerCase()));
  for (const [tag, area] of AREA_BY_TAG) {
    if (tags.has(tag)) return area;
  }
  const name = tool.name.toLowerCase();
  for (const [pattern, area] of AREA_BY_PREFIX) {
    if (pattern.test(name)) return area;
  }
  return 'otras';
}

/**
 * Si una herramienta tiene efectos.
 *
 * Falla cerrado a propósito: se considera que escribe salvo que el servidor diga expresamente que
 * no. Un servidor que no etiqueta nada acaba con todo su catálogo detrás de una aprobación, que es
 * incómodo y correcto; al revés —dar por seguro lo que no se sabe— es como se ejecuta un
 * `poweroff` creyendo que se estaba leyendo un log.
 */
/**
 * Si el servidor dijo lo que hace la herramienta, en vez de dejar que se infiera.
 *
 * Es la mitad que `effectsOf` no puede devolver sin mentir: `writes: true` significa dos cosas muy
 * distintas —«el servidor la etiquetó `write`» y «nadie la etiquetó y estamos siendo prudentes»— y
 * hay una decisión, la del modo de autonomía más suelto, que depende de cuál de las dos es.
 */
function effectsDeclaredBy(tool: McpToolDescriptor): boolean {
  const tags = tool.tags.map((tag) => tag.toLowerCase());
  return tags.some((tag) => EFFECT_TAGS.has(tag) || READ_TAGS.has(tag));
}

function effectsOf(tool: McpToolDescriptor, config: McpServerConfig): boolean {
  const tags = tool.tags.map((tag) => tag.toLowerCase());
  if (tags.some((tag) => EFFECT_TAGS.has(tag))) return true;
  if (tags.some((tag) => READ_TAGS.has(tag))) return false;
  // Sin etiquetas que lo aclaren: en un servidor de sólo lectura no hay daño posible, así que se
  // deja pasar como lectura; en uno con escrituras habilitadas, se exige aprobación.
  return !config.readOnly;
}

/**
 * Deja los argumentos en lo que la herramienta declara aceptar.
 *
 * La regla es estricta por defecto, al revés que JSON Schema, y es a propósito: una herramienta
 * MCP no valida un documento, **llama a una función**, y las claves que sobran acaban como
 * argumentos con nombre que no existen. El servidor de casa contesta a eso con
 * `unexpected_keyword_argument` y pierde la vuelta entera. Sólo se dejan pasar las claves no
 * declaradas cuando el esquema dice expresamente que admite más (`additionalProperties`), que es
 * la única forma de saber que al otro lado hay algo capaz de recibirlas.
 *
 * Un esquema sin `properties` significa «no recibe nada», no «recibe cualquier cosa».
 */
export function fitToSchema(
  args: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
): { args: Record<string, unknown>; dropped: string[] } {
  const properties = schema?.['properties'] as Record<string, unknown> | undefined;
  const additional = schema?.['additionalProperties'];
  // Sin esquema no hay nada contra lo que ajustar; se pasa tal cual y que decida el servidor.
  if (!schema || additional === true || (additional && typeof additional === 'object')) {
    return { args, dropped: [] };
  }

  const declared = new Set(Object.keys(properties ?? {}));
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (declared.has(key)) kept[key] = value;
    else dropped.push(key);
  }
  return { args: kept, dropped };
}

/** `mcp__servidor__herramienta`: plano, único y dentro de lo que la API admite como nombre. */
export function qualifiedToolName(capability: { server: string; tool: string }): string {
  return `mcp__${capability.server}__${capability.tool}`.replace(/[^A-Za-z0-9_-]/g, '_');
}


/**
 * El esquema del servidor, en la forma que espera la API del modelo.
 *
 * Un esquema vacío se manda igualmente como objeto sin propiedades: omitirlo hace que algunos
 * proveedores rechacen la función, y decir «no recibe nada» es además la información correcta.
 */
/**
 * El esquema tal como hay que enseñárselo al modelo.
 *
 * Se conserva `required` —sin él, «llama sin argumentos» es una lectura válida del esquema— y
 * `additionalProperties`, que es lo único que le dice a `fitToSchema` si la herramienta admite algo
 * más de lo que declara. Las `properties` viajan enteras, con su `description` y su `enum`: es lo
 * que separa acertar a la primera de acertar a la tercera.
 */
function toInputSchema(schema: unknown): ToolInputSchema {
  const object = schema as {
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: unknown;
  } | null;
  return {
    type: 'object',
    properties: object?.properties ?? {},
    ...(object?.required?.length ? { required: object.required } : {}),
    ...(object?.additionalProperties !== undefined
      ? { additionalProperties: object.additionalProperties as boolean }
      : {}),
  };
}

/**
 * Lo que el modelo lee para decidir si esta herramienta es la que quiere.
 *
 * En modo directo no hay una segunda oportunidad: no existe `search_capabilities` ni un `describe`
 * por el que preguntar. Así que va la descripción del servidor entera y acotada, y sólo se cae al
 * resumen corto cuando el servidor no dio ninguna.
 */
const DIRECT_DESCRIPTION_CHARS = 600;

function describe(capability: McpCapability): string {
  const full = (capability.description ?? '').trim();
  if (!full) return capability.summary;
  return full.length > DIRECT_DESCRIPTION_CHARS
    ? `${full.slice(0, DIRECT_DESCRIPTION_CHARS - 1)}…`
    : full;
}

/**
 * Qué clase de fallo fue, que decide si tiene sentido volver a intentarlo.
 *
 * Todo iba al mismo saco —`UPSTREAM_UNAVAILABLE` con `retryable: true`, con un ternario que
 * devolvía lo mismo por las dos ramas— y el toolbox le añadía «puede funcionar si se reintenta».
 * Así, un argumento inválido o una ruta fuera de las raíces permitidas le decían al modelo que
 * insistiera, y el modelo insistía hasta agotar el turno. «Reintenta» es una promesa, y hacerla
 * sobre algo que no depende del momento es mandarle a dar vueltas.
 */
function asJarvisError(error: unknown, name: string, server: string): JarvisError {
  const scope = { capability: name, server };
  const message = (error as Error).message;
  if (error instanceof McpError) {
    // Lo dijo la herramienta, no el transporte: el argumento está mal, la ruta no se puede leer,
    // falta un parámetro. Repetir lo mismo da lo mismo.
    if (error.code === 'MCP_TOOL_ERROR') {
      return new JarvisError('BAD_REQUEST', `${name} rechazó la llamada: ${message}`,
        { scope, retryable: false });
    }
    if (error.code === 'MCP_UNAUTHORIZED') {
      return new JarvisError('FORBIDDEN',
        `${server} rechazó la credencial de este core`, { scope, retryable: false });
    }
  }
  // Lo demás sí es el servidor: caído, lento o inalcanzable. Ahí reintentar sí puede cambiar algo.
  return new JarvisError('UPSTREAM_UNAVAILABLE', `la capacidad ${name} falló: ${message}`,
    { scope, retryable: true });
}

function isAllowed(name: string, config: McpServerConfig): boolean {
  if (config.deny.includes(name)) return false;
  return config.allow.length === 0 || config.allow.includes(name);
}
