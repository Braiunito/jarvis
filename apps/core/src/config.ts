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

  capabilityTtlMs: Number(env['JARVIS_CAPABILITY_TTL_MS'] || 10 * 60 * 1000),
  usageTtlMs: Number(env['JARVIS_USAGE_TTL_MS'] || 5 * 60 * 1000),
  usageProbeTimeoutMs: Number(env['JARVIS_USAGE_PROBE_TIMEOUT_MS'] || 20_000),

  attachmentMaxBytes: Number(env['JARVIS_ATTACHMENT_MAX_BYTES'] || 20 * 1024 * 1024),
  attachmentQuotaBytes: Number(env['JARVIS_ATTACHMENT_QUOTA_BYTES'] || 50 * 1024 * 1024),
  attachmentTtlMs: Number(env['JARVIS_ATTACHMENT_TTL_MS'] || 6 * 3600 * 1000),

  /** Presupuestos de payload por evento (ADR-007). Nada se recorta en silencio. */
  maxToolOutputBytes: Number(env['JARVIS_MAX_TOOL_OUTPUT_BYTES'] || 32 * 1024),
  maxEventTextBytes: Number(env['JARVIS_MAX_EVENT_TEXT_BYTES'] || 256 * 1024),

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
