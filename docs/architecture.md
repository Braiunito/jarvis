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

## Dónde vive la verdad de cada dato

| Dato | Dueño | Persistencia | ¿Reconstruible? |
|---|---|---|---|
| usuarios, passkeys, revocación | gateway | `users.json` + `session.key` | no |
| sesiones descubiertas | CLI remoto / aiSessions | SQLite de aiSessions | sí |
| workspace, borrador | core | SQLite del core | no |
| run, eventos de run | core | SQLite del core | parcialmente |
| proceso del run | host de ejecución | tmux + spool | sí, reconciliable |
| plan, paso, aprobación | core | SQLite del core | no |
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
| terminal | WebSocket | lo único de verdad bidireccional |
| adjuntos | HTTP binario | streaming, sin acumular en memoria |
| core ↔ aiSessions | HTTP interno | timeout y último dato bueno visible |

MCP no es la API de la aplicación: si vuelve, será como adaptador para modelos externos, llamando
a los mismos casos de uso.

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

`apps/core/src` se organiza por verticales (`runs/`, `sessions/`, `plans/`…), cada uno con su
esquema, sus rutas, sus casos de uso y su persistencia juntos. No hay carpetas horizontales de
`controllers`/`services`/`repositories`, ni service locator, ni bus global: las dependencias se
construyen a mano en [`services.ts`](../apps/core/src/services.ts) y se ven de un vistazo.
