/** Configuración del core. Todo lo que el core puede tocar se declara aquí. */
const env = process.env;
const bool = (value: string | undefined, fallback: boolean): boolean =>
  value === undefined ? fallback : /^(1|true|yes|on)$/i.test(value);
const list = (value: string | undefined): string[] =>
  value ? value.split(',').map((s) => s.trim()).filter(Boolean) : [];

const bastionHost = env['JARVIS_BASTION_HOST'] || 'bastion';

export const config = {
  bind: env['JARVIS_CORE_BIND'] || '0.0.0.0',
  port: Number(env['JARVIS_CORE_PORT'] || 8770),

  /** Base operativa. Un fichero local del nodo: nunca en NFS ni compartido (ADR-002). */
  database: env['JARVIS_CORE_DB'] || '/var/lib/jarvis-core/core.db',

  /**
   * Los hosts que este core puede alcanzar. Nunca vacío: sin JARVIS_HOSTS es el bastión y nada
   * más, porque una allowlist es la diferencia entre una herramienta acotada y ejecución remota
   * arbitraria.
   */
  hosts: list(env['JARVIS_HOSTS']).length ? list(env['JARVIS_HOSTS']) : [bastionHost],
  bastionHost,
  sshCommand: env['JARVIS_SSH_COMMAND'] || 'ssh',
  sshOptions: list(env['JARVIS_SSH_OPTIONS']),
  knownHostsFile: env['JARVIS_KNOWN_HOSTS_FILE'] || '/tmp/jarvis-known-hosts',
  remotePath: env['JARVIS_REMOTE_PATH']
    || '$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.bun/bin:$HOME/bin:/usr/local/bin',

  /** Secreto con el que el gateway firma la identidad del usuario (ADR-001). */
  internalSecret: env['JARVIS_INTERNAL_SECRET'] || '',
  internalSecretFile: env['JARVIS_INTERNAL_SECRET_FILE'] || '/var/lib/jarvis/internal.key',

  /** Índice de sesiones. Solo lectura y reconstruible: nunca fuente de verdad de runs. */
  indexUrl: env['JARVIS_INDEX_URL'] || 'http://aisessions:8765',
  indexToken: env['JARVIS_INDEX_TOKEN'] || '',
  indexTimeoutMs: Number(env['JARVIS_INDEX_TIMEOUT_MS'] || 10_000),

  /** Raíz absoluta de los spools de run en el host de ejecución. */
  spoolRoot: env['JARVIS_SPOOL_ROOT'] || '$HOME/.local/state/jarvis/runs',
  attachmentRoot: env['JARVIS_ATTACHMENT_ROOT'] || '/tmp/jarvis-attachments',

  defaultPermissionProfile: (env['JARVIS_DEFAULT_PROFILE'] || 'safe') as 'safe' | 'auto' | 'yolo',
  /** Negarse a correr en este perfil salvo que el operador lo permita explícitamente. */
  allowYolo: bool(env['JARVIS_ALLOW_YOLO'], false),

  maxConcurrentRuns: Number(env['JARVIS_MAX_CONCURRENT_RUNS'] || 4),
  runTimeoutMs: Number(env['JARVIS_RUN_TIMEOUT_MS'] || 4 * 60 * 60 * 1000),
  /** Cuánto se le da a un run interrumpido para parar por las buenas antes de matarlo. */
  interruptGraceMs: Number(env['JARVIS_INTERRUPT_GRACE_MS'] || 5000),
  /**
   * Cuánto se espera antes de dar por perdido un trabajo cuya tmux ya no está.
   *
   * Es un margen para el arranque a medias y para un sondeo que llega entre dos escrituras, no una
   * política: pasado eso, seguir diciendo «en marcha» es afirmar algo que ya no es verdad.
   */
  lostGraceMs: Number(env['JARVIS_LOST_GRACE_MS'] || 15_000),
  /** Cada cuánto el core mira el spool de un run vivo. */
  pollIntervalMs: Number(env['JARVIS_POLL_INTERVAL_MS'] || 700),
  pollChunkBytes: Number(env['JARVIS_POLL_CHUNK_BYTES'] || 512 * 1024),

  /**
   * Limpieza de spools en las máquinas de la flota.
   *
   * Lo que queda en un host tras un trabajo son ficheros de trabajo, no el registro —ese vive en
   * la base del core—, así que se pueden borrar pasado un tiempo. Sin esto, el disco de cada
   * servidor crece para siempre.
   */
  sweepIntervalMs: Number(env['JARVIS_SWEEP_INTERVAL_MS'] || 6 * 60 * 60 * 1000),
  spoolRetentionDays: Number(env['JARVIS_SPOOL_RETENTION_DAYS'] || 7),

  /**
   * Retención de eventos en la base del core (ADR-007).
   *
   * Lo que pesa del event log no es la historia —quién ejecutó qué y cómo acabó— sino las
   * salidas de herramienta y los volcados crudos, que dejan de mirarse a los pocos días. A los
   * 7 se sustituyen por su huella y un resumen; a los 30 queda sólo el esqueleto del trabajo.
   */
  eventCompactAfterDays: Number(env['JARVIS_EVENT_COMPACT_AFTER_DAYS'] || 7),
  eventDropAfterDays: Number(env['JARVIS_EVENT_DROP_AFTER_DAYS'] || 30),
  eventSummaryChars: Number(env['JARVIS_EVENT_SUMMARY_CHARS'] || 200),
  retentionIntervalMs: Number(env['JARVIS_RETENTION_INTERVAL_MS'] || 6 * 60 * 60 * 1000),

  capabilityTtlMs: Number(env['JARVIS_CAPABILITY_TTL_MS'] || 10 * 60 * 1000),
  usageTtlMs: Number(env['JARVIS_USAGE_TTL_MS'] || 5 * 60 * 1000),
  usageProbeTimeoutMs: Number(env['JARVIS_USAGE_PROBE_TIMEOUT_MS'] || 20_000),

  attachmentMaxBytes: Number(env['JARVIS_ATTACHMENT_MAX_BYTES'] || 20 * 1024 * 1024),
  attachmentQuotaBytes: Number(env['JARVIS_ATTACHMENT_QUOTA_BYTES'] || 50 * 1024 * 1024),
  attachmentTtlMs: Number(env['JARVIS_ATTACHMENT_TTL_MS'] || 6 * 3600 * 1000),

  /** Presupuestos de payload por evento (ADR-007). Nada se recorta en silencio. */
  maxToolOutputBytes: Number(env['JARVIS_MAX_TOOL_OUTPUT_BYTES'] || 32 * 1024),
  maxEventTextBytes: Number(env['JARVIS_MAX_EVENT_TEXT_BYTES'] || 256 * 1024),

  /**
   * Servidores MCP que este core **consume** (ADR-009).
   *
   * Se declaran con un formato pobre a propósito —`nombre=url`, separados por comas— porque un
   * JSON dentro de una variable de Compose se escapa mal y el día que le falte una coma el core
   * arranca sin capacidades y sin decir por qué. La interpretación vive en `mcp/config.ts`.
   */
  mcpServers: env['JARVIS_MCP_SERVERS'] || '',
  mcpTokens: env['JARVIS_MCP_TOKENS'] || '',
  /**
   * Qué servidores pueden ejecutar herramientas con efectos. Vacío por defecto, y no por prudencia
   * decorativa: un MCP de sistema puede parar contenedores y reiniciar servicios.
   */
  mcpWriteServers: env['JARVIS_MCP_WRITE_SERVERS'] || '',
  mcpAllow: env['JARVIS_MCP_ALLOW'] || '',
  mcpDeny: env['JARVIS_MCP_DENY'] || '',
  mcpTtlMs: Number(env['JARVIS_MCP_TTL_MS'] || 10 * 60 * 1000),
  mcpTimeoutMs: Number(env['JARVIS_MCP_TIMEOUT_MS'] || 20_000),
  /**
   * Cuánto de una respuesta del MCP llega al modelo.
   *
   * Es **el ajuste que más se nota en la conversación**, y no por lo que cuesta traerlo sino por lo
   * que cuesta leerlo. Medido contra el servidor de casa, una pregunta tarda 32 s de media y se
   * reparten así: 11,6 s en elegir la herramienta, 1,1 s en ejecutarla y **22,7 s en redactar la
   * respuesta**, porque ese segundo turno lleva el resultado entero dentro del contexto. El peor
   * caso fueron 56 s con `camwall_recent_clips`, que devuelve mucho.
   *
   * Y hay una segunda medida que lo confirma desde el otro lado: en el servidor de casa, cada
   * token nuevo de prompt cuesta entre 0,10 y 0,20 s cuando la máquina está ocupada con las
   * cámaras. Una observación de 1200 caracteres son unos 300 tokens, o sea entre 30 y 60 s de
   * espera. Duplicarla duplica la espera, y casi nunca duplica lo que se sabe.
   *
   * Por eso el valor por defecto es corto y no generoso: subirlo no da mejores respuestas, da las
   * mismas respuestas más tarde. Quien piense en la nube puede subirlo sin pagar esa latencia.
   */
  mcpMaxOutputChars: Number(env['JARVIS_MCP_MAX_OUTPUT_CHARS'] || 8000),
  /**
   * El lote que el asistente lleva puesto sin tener que buscarlo.
   *
   * Con 108 herramientas detrás de un buscador, la diferencia entre útil e inútil es empezar
   * sabiendo cinco cosas en vez de ninguna. Son 581 tokens medidos, y cada uno está justificado:
   *
   * · `zeus_playbook` — el manual de la casa. Para un modelo que no la conoce vale más que el
   *   resto junto: le dice qué corre en cada contenedor y qué trampas ya costaron caras.
   * · `system_health_snapshot` — seis diagnósticos en una llamada. Trae dentro los servicios
   *   caídos, el disco, los puertos y Docker, así que cargar además `failed_services` y
   *   `docker_list` sería pagar dos veces por lo mismo.
   * · `cpu_sampled` — la que mide la CPU **bien**. Está aquí sobre todo para que el modelo no
   *   acabe en `docker_stats`, que en esta máquina informó de un 22 % donde había un 457 %.
   * · `memory_pressure` — swap y kswapd, que es como se ve venir el problema que ya hubo.
   * · `camwall_overview` — porque en esta casa «¿va todo bien?» significa las cámaras, y es la
   *   pregunta más probable: tenerla puesta ahorra una ronda entera del router en el caso común.
   */
  mcpStarter: list(env['JARVIS_MCP_STARTER']).length ? list(env['JARVIS_MCP_STARTER']) : [
    'zeus_playbook', 'system_health_snapshot', 'cpu_sampled', 'memory_pressure', 'camwall_overview',
  ],

  /**
   * El asistente de primera línea: el que contesta siempre.
   *
   * Nació siendo un `llama-server` en el propio bastión —de ahí que las variables se llamen
   * `LOCAL`, que se aceptan por compatibilidad— y hoy es un modelo barato de la nube. Lo que
   * define este escalón no es dónde vive sino su papel: **responde todo, y cuando no puede, pide
   * permiso para escalar**. Sin esto configurado, el Assistant funciona como siempre contra el
   * modelo de la nube.
   */
  localModelBaseUrl: env['JARVIS_ASSISTANT_MODEL_BASE_URL'] || env['JARVIS_LOCAL_MODEL_BASE_URL'] || '',
  localModelApiKey: env['JARVIS_ASSISTANT_MODEL_API_KEY'] || env['JARVIS_LOCAL_MODEL_API_KEY'] || '',
  localModelName: env['JARVIS_ASSISTANT_MODEL_NAME'] || env['JARVIS_LOCAL_MODEL_NAME'] || '',
  /**
   * Cómo se llama el tope de generación en este proveedor, y cuánto razona antes de contestar.
   *
   * Los dos son de los que tumban la petición entera si se mandan mal: gpt-5-nano rechaza
   * `max_tokens` con un 400 y exige `max_completion_tokens`. Y `reasoning_effort: minimal` no es
   * una optimización menor —medido contra la API real, baja el turno de 4574 ms a 929 ms y de 448
   * tokens de razonamiento a cero—.
   */
  localModelMaxTokensParam: env['JARVIS_ASSISTANT_MODEL_MAX_TOKENS_PARAM']
    || env['JARVIS_LOCAL_MODEL_MAX_TOKENS_PARAM'] || 'max_tokens',
  localModelReasoningEffort: env['JARVIS_ASSISTANT_MODEL_REASONING_EFFORT']
    || env['JARVIS_LOCAL_MODEL_REASONING_EFFORT'] || '',
  /** Un modelo de casa a 7,5 tokens/s necesita más plazo que una API. */
  localModelTimeoutMs: Number(env['JARVIS_ASSISTANT_MODEL_TIMEOUT_MS'] || env['JARVIS_LOCAL_MODEL_TIMEOUT_MS'] || 120_000),
  /**
   * Cuánto de un resultado de herramienta ve el modelo local dentro de un turno.
   *
   * Distinto de `mcpMaxOutputChars`, que acota lo que devuelve el MCP: esto acota **todo** lo que
   * devuelve cualquier herramienta, incluidas las del propio Jarvis. El valor heredado eran 60.000
   * caracteres, pensados para una API con 200k de contexto; aquí son el contexto entero.
   */
  localModelToolResultChars: Number(env['JARVIS_ASSISTANT_MODEL_TOOL_RESULT_CHARS']
    || env['JARVIS_LOCAL_MODEL_TOOL_RESULT_CHARS'] || 40_000),
  /**
   * Cuánto puede generar el asistente de una vez.
   *
   * Generoso a propósito, y por un motivo que no es el de siempre: en un modelo que razona **lo
   * que piensa cuenta contra este tope**. Con 400 —que era el valor de cuando esto era un modelo
   * local lento— gpt-5-nano gastaba los 400 razonando y devolvía la respuesta **vacía**: ni
   * herramienta ni texto. Un tope corto sólo es seguro con `reasoning_effort: minimal`.
   */
  localModelMaxOutputTokens: Number(env['JARVIS_ASSISTANT_MODEL_MAX_OUTPUT_TOKENS']
    || env['JARVIS_LOCAL_MODEL_MAX_OUTPUT_TOKENS'] || 4000),
  /**
   * Temperatura del modelo local.
   *
   * Baja a propósito: lo que se le pide en cada vuelta es **elegir una herramienta**, que es una
   * clasificación, no una redacción. `llama-server` viene a 0.8 de fábrica y con eso el mismo
   * «Hola» contestaba el saludo o se ponía a diagnosticar el servidor según la tirada —medido,
   * dos de cada cuatro—. No es un ajuste de estilo: es la diferencia entre 12 s y 194 s.
   *
   * **Vacío por defecto, y eso importa**: los modelos que razonan la rechazan. gpt-5-nano contesta
   * 400 a cualquier valor que no sea el suyo —«does not support 0.1 with this model»—, así que
   * mandarla siempre tumbaría el asistente entero. Se pone sólo donde se sabe que la admiten.
   */
  localModelTemperature: env['JARVIS_ASSISTANT_MODEL_TEMPERATURE'] ?? env['JARVIS_LOCAL_MODEL_TEMPERATURE'] ?? '',

  /** El modelo del Assistant vive en el core: la clave jamás llega al navegador. */
  modelBaseUrl: env['JARVIS_MODEL_BASE_URL'] || 'https://api.anthropic.com',
  modelApiKey: env['JARVIS_MODEL_API_KEY'] || '',
  modelName: env['JARVIS_MODEL_NAME'] || 'claude-sonnet-5',
  /**
   * Qué API habla el modelo: `anthropic` o cualquier endpoint compatible con OpenAI.
   *
   * Se puede fijar a mano, pero por defecto se deduce de la URL, que es lo que evita el fallo
   * silencioso más probable: poner una credencial que la casa ya tiene y que el Assistant siga
   * apagado —o peor, que conteste 400— porque el core habla el protocolo del otro proveedor.
   */
  modelProvider: (env['JARVIS_MODEL_PROVIDER']
    || (/anthropic/i.test(env['JARVIS_MODEL_BASE_URL'] || 'https://api.anthropic.com') ? 'anthropic' : 'openai')
  ) as 'anthropic' | 'openai',
  /**
   * A dónde se escala cuando el modelo local se queda corto.
   *
   * Por defecto **es el modelo de siempre**: quien ya tenía el Assistant funcionando contra su
   * proveedor no tiene que tocar nada para que ese proveedor pase a ser la escalada. Se puede
   * separar —`JARVIS_CLOUD_*`— cuando el de la nube deba ser otro distinto del que había.
   *
   * Escalar nunca ocurre solo: hace falta una aprobación de la persona, igual que para escribir en
   * una máquina. Aquí sólo se dice a dónde se iría.
   */
  cloudModelBaseUrl: env['JARVIS_CLOUD_MODEL_BASE_URL'] || env['JARVIS_MODEL_BASE_URL'] || 'https://api.anthropic.com',
  cloudModelApiKey: env['JARVIS_CLOUD_MODEL_API_KEY'] || env['JARVIS_MODEL_API_KEY'] || '',
  cloudModelName: env['JARVIS_CLOUD_MODEL_NAME'] || env['JARVIS_MODEL_NAME'] || 'claude-sonnet-5',
  /**
   * Tope de generación en la nube. **Vacío por defecto: no se manda nada.**
   *
   * Lo aprendimos rompiéndolo: mandar `max_tokens` siempre tumbó la escalada el primer día que se
   * usó, porque los modelos nuevos de OpenAI lo rechazan con un 400 y exigen
   * `max_completion_tokens`. Quien quiera acotar el gasto de un turno en la nube lo pone aquí, y
   * dice además cómo se llama el campo en su proveedor. No se deduce de la URL ni del texto del
   * error: eso es una red que desaparece en silencio el día que el otro lado cambie una cadena.
   */
  cloudModelMaxOutputTokens: Number(env['JARVIS_CLOUD_MODEL_MAX_OUTPUT_TOKENS'] || 0) || 0,
  cloudModelMaxTokensParam: env['JARVIS_CLOUD_MODEL_MAX_TOKENS_PARAM'] || 'max_tokens',
  cloudModelProvider: (env['JARVIS_CLOUD_MODEL_PROVIDER'] || env['JARVIS_MODEL_PROVIDER']
    || (/anthropic/i.test(env['JARVIS_CLOUD_MODEL_BASE_URL'] || env['JARVIS_MODEL_BASE_URL'] || 'https://api.anthropic.com')
      ? 'anthropic' : 'openai')
  ) as 'anthropic' | 'openai',

  /**
   * La conversación.
   *
   * `chatMaxToolCalls` es más generoso que el del plan porque un turno de chat es lo que la
   * persona está mirando: puede permitirse tres lecturas encadenadas. `chatHistoryMessages` es lo
   * que se le recuerda al modelo, y es corto por la misma razón de siempre: con 4096 de contexto,
   * la historia compite con el catálogo y con la respuesta.
   */
  chatMaxToolCalls: Number(env['JARVIS_CHAT_MAX_TOOL_CALLS'] || 12),
  /**
   * Cuánto puede pasar un turno consultando antes de tener que responder.
   *
   * Ocho consultas no son un tope cuando cada una tarda dos minutos: son veinte minutos, y eso es
   * lo que llegó a tardar un «Hola» en producción. Dos minutos de reloj sí acotan lo que espera
   * una persona, y no dependen de lo cargada que esté la máquina ese día.
   */
  chatMaxTurnMs: Number(env['JARVIS_CHAT_MAX_TURN_MS'] || 180_000),
  /**
   * Ofrecer el catálogo MCP como herramientas propias en vez de detrás del router.
   *
   * Con un modelo capaz es mejor y no por velocidad: la API sólo acepta los nombres que se le
   * declararon, así que **el modelo no puede inventarse una capacidad**. Toda esa clase de fallos
   * desaparece en vez de gestionarse. Si el catálogo no cabe bajo `chatMaxTools`, se vuelve al
   * router entero —nunca recortado: un catálogo al que le faltan cosas sin decirlo engaña—.
   */
  chatDirectCapabilities: bool(env['JARVIS_CHAT_DIRECT_CAPABILITIES'], true),
  /** Tope de funciones por petición. La API de OpenAI rechaza con 400 por encima de 128. */
  chatMaxTools: Number(env['JARVIS_CHAT_MAX_TOOLS'] || 128),
  chatHistoryMessages: Number(env['JARVIS_CHAT_HISTORY_MESSAGES'] || 12),
  /** Con qué autonomía nace una conversación. La persona la cambia desde la interfaz. */
  chatDefaultAutonomy: (env['JARVIS_CHAT_DEFAULT_AUTONOMY'] || 'manual') as 'manual' | 'auto',
  chatRetentionDays: Number(env['JARVIS_CHAT_RETENTION_DAYS'] || 90),

  /**
   * Cuánto cuesta pensar, y cuánto se cargó.
   *
   * El proveedor no lo dice: una clave de proyecto recibe 403 al preguntar por el gasto de la
   * cuenta. Así que se cuenta aquí y se le pone precio con esta tarifa, en dólares por millón de
   * tokens y con la forma `modelo:entrada/caché/salida`. Los cacheados van aparte porque cuestan
   * un orden de magnitud menos y son la mayor parte del prompt de una conversación.
   *
   * Los valores por defecto son los publicados en septiembre de 2026. Si cambian, se cambian aquí
   * y **el histórico se recalcula solo**: lo que se guarda son los tokens, no el importe.
   */
  modelPrices: env['JARVIS_MODEL_PRICES']
    || 'gpt-5-nano:0.05/0.005/0.40,gpt-5-mini:0.25/0.025/2.00,gpt-5:1.25/0.125/10.00',
  /**
   * Lo que se cargó en la cuenta, en dólares, y desde cuándo.
   *
   * Lo pone una persona: no se puede leer. Sin esto no se enseña ningún «te queda», porque un
   * resto calculado sobre un presupuesto inventado es peor que no dar ninguno.
   */
  modelBudgetUsd: Number(env['JARVIS_MODEL_BUDGET_USD'] || 0),
  modelBudgetSince: env['JARVIS_MODEL_BUDGET_SINCE'] || '',
  modelSpendRetentionDays: Number(env['JARVIS_MODEL_SPEND_RETENTION_DAYS'] || 180),

  /**
   * Un modelo guionizado en vez del de verdad. Existe para desarrollo y pruebas: deja ejercitar
   * la durabilidad de un plan sin red, sin credencial y sin gastar cuota.
   */
  assistantScripted: bool(env['JARVIS_ASSISTANT_SCRIPTED'], false),
  /**
   * Cuántas consultas puede encadenar el coordinador dentro de un turno antes de tener que
   * decidir algo. Es un presupuesto del core, no del modelo: sin él, un turno puede irse en
   * investigar y no proponer nada, que es la forma cara de no hacer nada.
   */
  assistantMaxToolCalls: Number(env['JARVIS_ASSISTANT_MAX_TOOL_CALLS'] || 6),

  /**
   * El modelo que pone nombre a los workspaces.
   *
   * Va aparte del Assistant: nombrar es un goteo constante de llamadas diminutas, y pagarlo a
   * precio de coordinador es tirar dinero. Aparte también significa que quedarse sin cuota en uno
   * no silencia al otro.
   */
  titleApiKey: env['JARVIS_TITLE_API_KEY'] || '',
  titleBaseUrl: env['JARVIS_TITLE_BASE_URL'] || 'https://api.groq.com/openai',
  titleModel: env['JARVIS_TITLE_MODEL'] || 'llama-3.1-8b-instant',
  /*
   * Llamadas de título por minuto en todo el proceso.
   *
   * Grok y Qwen en su capa gratuita tienen límites por minuto que se agotan enseguida si cada
   * visita a un workspace dispara una llamada. Pasado el tope se nombra con el heurístico local,
   * que da un nombre peor pero nunca un 429 ni una espera.
   */
  titlePerMinute: Number(env['JARVIS_TITLE_PER_MINUTE'] ?? '8') || 8,
  planIntervalMs: Number(env['JARVIS_PLAN_INTERVAL_MS'] || 1500),

  verbose: bool(env['JARVIS_VERBOSE'], false),
} as const;

export type CoreConfig = typeof config;
