# Auditoría de Jarvis · 2026-09-02

Revisión estática de `src.txt` (168 ficheros fuente: `apps/core`, `apps/gateway`, `apps/web`,
`packages/*`, `deploy/*`, `tests/*`) contrastada con `CHANGELOG.md` y `backlog.md`.

**Lo que entiendo que la app debe hacer**: una consola web autenticada con passkeys que, desde un
bastión, permite (1) encontrar y reanudar sesiones de Claude/Codex/OpenCode en una flota de
máquinas, (2) lanzar trabajos durables sobre esas sesiones (tmux + spool, sobreviven a reinicios
del core), (3) verlos en vivo por SSE, pararlos y reintentarlos, (4) abrir una terminal viva por
WebSocket, (5) delegar objetivos a un Assistant que planifica pasos con aprobaciones, y (6) ver
salud, cuota y métricas. Todo con destino y permiso a la vista y con auditoría.

**Estado general**: la arquitectura es sólida y la mayor parte del producto funciona. Pero hay un
puñado de fallos que rompen promesas centrales —**«parar» no para al agente**, **un run puede
quedarse `running` para siempre**, **«Abrir terminal» no reanuda sesiones de Claude**, **los
adjuntos no se pueden subir desde la interfaz**, **errores de destino salen como 500**— y varias
regresiones del mismo tipo que las que ya se corrigieron (variables que no llegan al contenedor,
barridos declarados que nadie ejecuta).

Convención: **A** = rompe una promesa del producto o pierde datos/dinero · **M** = fallo real
con impacto acotado · **B** = pulido, deuda o riesgo bajo · **V** = no se pudo verificar con el
dump; hay que comprobarlo contra la máquina.

---

## Resumen de lo prioritario (top 10)

| # | Hallazgo | Dónde |
|---|---|---|
| A1 | Cancelar marca `cancelled` pero el agente sigue corriendo (SIGINT al subshell, no al CLI) | `packages/agent-adapters/src/runner.ts` |
| A2 | Un run cuya tmux muere con `status.json` en `running` no se detecta nunca: queda `running` hasta las 4 h de plazo | `apps/core/src/runs/supervisor.ts` |
| A3 | `PROVIDER_MISSING` / `STRATEGY_IMPOSSIBLE` / host inalcanzable al resolver destino salen como **500 «internal error»** | `apps/core/src/runs/service.ts` + `packages/agent-adapters/src/hosts.ts` |
| A4 | «Abrir terminal» no pasa el `cwd` (ni el permiso): `claude --resume` falla en cualquier sesión que no viva en `$HOME` | `apps/web/src/screens/terminal.tsx`, `api/queries.ts`, enlaces en workspace/explorer/home |
| A5 | La interfaz promete adjuntos («los ficheros que le subiste») pero **no hay forma de subir ninguno** | `apps/web/src/screens/workspace.tsx` |
| A6 | Una sesión nueva se marca `sessionLaunched` al **crear** el run, no al arrancar el agente: si el primer trabajo falla en `prepare`, todos los siguientes reanudan una sesión que no existe | `apps/core/src/runs/service.ts` (`create`) |
| A7 | Proveedor Anthropic: sólo se responde al primer `tool_use`; con dos herramientas en paralelo la API devuelve 400 y el plan muere (el mismo fallo que HZ-25 arregló sólo en OpenAI) | `apps/core/src/assistant/model.ts` |
| A8 | El resultado de Codex sigue saliendo en blanco si `agent.text` y el evento final caen en polls distintos (HZ-10 incompleto) | `apps/core/src/runs/service.ts` (`ingest`) |
| M1 | `POST /api/sessions/new` crea el workspace antes de validar el trabajo: un fallo deja un workspace huérfano | `apps/core/src/sessions/routes.ts` |
| M2 | Una aprobación se consume **antes** de crear el run; si `runs.create` falla, el siguiente tick cancela el plan con «la persona no autorizó la acción» | `apps/core/src/plans/service.ts` |

---

## A · Fallos que rompen promesas del producto

### A1 · «Parar» no para al agente

`buildWrapperScript` lanza el agente como `( ${agentCommand} ) & PID=$!` y `buildCancelCommand`
hace `kill -INT "$PID"`. Ese PID es el **subshell**, no el CLI: el comando es compuesto
(`export PATH…; cd … && VAR=… claude … < /dev/null`), así que `sh` no lo `exec`-ea. El subshell
muere con SIGINT, `wait` vuelve, el wrapper publica `cancelled`, la tmux se cierra, y el core
confirma `cancelled` en segundos («cancelación confirmada en cuatro segundos» del CHANGELOG es
justamente este síntoma). Mientras tanto `claude`/`codex` sigue vivo, huérfano, escribiendo en
`events.ndjson`, gastando cuota y **tocando ficheros bajo el permiso que se quería cortar**.

La escalada (`kill -KILL` + `tmux kill-session`) tampoco llega al agente en la fase amable, y en
la dura sólo por el SIGHUP de tmux, cuando ya se ha dado el run por cancelado.

**Arreglo**: que el PID sea el del agente y que la señal vaya al grupo de proceso.
- En `remoteScript`, opción `exec: true` que emita `… && exec env K=V claude …` (con `< /dev/null`
  antes del `exec`). El subshell se convierte en el agente.
- En el wrapper: `setsid` si existe, y en `buildCancelCommand`:
  `PGID=$(ps -o pgid= "$PID" | tr -d ' '); kill -INT -- "-$PGID" 2>/dev/null || kill -INT "$PID"`;
  en escalada `kill -KILL -- "-$PGID"` **antes** de `kill-session`.
- Test que lo sostenga (los actuales comparan cadenas): un agente falso que ignore la muerte de su
  padre y compruebe que tras `cancel` no queda proceso con ese nombre (`pgrep -f`).

### A2 · Un run con tmux muerta y `status.json` en `running` no se detecta

`#applyPoll` sólo declara `RUNNER_LOST` cuando `!poll.alive && !remoteState`. Si la tmux
desaparece con el estado todavía en `running` —reinicio del host, OOM-kill, `tmux kill-session`
desde la pantalla Terminal (ver A2b), un `kill -9` al wrapper— ninguna rama aplica: no es
terminal, no está `cancelling`, no está sin estado. El run se queda `running` hasta `deadline_at`
(4 h por defecto), y ahí entra en `cancelling` y sólo entonces se cierra como `timed_out`.
Durabilidad prometida («se puede reiniciar… sin perderla») y no cumplida en el caso más común de
fallo de máquina.

**Arreglo**: en `#applyPoll`, si `!poll.alive && remoteState === 'running'`, tratarlo como
runner ausente con el mismo `lostGraceMs` (y opcionalmente comprobar `kill -0 $(cat pid)` en el
poll para distinguir «agente vivo sin tmux»). Añadir la fila a la tabla del comentario de
`reconcile`.

**A2b** · La pantalla Terminal lista y permite «Cerrar» sesiones `jarvis-run-*` (kind `run`).
`TerminalService.destroy` no lo impide (`assertOurs` acepta el prefijo). Eso mata el wrapper de un
trabajo, que cae exactamente en el hueco de A2. Rechazar `kind === 'run'` en `destroy` (o
redirigir a «Parar el trabajo») y esconder el botón en la fila.

### A3 · Errores de destino salen como 500

`resolveTarget` lanza `TargetImpossibleError` (con `.code` `PROVIDER_MISSING` /
`STRATEGY_IMPOSSIBLE`) y `capabilities.detect` lanza `HostUnreachableError`. Ninguno es
`JarvisError` y **nadie los traduce** (`grep` en `apps/core/src`: cero usos). El `setErrorHandler`
de `app.ts` los convierte en `500 INTERNAL «internal error»`. Afecta a `POST /api/runs`,
`GET /api/workspaces/:id/target`, `GET /api/usage?workspaceId=`, `POST /api/attachments` y
`POST /api/sessions/new`. La consola pierde el código, así que `ErrorNote` no puede ofrecer «ver
qué salto falla» ni el usuario sabe que es «no está instalado en goro1», que es un mensaje que
ya existe en `errors.ts` con su 409/502.

**Arreglo**: en `RunService.planTarget` (o un helper `toJarvisError`) envolver:
`TargetImpossibleError → JarvisError(error.code, message)`,
`HostUnreachableError → JarvisError('HOST_UNREACHABLE', …, { scope: { host } })`. Test HTTP que
pida un provider ausente y espere 409 con código.

### A4 · «Abrir terminal» no reanuda sesiones de Claude

`useOpenTerminal` manda `{ host, provider, sessionId }` y nada más; los enlaces desde
workspace, explorer y home tampoco llevan `cwd`. `claude --resume <id>` sólo ve las
conversaciones del directorio desde el que se lanza (TEC-11): la tmux se abre en `$HOME` y el
CLI responde «No conversation found with session ID». La promesa «la terminal se abre desde
donde hace falta con máquina y sesión ya elegidas» no se cumple para casi ninguna sesión real.
Además el permiso elegido nunca viaja: siempre `safe` (`plan`).

**Arreglo**: aceptar `workspaceId` en `POST /api/terminal/open` y resolver `cwd` en el core
(workspace → `CwdResolver`, que ya existe para runs), en vez de fiarse de la URL. Los enlaces
llevan `from=<workspaceId>`, que ya existe: úsese. Pasar también `permissionProfile` elegido.

### A5 · Adjuntos: la interfaz los promete y no se pueden subir

La pestaña «Archivos y contexto» dice «los ficheros que le subiste», «Se suben al mandar
trabajo». El core tiene `POST /api/attachments` (streaming a la máquina), `claim` en `create`,
`promptFor` en `prepare`. **En `apps/web` no hay ningún `<input type="file">`, `FormData` ni
llamada a `/api/attachments`**. `useCreateRun` acepta `attachmentIds` pero nadie los rellena.

**Arreglo**: botón de adjuntar en el compositor → `fetch('/api/attachments?workspaceId=&name=&type=', { method: 'POST', body: file })`
(el gateway ya reenvía cuerpos sin acumular), lista de `staged` con quitar, y `attachmentIds` en
`send()`. Hasta entonces, quitar el texto que lo promete.

### A6 · `sessionLaunched` se fija al crear el run, no al arrancar el agente

`create()` hace `markSessionLaunched` en la misma transacción que `insert`. Si ese primer run
falla en `prepare` (host caído, `tmux` ausente, `cwd` inexistente, `yolo` deshabilitado), la
sesión **no existe** en la máquina pero el workspace ya dice que sí. Todos los trabajos siguientes
salen con `--resume <uuid>` contra una conversación inexistente → fallan siempre. Con Codex y
OpenCode es peor: `sessionPending` nunca se adopta (no hubo primer evento) y se reanuda el UUID
provisional.

**Arreglo**: marcar `sessionLaunched` cuando llegue `agent.started` (o al confirmar `running`
con outcome `started`), y si el run muere antes, dejar `sessionLaunched=false` para que el
siguiente vuelva a estrenar. Reflejarlo en `RunService.transition` o en `ingest`.

### A7 · Anthropic: sólo se responde al primer `tool_use`

`AnthropicModel.decide` hace `blocks.find(block => block.type === 'tool_use')` y responde un solo
`tool_result`. Con `tool_choice: {type:'any'}` Claude puede pedir varias herramientas en un mismo
mensaje; la Messages API exige un `tool_result` por cada `tool_use_id` y devuelve 400 si falta
uno. Es exactamente lo que HZ-25 corrigió para OpenAI y quedó sin corregir aquí.

**Arreglo**: iterar todos los bloques `tool_use` (misma lógica que `OpenAiCompatibleModel`), o
enviar `tool_choice: { type: 'any', disable_parallel_tool_use: true }`. Test con un
`fetchImpl` que devuelva dos `tool_use`.

### A8 · Resultado de Codex en blanco (HZ-10 incompleto)

`lastText` es una variable **local a `ingest()`**, es decir, por trozo de spool. Con polls de
700 ms, el `agent.text` y el evento final de turno llegan casi siempre en lecturas distintas; en
ese caso `resultSummary` se guarda como `null` (`resultSummary !== undefined` → se escribe
`null`). La tarjeta sigue vacía, el titulador sin material y la síntesis sin resultado.

**Arreglo**: si el evento `result` no trae texto, leer el último `agent.text` de `run_events`
(`SELECT payload_json … WHERE run_id=? AND type='agent.text' ORDER BY seq DESC LIMIT 1`) o
guardar `last_text` en la fila del run al ingerir.

### A9 · El cancel por timeout usa la raíz de spool equivocada

En el plazo agotado, `supervisor.ts` llama `runner.cancel({ host, runId })` **sin `spoolRoot`**,
así que `RemoteRunner.layout` usa la raíz configurada (`~/.local/state/…`), `spoolLayout` lanza
«must be an absolute path» y el `.catch(() => undefined)` lo traga. La señal amable nunca sale;
el run entra en `cancelling` y sólo la escalada (que sí pasa `spoolRoot`) lo mata 5 s después
con `KILL`. Pasar `spoolRoot: this.#spoolRootOf(run)` como hacen `cancel`/`escalateCancel`.

---

## M · Fallos reales con impacto acotado

### Core · runs y supervisor

- **M3 · Spool terminado con última línea sin `\n` → nunca «drenado»**. `#applyPoll` no concluye
  hasta `cursor >= size`, e `ingest` sólo consume líneas completas. Si el agente murió a mitad de
  línea, el run queda `running` hasta el plazo. Cuando `remoteState` es terminal y el resto no
  tiene `\n`, ingerir el resto como `agent.raw` y cerrar.
- **M4 · `retry()` pierde `preferredStrategy` y adjuntos, y no es idempotente**: doble clic en
  «Reintentar» crea dos runs. Derivar una clave `retry:<runId>:<attempt>`.
- **M5 · `prepare` falla al primer error SSH transitorio** sin reintento (los polls sí toleran
  `HOST_UNREACHABLE`). Un queued run muere por un parpadeo de red. Reintentar N veces con backoff
  antes de `failed`.
- **M6 · `cwd` inexistente se reporta como `HOST_UNREACHABLE`** («could not prepare the run») porque
  `tmux new-session -c` falla; la consola manda a «ver qué salto falla». Clasificar el stderr
  (`No such file or directory`) → `BAD_REQUEST`/`CWD_MISSING` con el directorio en el mensaje.
- **M7 · Log spam sin backoff**: con un host caído, `#pollRun` llama `onError` por run cada 700 ms
  (una línea de log por poll, y un `ssh` que tarda hasta 45 s en fallar). Backoff por host.
- **M8 · Restos de depuración**: dos `console.error('[DEBUG-TEC11] …')` en `service.ts#prepare`
  (con stack trace) y en `supervisor.ts#finishFromRemote` (stderr entero). Quitar.
- **M9 · Reserva de concurrencia fuera de la transacción**: `countActive() >= max` se comprueba
  antes del `insert`; dos peticiones simultáneas superan el límite. Meter el check dentro de la
  transacción.
- **M10 · `buildAgentCommand` no pasa `sourceRoot`**: `adapter.buildRun` lo acepta para poner
  `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, y el workspace lo guarda, pero no viaja. Cualquier sesión
  fuera del store por defecto no se puede reanudar.
- **M11 · SSE trunca el replay** a 5000 eventos: `flush()` lee una página y, si el run ya terminó,
  manda `run.ended` y cierra. Un run largo pierde eventos al reabrirlo. Bucle hasta que la página
  venga incompleta.
- **M12 · `ack` sobre un run en marcha** deja `acknowledged_at` puesto; si luego falla, nunca reclama
  atención. Restringir el `ack` por id a estados que reclaman, o comparar `acknowledged_at` con
  `finished_at`.
- **M13 · Los tres contadores de «requieren atención» no coinciden** (UX-11 lo prometía): el carril
  y la portada cuentan sobre los últimos 50 runs sin ventana; `metrics.needsAttention` usa
  `created_at >= previousFrom` (48 h); la nota del workspace ignora `acknowledgedAt`. Que todos lean
  de `/api/metrics`.

### Core · Assistant y planes

- **M2 · Aprobación consumida antes de crear el run** (ver top 10). Consumir en la misma
  transacción que la inserción del run, o tratar `consumed` con `run_id IS NULL` como
  «reintentable».
- **M14 · Un plan muere al primer error del modelo** (429, 529, timeout de 120 s): `#proposeNext`
  hace `#finish('failed')`. Reintento acotado con `available_at` en vez de fallo definitivo.
- **M15 · `PlanSupervisor` sin `onError` cableado** en `services.ts`: los errores de `advance` se
  tragan en silencio. Y el `tick` es secuencial: un modelo lento bloquea todos los planes.
- **M16 · Cancelar un plan no cancela su run en vuelo** y la interfaz no lo dice. Ofrecer «parar
  también el trabajo» o avisar.
- **M17 · `maxSteps` corta el plan como `failed`** sin dar al modelo la oportunidad de cerrar con
  síntesis. En el último paso, ofrecer sólo `finish`.

### Core · sesiones, workspaces, terminal

- **M1 · Workspace huérfano en `/api/sessions/new`** (top 10): resolver destino y validar permiso
  **antes** de `startSession`, o borrar el workspace si `runs.create` falla.
- **M18 · `terminal.open` no aplica `allowYolo`**: `POST /api/terminal/open` y el modo terminal de
  `/api/sessions/new` aceptan `permissionProfile: 'yolo'` aunque `JARVIS_ALLOW_YOLO=false`. Misma
  puerta que en runs.
- **M19 · `jarvis-<provider>-new` se reutiliza**: la segunda «Terminal viva» nueva del mismo
  provider en el mismo host devuelve `created: false` y **ignora en silencio** la carpeta y el
  permiso elegidos. Nombre único por apertura (id corto) cuando no hay `sessionId`.
- **M20 · La lista de terminales enseña «ninguna» cuando el host no responde**: `list()` no mira
  `result.code`; un `ssh` fallido da stdout vacío y la interfaz lo pinta como vacío legítimo.
- **M21 · El índice se consulta listando 500 filas** (`transcript`, `locate`, `providersFor`): con
  más de 500 sesiones de un provider en un host, la sesión «no existe». Pedir por `session_id` al
  índice, o paginar.
- **M22 · `touch()` pisa el `cwd` escrito por una persona**: `cwd = COALESCE(?, cwd)` se aplica
  aunque `cwd_source = 'user'` (sólo se protege el `cwd_source`). Aplicar la misma condición al
  valor.
- **M23 · Barrido de adjuntos nunca programado**: `AttachmentService.sweep()` existe (expira
  `staged`, reintenta `release_pending`) y **nadie lo llama** —el mismo patrón que HZ-21—. Los
  ficheros subidos que no se usan viven para siempre en la máquina.
- **M24 · `PRAGMA integrity_check` completo en cada `/api/health`** (la consola lo pide cada
  60 s y en cada pantalla). Con una base de cientos de MB bloquea el hilo de SQLite para todas las
  peticiones. `quick_check`, y cachear el resultado (una vez por hora o al arrancar).

### Web · consola

- **M25 · Borrador: carrera de versiones sin manejar**. `onChangeBody` captura `version` en el
  cierre del debounce; si se sigue tecleando mientras un guardado está en vuelo, el siguiente va
  con la versión vieja → `409 DRAFT_VERSION_CONFLICT`, que nadie captura: «guardando borrador…»
  se queda para siempre y el servidor conserva el texto antiguo (sólo el espejo local tiene el
  bueno). Al 409, refrescar `draft.version` y reintentar; serializar guardados.
- **M26 · Búsqueda del explorador sin debounce**: una petición al índice por tecla.
- **M27 · `NewSessionDialog` sondea la flota aunque esté cerrado**: los hooks corren antes del
  `if (!open) return null`, así que `useHosts({ probe: true })` (un `ssh` por máquina) se dispara
  al cargar la app y al volver a la pestaña. Mover los hooks a un componente hijo montado sólo al
  abrir.
- **M28 · Run Center**: (a) un fallo dado por visto desaparece de «Requieren atención» y no está
  en «Terminados» (sólo `completed`/`cancelled`) → sólo se encuentra en «Todos»; (b) la lista está
  capada a 50 sin paginar ni decirlo; (c) elegir una fila no cambia la URL (`/runs/:id`), así que
  recargar pierde la selección; (d) «Reintentar» aparece en `cancelling` → 409.
- **M29 · Las sesiones estrenadas desde Jarvis y aún sin lanzar no aparecen en Sesiones** (no
  están en el índice); sólo en la portada (25 últimas). Fusionar los workspaces `sessionLaunched=false`
  en el explorador.
- **M30 · `send()` y `submit()` sin `catch`**: `mutateAsync` rechazado produce «Uncaught (in
  promise)» aunque `ErrorNote` lo pinte.

### Despliegue e integración

- **M31 · Compose no pasa buena parte de las variables al contenedor** —el mismo fallo de HZ-25,
  para el resto—. Core: `JARVIS_SSH_OPTIONS`, `JARVIS_KNOWN_HOSTS_FILE`, `JARVIS_REMOTE_PATH`,
  `JARVIS_MAX_CONCURRENT_RUNS`, `JARVIS_RUN_TIMEOUT_MS`, `JARVIS_INTERRUPT_GRACE_MS`,
  `JARVIS_POLL_*`, `JARVIS_SWEEP_INTERVAL_MS`, `JARVIS_SPOOL_RETENTION_DAYS`,
  `JARVIS_CAPABILITY_TTL_MS`, `JARVIS_USAGE_*`, `JARVIS_ATTACHMENT_*`, `JARVIS_MAX_*`,
  `JARVIS_ASSISTANT_SCRIPTED`, `JARVIS_ASSISTANT_MAX_TOOL_CALLS`, `JARVIS_DEFAULT_PROFILE`,
  `JARVIS_PLAN_INTERVAL_MS`, `JARVIS_VERBOSE`. Gateway: `JARVIS_SESSION_SECRET`,
  `JARVIS_SESSION_TTL`, `JARVIS_RP_NAME`, `JARVIS_REQUIRE_USER_VERIFICATION`,
  `JARVIS_LOGIN_MAX_ATTEMPTS`, `JARVIS_LOGIN_WINDOW`, `JARVIS_CHALLENGE_TTL`,
  `JARVIS_ENROLLMENT_TTL`, `JARVIS_CORE_TIMEOUT_MS`. Cualquier ajuste en `.env` se ignora sin
  aviso. `env_file: ../.env` en ambos servicios, y que el core registre al arrancar qué `JARVIS_*`
  del entorno no reconoce.
- **M32 · `known_hosts` en `/tmp` del contenedor**: se pierde en cada reinicio y
  `StrictHostKeyChecking=accept-new` vuelve a aceptar cualquier clave (TOFU repetido = ventana
  de MITM en cada arranque). Montarlo en el volumen de datos.
- **M33 · `SSH_AUTH_SOCK` se pasa como variable pero el socket no se monta**: inerte y confuso.

---

## B · Pulido, deuda y riesgos bajos

- `GET /api/runs?limit=` y `GET /api/workspaces?limit=` sin tope; `run_events` sin paginación.
- `idempotency_keys.expires_at` nunca se purga; TEC-03 (compactación) sigue sin trabajo periódico.
- Un título `auto` escrito por el heurístico (modelo ausente o sin cuota) ya no `looksAutomatic`
  y el modelo nunca lo mejora.
- `startSession` ignora `permissionProfile` (`_permissionProfile`): la elección no se recuerda
  (TEC-13); el compositor vuelve a `safe` en cada visita.
- No hay forma de archivar/borrar un workspace; la portada crece sin límite.
- El chip «Conexión segura» sale siempre que `insecureLogin` es `false` en configuración; no mira
  `location.protocol`. Y `/auth/me` devuelve `config.insecureLogin`, no la política efectiva (una
  sesión por passkey desde fuera de la LAN ve «HTTP sin cifrar»).
- `useRunStream`: un 401/404 hace que `EventSource` reconecte para siempre; `jarvis.dropped` (slow
  consumer) no se pinta.
- WebSocket: el `ping` cada 30 s nunca comprueba el `pong`; sin reconexión automática en la
  consola; xterm sólo re-ajusta con `window.resize` (el teclado virtual no lo dispara siempre); un
  `resize` que llega antes de conocer `clientTty` se descarta.
- Strategy A con sesión nueva de Claude: `sessionId: null` → no se pasa `--session-id`, la
  conversación nace con otro id y el workspace no la adopta (Claude no está `sessionPending`).
- `POST /api/terminal/open` con provider desconocido: `getAdapter` lanza `Error` → 500. Validar.
- El token del índice viaja en la query string (acaba en logs).
- `useCancelPlan` no invalida `['plan']`; `useDestroyTerminal` no invalida `['metrics']` (el chip
  de terminales tarda hasta 60 s en bajar, en contra de lo que dice el CHANGELOG).
- «Trabajos lanzados: N» en Resumen cuenta la página de 20, no el total.
- El detalle del Run Center no enseña `errorMessage` ni `resultSummary` en texto; sólo el código y
  los últimos 40 eventos.
- `main.ts` no llama a `planSupervisor.stop()` antes de `app.close()` (lo hace `services.close()`
  después; inocuo, pero un turno puede arrancar durante el cierre).
- `#refreshCount` de terminales hace `detect` **secuencial** por host (hasta 20 s cada uno sin
  caché).

---

## V · No se pudo verificar con el dump

El dump excluye `*.json`, `*.md` y `docs/`, así que no se han visto `package.json`, `.env.example`,
los ADR ni el repo de aiSessions.

- **Host `local` del índice vs `bastionHost` real**: `rowToSummary` traduce `local → zeus` y luego
  `transcript()`/`locate()` piden al índice `host=zeus`. El índice falso del testkit hace el mapeo
  al revés sólo para el literal `'bastion'`. Si `aisessions serve` no acepta `host=<bastión>` para
  sus filas `local`, **las conversaciones del bastión no se leen** (`NOT_FOUND`). Comprobar con
  `curl …/api/sessions?host=zeus`.
- **Caddy `encode zstd gzip`** aplica a `text/event-stream`; con `flush_interval -1` debería
  funcionar, pero conviene excluir `/events/*` del `encode` y comprobar que el SSE no se
  amontona.
- `Dockerfile.gateway`, `Dockerfile.aisessions` y `aisessions-sync.sh` existen pero no se ha
  podido validar el build.
- El `dist/` incluido en el dump está desactualizado respecto a `src/` en varios ficheros (p. ej.
  sin `promptPreview`); si se despliega desde un `dist` viejo, varios arreglos del CHANGELOG no
  llegan. `tsc -b --force` en los Dockerfiles lo cubre, pero conviene que `dist/` no esté en el
  árbol.

---

## Tests que faltan (lo que dejó pasar lo anterior)

1. **Cancelación real**: agente falso que ignore la muerte del padre; tras `cancel` no queda
   proceso (`pgrep`). Hoy `RUNNER-*` compara cadenas.
2. **tmux muerta con `status.json` en `running`** → `RUNNER_LOST` dentro del `lostGraceMs`.
3. **Códigos HTTP de destino**: provider ausente → 409 `PROVIDER_MISSING`; host caído → 502.
4. **Terminal desde workspace**: el `cwd` llega a `tmux new-session -c`.
5. **Subida de adjuntos de punta a punta** (hoy no hay E2E porque no hay UI).
6. **Primer run fallido de una sesión nueva** → el segundo vuelve a estrenar.
7. **Codex: texto y evento final en polls distintos** → `resultSummary` no nulo.
8. **Anthropic con dos `tool_use`** en un mensaje.
9. **Aprobación + `runs.create` que falla** → el plan no se cancela como «no autorizado».
10. **Borrador: 409 en autosave** → se resuelve y se guarda.

---

## Orden de corrección sugerido

1. **A1 + A2 + A9** (mismo fichero/área; sin esto «parar» y «durable» son mentira).
2. **A3** (una función, arregla cinco endpoints y el diagnóstico de la consola).
3. **A6 + M1** (sesiones nuevas que se rompen solas).
4. **A4** (terminal con `cwd` y permiso).
5. **A7 + M2 + M14 + M15** (Assistant fiable con Anthropic y ante errores).
6. **A8 + M10** (resultados y reanudación fuera del store).
7. **A5** (adjuntos en la UI, o retirar la promesa).
8. **M31 + M32** (compose completo, `known_hosts` persistente).
9. **M23 + M24 + M27** (barridos que no corren, health caro, sondeo innecesario).
10. **M25, M26, M28, M29** (consola: borrador, búsqueda, Run Center, sesiones sin estrenar).
11. Resto de M y B según uso.
