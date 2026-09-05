# Arquitectura

## Las cinco entidades

Ninguna finge ser otra. Esa es la mitad del diseño.

| Entidad | Identidad | Quién la posee | Hasta cuándo vive |
|---|---|---|---|
| Host | alias SSH | la configuración | hasta que sale de la flota |
| Sesión de agente | host + provider + sessionId | el CLI remoto | independiente del navegador |
| Workspace | `workspaceId` | el core | entre dispositivos y reinicios |
| Run | `runId` + snapshot del destino | el core y el host de ejecución | hasta estado terminal + retención |
| Terminal | host + nombre tmux | el host remoto | hasta que alguien la destruye |

El Assistant **no** es una sexta variante de sesión: es un coordinador que crea runs y
aprobaciones por los mismos casos de uso que el trabajo directo. La terminal tampoco es un chat:
es un TTY con su propia entrada.

La **conversación** (ADR-009) tampoco es un plan, y por eso tiene su propia tabla. Un plan es una
lista de pasos con checkpoint que puede pasarse cuatro horas esperando a que termine un run; una
conversación es un ida y vuelta que se lee de arriba abajo. Comparten modelo, herramientas,
aprobaciones y auditoría —una conversación puede acabar creando un plan—, pero meterlas en la
misma tabla obligaría a que una de las dos fingiera ser la otra. Y una conversación puede no tener
workspace: preguntar por el servidor no exige haber abierto antes una sesión de agente.

## Dónde vive la verdad de cada dato

| Dato | Dueño | Persistencia | ¿Reconstruible? |
|---|---|---|---|
| usuarios, passkeys, revocación | gateway | `users.json` + `session.key` | no |
| sesiones descubiertas | CLI remoto / aiSessions | SQLite de aiSessions | sí |
| workspace, borrador | core | SQLite del core | no |
| run, eventos de run | core | SQLite del core | parcialmente |
| proceso del run | host de ejecución | tmux + spool | sí, reconciliable |
| plan, paso, aprobación | core | SQLite del core | no |
| conversación y sus mensajes | core | SQLite del core | no |
| catálogo de capacidades MCP | el servidor MCP | caché con TTL en el core | sí |
| terminal | host de ejecución | tmux | sí, redescubrible |
| adjunto | host de ejecución | fichero efímero | no (la metadata sí es durable) |
| cuota de la cuenta | core | snapshot con TTL | sí |

No son durables: un `Map` de Node, un `EventEmitter`, una conexión SSE, el estado de React, un
proceso SSH padre ni una respuesta abierta del Assistant.

## El límite de privilegio

El gateway es el proceso expuesto: TLS por detrás de Caddy, la SPA, las ceremonias WebAuthn y las
cookies. El core es el que tiene la clave SSH de la flota y la capacidad de ejecutar agentes.

Fusionarlos ahorraría un proxy y regalaría la clave al proceso que atiende peticiones anónimas.
Por eso son dos, la cookie no cruza la frontera y el core sólo acepta peticiones con una identidad
firmada con un secreto distinto del de sesión.

## Un run, paso a paso

```
POST /api/runs                  → 202 con runId, antes de que empiece nada largo
  ├─ resuelve el destino        → snapshot: workHost, executionHost, estrategia, cwd, permiso
  ├─ escribe el run             → SQLite, estado `queued`
  └─ reclama los adjuntos       → en la misma transacción que el run

supervisor
  ├─ prepara                    → mkdir spool + meta.json + wrapper.sh + tmux new-session
  │                               idempotente: si la tmux ya existe, no lanza una segunda
  ├─ observa                    → poll por cursor de bytes sobre events.ndjson
  │                               normaliza con el adapter e inserta eventos con `seq`
  └─ concluye                   → status.json terminal, o tmux ausente, o plazo agotado

GET /events/runs/:id            → SSE: replay exacto desde `Last-Event-ID`
```

Las dos cosas que no se pueden confundir: `remote_cursor_bytes` es **cómo lee el core**; `seq` es
**identidad pública** del evento. La primera puede cambiar de implementación; la segunda no se
reutiliza jamás.

## Dónde piensa el asistente

Desde ADR-009 hay dos escalones y una puerta entre ellos. El primero contesta siempre y es barato;
al segundo se le consulta, y sólo si alguien abre la puerta.

```
turno ─► primer escalón ─┬─► decide algo                    → el core lo persiste
                         └─► «esto se me escapa» (escalate) → aprobación → firma → un turno arriba
```

No es «uno barato que reintenta con uno caro»: eso gastaría lo mismo sin que nadie se entere. El
primero se queda corto, **lo dice y espera**. Tampoco sale solo cuando se cae: un modelo que no
responde no es permiso para gastar en el caro. Y el permiso vale para un turno, no para el plan.

Los dos escalones son hoy `gpt-5-nano` y `gpt-5`, y la diferencia es de veinticinco veces el
precio. Durante un día el primero fue un `llama-server` en el propio bastión; la enmienda de
ADR-009 cuenta por qué se retiró y, sobre todo, que cambiarlo fueron cinco variables de entorno.
Los nombres `local` y `cloud` que quedan en el código significan **qué escalón**, no dónde vive.

**El catálogo de capacidades se ofrece de dos formas**, y la elige el core solo. Si cabe bajo el
tope de funciones por petición —128 en la API de OpenAI—, cada capacidad va como herramienta
propia: el modelo la llama por su nombre y **no puede inventarse uno**, porque la API sólo acepta
los declarados. Si no cabe, se vuelve al router: tres herramientas para navegar áreas, buscar y
ejecutar. El segundo modo nació para un modelo al que el catálogo no le cabía en el contexto, y se
queda porque el catálogo sigue creciendo.

## Un turno del Assistant

El Assistant coordina; el estado lo posee el core. Un turno es corto y siempre acaba en algo que
se puede guardar:

```
contexto (resúmenes + referencias)
  → el modelo consulta lo que le falte      search_sessions · get_session_context · get_health
                                            list_runs · get_run · cancel_run · open_terminal_offer
                                            list_capabilities · search_capabilities · use_capability
  → decide una acción del core              create_run · request_approval · ask_human · finish
                                            request_capability · escalate
  → el core persiste el checkpoint y el turno termina
```

Las herramientas llaman a los **mismos casos de uso que REST**, nunca a la API HTTP ni a una copia
de la lógica, y van atadas al plan: no alcanzan el trabajo de otro workspace ni actúan como otra
persona. Lo que devuelven va acotado y dice que va acotado; un modelo al que se le recorta la
evidencia en silencio concluye sobre lo que no vio.

Tres frenos, y ninguno vive en el prompt:

- el presupuesto de consultas por turno lo aplica el toolbox, porque un modelo puede llamar a una
  herramienta que no se le ofreció;
- `finish` cita los trabajos por id y la interfaz enlaza a la evidencia: la síntesis no copia
  buffers;
- ofrecer una terminal deja un dato en el plan; abrirla es un gesto de la persona.

Lo que espera —un run de horas, una aprobación, una respuesta humana— no se espera dentro del
turno: se persiste como paso y el despertador vuelve cuando hay motivo. Por eso un plan sobrevive
a un reinicio del core sin repetir el efecto: la clave de idempotencia es del paso, no de la
ejecución.

## Estrategia A y B

Una sesión vive en una máquina, pero el agente que trabaja sobre ella no tiene por qué correr
ahí:

- **B (preferida)** — el CLI está en el host de la sesión: el agente corre junto al código.
- **A (repliegue)** — no está: el agente corre en el bastión y llega por SSH. Al prompt se le dice
  explícitamente, porque un agente que se cree en la máquina equivocada edita los ficheros
  equivocados.

Lo que se muestra antes de pulsar Enviar es exactamente lo que se guarda como snapshot del run y
lo que la auditoría afirma después. No se recalcula al pintar el historial.

## Transportes

| Necesidad | Transporte | Por qué ese |
|---|---|---|
| consultas y comandos | REST JSON | inspeccionable, con códigos de estado y claves de idempotencia |
| eventos de run | SSE | una sola dirección, reconexión con `Last-Event-ID` |
| hilo de una conversación | SSE | lo mismo, y por lo mismo: el `seq` del mensaje es el id del evento |
| terminal | WebSocket | lo único de verdad bidireccional |
| adjuntos | HTTP binario | streaming, sin acumular en memoria |
| core ↔ aiSessions | HTTP interno | timeout y último dato bueno visible |
| core ↔ servidor MCP | Streamable HTTP | lo que hablan los servidores MCP; sesión en cabecera |

El gateway pone plazo a lo que habla con el core (`JARVIS_CORE_TIMEOUT_MS`), pero **sólo hasta las
cabeceras**: un stream de eventos dura horas por diseño y un WebSocket de terminal puede pasarlas
sin que nadie teclee. Lo que no puede quedarse abierto para siempre es el intento. Un core que
acepta y luego calla responde 504 con `CORE_TIMEOUT`, distinto del 502 de «no llegué»: el primero
significa que el core está vivo y atascado, y eso se diagnostica mirando qué lo tiene ocupado, no
volviendo a pulsar.

Al stream no se le pone plazo porque su latido es contrato del core —`KEEPALIVE_MS` en
`runs/sse.ts`, hoy 15 s—. Es una dependencia que se rompería en silencio, así que quien cambie ese
latido tiene que mirar también el proxy.

MCP no es la API de la aplicación —el navegador no lo habla y ninguna pantalla depende de que un
servidor MCP esté vivo—, pero desde ADR-009 el core sí lo **consume**: los servidores declarados en
su configuración entran por `McpService`, que es un caso de uso con su allowlist, su auditoría y su
salud. La regla del toolbox no se relaja: una herramienta sigue llamando a un caso de uso del core
y nunca a una API HTTP. Lo que cambia es que ahora hay un caso de uso al que llamar.

## Estructura

```
apps/core       dominio, SQLite, supervisor de runs y planes, SSH
apps/gateway    auth, sesión web, estático y proxy
apps/web        la consola
packages/contracts        esquemas TypeBox: DTO, errores y eventos
packages/agent-adapters   SSH, capacidades, adaptadores de CLI, protocolo del spool
packages/testkit          ssh falso, índice falso, autenticador falso
packages/legacy-contract-tests   los contratos congelados de la migración
```

Dentro del core, dos verticales nuevos: `mcp/` (cliente de Streamable HTTP y el caso de uso que
lo gobierna) y `chat/` (la conversación, su stream y sus aprobaciones).

`apps/core/src` se organiza por verticales (`runs/`, `sessions/`, `plans/`…), cada uno con su
esquema, sus rutas, sus casos de uso y su persistencia juntos. No hay carpetas horizontales de
`controllers`/`services`/`repositories`, ni service locator, ni bus global: las dependencias se
construyen a mano en [`services.ts`](../apps/core/src/services.ts) y se ven de un vistazo.
