# Asistente · estado del flujo, fallos y mejoras — 2026-09-06

Revisión de **sólo lectura** sobre `4007089` (HEAD `f1ff46a` sólo toca `backlog.md`, que aquí no se
usa ni se cita). Ningún fichero de código se editó. La suite completa está en verde: **571 pruebas en
33 ficheros** (`npm test`), y las 233 del bloque del asistente también. Nada de lo que sigue lo tapa
una prueba: cada hallazgo marcado `[R]` se reprodujo con un sondeo aparte (Vite SSR sobre las fuentes
+ SQLite en memoria, o Playwright con peticiones interceptadas y datos ficticios, sin tocar red real).

**Ámbito**: `apps/core/src/{chat,assistant,mcp,plans,spend}/`, `apps/core/src/platform/{jobs,job-supervisor}.ts`,
`apps/web/src/screens/assistant.tsx`, `apps/web/src/api/{chat-stream,queries}.ts`,
`apps/web/src/ui/{artifact,ask-assistant,composer,assistant}.tsx`, `packages/contracts/src/chat.ts`,
ADR-009, ADR-010, `docs/security.md`.

**Convención**
- **P0** rompe una promesa del producto (seguridad, durabilidad, «no se sale a la nube sin firma»).
- **P1** deja a la persona bloqueada o le miente.
- **P2** degrada calidad, coste o claridad. **P3** pulido.
- `[R]` reproducido con sondeo · `[L]` confirmado por lectura del código.
- Cada ítem lleva **Cómo hacerlo sin fallo** y **Prueba que lo cierra**.

---

## Seguimiento

Este documento es también el tablero. **Se liquida entero**: cada fila de las tablas de arriba
acaba en `[x]`, y una fila puede cerrarse tanto porque se arregló como porque se decidió no
hacerla —con el motivo escrito—, que también es liquidarla.

**Estado**: `[ ]` pendiente · `[-]` en curso · `[x]` cerrada (con el commit o el motivo en la
sección del ítem).

**Quién**: `core` = todo lo que vive en `apps/core` y `packages/contracts` —seguridad, chat, MCP,
toolbox, planes, jobs, gasto— · `web` = `apps/web` y las pruebas de extremo a extremo.

**Dos sesiones lo liquidan**, no cuatro: las otras dos están en workflows y persistencia, que es
otro encargo. Lo que ya hubieran cerrado de aquí se da por bueno y se acredita.

**Cómo se escribe sin pisarse.** Compartimos árbol, así que:

1. **Cada sesión edita sólo sus propias filas.** Una fila lleva dueño; cambiar la de otro es
   pisarle el estado.
2. **Al cerrar una fila, se escribe el commit en la sección del ítem**, no sólo la marca. La marca
   dice que está hecho; el commit dice qué se hizo.
3. **Commit por rutas**, y este fichero va **solo en su propio commit**: si viaja dentro de uno de
   código, dos sesiones que cierran a la vez colisionan en el que menos importa.
   **Y por ruta no basta.** Este fichero lo escriben los dos, así que `git add` de su ruta se lleva
   también lo que el otro tenga a medias: hay que **mirar `git diff` antes de añadirlo**. Pasó —un
   commit de código se llevó 81 líneas del tablero ajeno, incluida una sección a medio escribir— y
   no se notó porque el contenido estaba entero de casualidad. Con la sección a medias, lo empujado
   habría sido un tablero roto firmado por quien no lo escribió.
4. Si un ítem cambia de dueño, se cambia la columna y se dice en el mensaje, para que no haya dos
   trabajando en lo mismo.
5. Un ítem que se descarta se marca `[x]` y su sección explica **por qué no**, con el mismo detalle
   con el que se explicaría un arreglo. Un pendiente que nadie va a hacer es peor que uno cerrado.

---

## 0. Resumen

| Id | P | Qué | Dónde | Quién | Estado |
|---|---|---|---|---|---|
| R-01 | P1 | Aprobación caducada → conversación bloqueada para siempre | `chat/service.ts` | core | [ ] |
| R-02 | P0 | Un permiso de escalada vale más de un turno en la nube | `chat/service.ts` | core | [ ] |
| R-03 | P0 | El digest de la aprobación nunca se comprueba | `chat/service.ts`, `plans/service.ts` | core | [ ] |
| R-04 | P0 | Un artifact HTML puede salir a la red (iframe anidado, navegación a pelo) | `chat/routes.ts` | core | [x] |
| R-05 | P1 | En modo directo el catálogo MCP se declara **sin parámetros** | `mcp/service.ts` | core | [x] |
| R-06 | P1 | El memo de capacidades mezcla servidores y cobra la repetición | `assistant/toolbox.ts` | core | [ ] |
| R-07 | P1 | Salud dice `ok` con el MCP caído | `mcp/service.ts` | core | [x] |
| R-08 | P1 | Dos envíos seguidos: la primera pregunta no se contesta, la segunda dos veces, y sin job | `chat/service.ts` | core | [ ] |
| R-09 | P1 | El objetivo del turno se pierde con más de 12 trazas de herramienta | `chat/service.ts` | core | [ ] |
| R-10 | P1 | Una conversación larga (>500 filas) pierde su cola al abrirla | `chat/repository.ts`, `routes.ts` | core | [ ] |
| R-11 | P1 | Borrar una conversación deja aprobaciones pendientes y jobs huérfanos | `chat/service.ts` | core | [ ] |
| R-12 | P1 | El esfuerzo de un turno contamina a otra conversación | `assistant/model.ts` | core | [ ] |
| R-13 | P2 | La pasada del juez de esfuerzo no cuenta en el gasto | `assistant/model.ts` | core | [ ] |
| R-14 | P1 | Cancelar un plan mientras piensa lo resucita (y lanza el run) | `plans/service.ts` | core | [ ] |
| R-15 | P1 | Un paso `run` sin `runId` no es checkpoint: se salta | `plans/service.ts` | core | [ ] |
| R-16 | P1 | Una tabla con `label` no textual tumba la pantalla (sin ErrorBoundary) | `chat/artifacts.ts`, `ui/artifact.tsx` | web | [x] |
| R-17 | P2 | Un artifact estructurado grande se recorta a bytes y deja de ser JSON | `chat/artifacts.ts` | core | [ ] |
| L-01 | P0 | `JARVIS_CHAT_DEFAULT_AUTONOMY` mal escrito abre la puerta (fail-open) | `config.ts`, `toolbox.ts` | core | [x] |
| L-02 | P0 | `resolveApproval` no es atómica; un `approved` sin consumir bloquea | `chat/service.ts` | core | [ ] |
| L-03 | P1 | Cualquier usuario ve, borra y firma las conversaciones de los demás | `chat/service.ts`, rutas | core | [ ] |
| L-04 | P1 | La conversación no puede parar los trabajos que ella lanzó | `chat/service.ts`, `toolbox.ts` | core | [ ] |
| L-05 | P1 | Errores de herramienta MCP se venden como «reintenta» → bucles | `mcp/service.ts` | core | [x] |
| L-06 | P1 | Los intentos de escritura MCP fallidos no se auditan | `mcp/service.ts` | core | [x] |
| L-07 | P1 | La pantalla miente en «Automático» y nunca ofrece `unrestricted` | `screens/assistant.tsx` | web | [x] |
| L-08 | P1 | El distintivo enseña el id del híbrido; el gasto no lleva conversación | `chat/service.ts`, `services.ts` | core | [ ] |
| L-09 | P2 | El contexto enseña trabajos que el toolbox no deja mirar | `chat/service.ts`, `toolbox.ts` | core | [ ] |
| L-10 | P2 | La traza de `present` duplica el artifact en hilo y contexto | `chat/service.ts` | core | [ ] |
| L-11 | P2 | Un envío que falla borra lo escrito sin decirlo | `screens/assistant.tsx` | web | [x] |
| L-12 | P2 | Aprobaciones caducadas siguen en pantalla; «caduca en 0 min» no se mueve | core + web | core | [ ] |
| L-13 | P2 | Cada mensaje del stream invalida la lista y el gasto | `api/chat-stream.ts`, pantalla | web | [x] |
| L-14 | P2 | `EventSource` reconecta para siempre tras borrar / 401 | `api/chat-stream.ts` | web | [x] |
| L-15 | P2 | Dos tarjetas de aprobación distintas; la del plan recorta el prompt | `ui/assistant.tsx` | web | [x] |
| L-16 | P2 | `readOnly` en el core no impide que el servidor ejecute lo sin etiquetar | `mcp/service.ts` | core | [x] |
| L-17 | P3 | Prompt local desactualizado, asimetría Anthropic, tipos en rutas | varios | core | [ ] |
| L-18 | P2 | No hay e2e del asistente | `tests/e2e` | web | [x] |

---

## A. Fallos reproducidos `[R]`

### R-01 · P1 · Una aprobación caducada deja la conversación bloqueada para siempre

- **Dónde**: `chat/service.ts` → `resolveApproval` (rama `APPROVAL_EXPIRED`), `#turn`
  (`if (conversation.status === 'waiting_approval') return;`), `send()`.
- **Síntoma**: pasados los 30 min, pulsar «Autorizar» devuelve `APPROVAL_EXPIRED`; la fila queda en
  `waiting_approval` **sin ninguna aprobación pendiente**; cada mensaje nuevo se guarda y `#turn` sale
  sin pensar. La persona ve su pregunta y ninguna respuesta, sin explicación.
- **Sondeo**: `{code:"APPROVAL_EXPIRED", status:"waiting_approval", pending:0, lastRole:"user"}`.
- **Causa**: la caducidad se anota en la aprobación y no en la conversación; `#turn` decide por el
  estado de la fila, no por si de verdad queda una aprobación viva. `reconcile()` sólo libera `thinking`.
- **Cómo hacerlo sin fallo**:
  1. En `resolveApproval`, al detectar caducidad: `append({role:'event', text:'La aprobación caducó sin respuesta. Vuelve a pedírmelo si sigue haciendo falta.'})`, `setStatus(id,'idle','local')`, `bus.notify(id)`, y **después** lanzar el error.
  2. En `#turn`, sustituir la guarda por «¿hay aprobación `pending` con `expires_at > now`?». Si sólo hay caducadas, marcarlas `expired`, escribir el evento y seguir pensando.
  3. En `reconcile()`, además de `thinking`, barrer `waiting_approval` sin aprobación viva → `idle` + evento.
  4. `pendingApprovals()` filtra `expires_at > ?` (o marca `expired` al leer), para que la interfaz no pinte cartas muertas (ver L-12).
- **Prueba que lo cierra**: `tests/integration/chat.test.ts`: escalar → avanzar reloj 31 min →
  resolver lanza `APPROVAL_EXPIRED` → `send('otra')` → el modelo recibe una llamada y contesta,
  `status === 'idle'`. Otra: arrancar con fila `waiting_approval` y aprobación caducada → `reconcile()`
  la libera y escribe el evento.

### R-02 · P0 · Un permiso para salir a la nube vale más de un turno

- **Dónde**: `#executeApproval` (ramas `capability` y `run`: `setStatus(id,'idle')` **sin `source`**),
  `#runCapability` (igual), `#applyDecision` (ramas `capability`, `approval`, `escalate` no devuelven
  `source` a `local`; sólo `finish` y `ask` lo hacen).
- **Síntoma**: escalada firmada → el turno en la nube pide una capacidad → se autoriza la capacidad →
  el turno que interpreta el resultado **vuelve a ir a la nube sin tarjeta**. Peor: si el turno en la
  nube pide un run y se aprueba, la fila queda `source='cloud'` y **el siguiente mensaje de la persona**
  se piensa en la nube.
- **Sondeo**: 1 escalada firmada, 1 capacidad firmada → **2 llamadas al modelo caro**.
- **Causa**: ADR-009 §2 dice «el permiso vale para un turno», pero el código sólo cierra la puerta en
  las dos decisiones que terminan el turno con texto.
- **Cómo hacerlo sin fallo**: cerrar la puerta al terminar `decide`, no al terminar la respuesta. En
  `#turn`, tras `#applyDecision`: si `source === 'cloud'`, `repository.setStatus(id, <estado actual>, 'local')`
  (helper `#setSource(id,'local')` que no toque `status`). Si el modelo de nube quiere seguir en la
  nube en el turno siguiente, tiene que volver a pedir `escalate`. Cambio mínimo alternativo: pasar
  `'local'` en los tres `setStatus` de `#executeApproval`/`#runCapability` y en las ramas
  `capability`/`approval`/`escalate` de `#applyDecision` usar `setStatus(id,'waiting_approval','local')`.
  Anotar en ADR-009 §2 que «un turno» = una llamada a `decide`.
- **Prueba**: `chat.test.ts` «la nube pide una capacidad; aprobarla no vuelve a llamar a la nube»
  (`cloud.calls === 1`) y «tras un run aprobado en la nube, el siguiente mensaje lo piensa el local».

### R-03 · P0 · El digest de una aprobación se guarda y nunca se comprueba

- **Dónde**: `chat/service.ts` `resolveApproval` / `#executeApproval`; `plans/service.ts`
  `#resolveStep` (rama `approved`).
- **Sondeo**: se altera `target_json` de una aprobación pendiente (`fake.write{x:1}` →
  `fake.changed{x:2}`) y al autorizar **se ejecuta `fake.changed`**; `action_digest` sigue intacto.
- **Causa**: el digest se calcula sólo en `#createApproval` y en las dos inserciones de plan; nadie lo
  recomputa al consumir. `docs/security.md` promete «cambiar cualquier parte la invalida».
- **Cómo hacerlo sin fallo**: módulo compartido `platform/approvals.ts` con
  `approvalDigest(actionType, target)`; usarlo en los tres puntos de creación. En `resolveApproval`
  (chat y plan), **antes** de cambiar estado: recomputar desde `target_json`, comparar con
  `action_digest`; si no casa → `status='rejected', resolved_by='system'`, auditoría
  `approval.tampered`, lanzar `CONFLICT`. Serializar `target` con claves ordenadas para que el digest
  sea estable.
- **Prueba**: unidad en `apps/core/test`: mutar `target_json` y resolver → `CONFLICT`, nada ejecutado,
  fila de auditoría. Igual para plan.

### R-04 · P0 · Un documento HTML del asistente puede salir a la red

- **Dónde**: `chat/routes.ts` `/api/chat/:id/artifacts/:artifactId/raw` (CSP), `ui/artifact.tsx`
  `HtmlArtifact`.
- **Sondeo** (Playwright, canario `audit-canary.invalid` interceptado con `route.abort`, cero tráfico
  real): **embebido**, un `<iframe src="http://…">` dentro del artifact **sí intenta cargar** —el
  `frame-src 'self'` de la aplicación gobierna sólo el iframe de primer nivel; el documento del
  artifact no declara `frame-src`/`child-src` ni `default-src`—. **Abierto como pestaña**,
  `location.href='http://…'` **navega**: el sandbox restringe frames, no al documento raíz.
- **Causa**: CSP de lista blanca parcial sin `default-src 'none'`; la ruta sirve el documento para
  cualquier destino de petición. El comentario del fichero y ADR-010 §1 afirman «ni un intento llega a
  la red»: la verificación cubrió `connect`/`img`/`form`, no `frame` ni navegación.
- **Cómo hacerlo sin fallo**:
  1. CSP completa: `default-src 'none'; sandbox allow-scripts; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-src 'none'; child-src 'none'; worker-src 'none'; media-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'`.
  2. La ruta exige `sec-fetch-dest: iframe` (Chromium/Firefox/Safari lo mandan); sin ella → 403
     «este documento sólo se sirve embebido en la consola». Así el artifact nunca existe como pestaña y
     `<a target=_top>`, `<meta http-equiv=refresh>` y `location` dejan de tener adónde ir.
  3. El `<iframe>` sigue con `sandbox="allow-scripts"` y sin `allow-popups` (un `window.open` sería la
     tercera puerta).
  4. Corregir el comentario de `routes.ts` y ADR-010 §1; añadir el caso a `docs/security.md`.
- **Prueba**: `tests/integration/artifacts.test.ts`: la CSP contiene `default-src 'none'` y
  `frame-src 'none'`; petición sin `sec-fetch-dest: iframe` → 403. E2E Playwright con canario y
  `route.abort`: cero peticiones externas en los dos escenarios (embebido y URL directa).

### R-05 · P1 · En modo directo el catálogo se declara sin parámetros

- **Dónde**: `mcp/service.ts` `asToolDefinitions()` → `this.capabilities()` → `#toCapability(runtime, tool)`
  **sin** `{schema:true}` → `toInputSchema(undefined)` = `{type:'object', properties:{}}`.
- **Sondeo**: `DIRECT_SCHEMA {"type":"object","properties":{}}` para una herramienta con `path` requerido.
- **Efecto**: el modelo ve las 108 capacidades «sin parámetros»: `docker_restart` sin `container`,
  `grep_text` sin patrón, `cpu_sampled` sin `seconds`. Llama sin argumentos, el servidor rechaza, se
  pierde la vuelta y se cae a L-05. Contradice la enmienda de ADR-009 («elige a la primera y con esquema»).
- **Cómo hacerlo sin fallo**: `asToolDefinitions` recorre runtimes y usa `#toCapability(runtime, tool,
  { schema: true })`; `toInputSchema` conserva `required`, `additionalProperties` y `description` de
  cada propiedad. Aprovechar para dar en `description` el docstring completo acotado (p. ej. 600
  caracteres) en vez de `summary`: en directo el modelo nunca busca, así que «descripción completa para
  usar» sólo se cumple si va aquí (medir tokens: el catálogo pasa de ~5300 a ~9000; sigue siendo
  barato en gpt-5-nano).
- **Prueba**: `mcp.test.ts`: `asToolDefinitions()` para `docker_restart` trae `required: ['container']`;
  `chat.test.ts` (modo directo): el modelo llama `mcp__zeus__docker_restart` con `{container}` y el
  argumento llega al servidor falso.

### R-06 · P1 · El memo de capacidades mezcla servidores y cobra la repetición

- **Dónde**: `assistant/toolbox.ts` `#useCapability` (clave `${bare}:${JSON(args)}` sin servidor);
  `invoke()` deja las capacidades fuera del memo de `invoke` **y** del contador `repeats`, pero
  **sí** les suma `#observations += 1` antes de llegar al memo propio.
- **Sondeo**: `a.read{path}` y luego `b.read{path}` → la segunda devuelve `ALREADY_ASKED` con el
  resultado del servidor `a`; `calls:1, observations:2, repeats:0`.
- **Efecto**: con dos servidores MCP, el segundo no se consulta nunca por el mismo nombre; y una
  repetición gasta presupuesto y no se cuenta como repetición (la métrica de ADR-009 se queda ciega).
- **Cómo hacerlo sin fallo**: clave `${servidorResuelto}.${bare}:${JSON canónico}` (resolver con un
  `mcp.resolveName(name)` barato, sin llamar); reutilizar `memoKey` (ordena claves). Mover la
  comprobación del memo de capacidades **antes** de `#observations += 1` (misma posición que el memo
  de las propias) y hacer `#repeats += 1` al cortar. En modo directo el nombre ya lleva servidor
  (`mcp__zeus__x`): la clave sale del `direct.get(name).name`.
- **Prueba**: unidad: dos servidores con `read` → dos llamadas; repetir exacta → `repeats === 1`,
  `observations` no sube, `calls` no sube.

### R-07 · P1 · Salud dice `ok` con el MCP caído

- **Dónde**: `mcp/service.ts` `#catalogOf` devuelve el catálogo viejo **sin lanzar** cuando el
  refresco falla; `states()` entra por la rama de éxito.
- **Sondeo**: TTL vencido + `fetch` fallando → `status:'ok', lastError:null` en ambos servidores.
- **Efecto**: el salto de Salud y la pastilla del carril («zeus · 108») nunca pasan a `stale`;
  el asistente sigue ofreciendo capacidades que fallarán al llamar, y nadie ve por qué.
- **Cómo hacerlo sin fallo**: `#catalogOf` devuelve `{ catalog, stale }` o anota
  `runtime.staleSince`; `states()` reporta `'stale'` + `lastError` cuando `runtime.lastError !== null`
  o `now - catalog.at > ttl`. `capabilities()`/`search`/`describe` siguen sirviendo el viejo. Añadir
  `capabilityStale: boolean` a `ChatCapabilities` para que `StatusLine` lo pinte en ámbar.
- **Prueba**: `mcp.test.ts` «con catálogo cacheado y servidor caído, `states()` dice `stale` y
  conserva `lastError`»; la prueba de Salud existente debe cubrir este caso.

### R-08 · P1 · Dos mensajes seguidos: la primera pregunta no se contesta, la segunda dos veces, y el segundo sin job

- **Dónde**: `send()` (un job/kick por mensaje), `#contextFor` (`objective = último mensaje de la
  persona`), `jobs.enqueue` (devuelve el vivo y **no** actualiza `watermark_seq`).
- **Sondeo**: `send('primera'); send('segunda')` → dos turnos con `objective:'segunda'`, dos respuestas
  a la misma pregunta, «primera» nunca es objetivo; `jobs: {done:1}` → el segundo mensaje **no tiene
  job**: si el core cae durante el segundo turno no queda rastro de que hubiera que contestarlo. La
  promesa de la migración 16 se rompe para todo mensaje enviado mientras se piensa.
- **Cómo hacerlo sin fallo** (elegir una):
  - **(a) coalescer** — en `#kick`, si hay turno en vuelo, no encadenar otro: marcar `pending`. Al
    liberar, si existen mensajes `user` posteriores al último `assistant`, lanzar **un** turno cuyo
    objetivo son todos ellos en orden («Primera. \n\n Segunda.»). `jobs.enqueue` con job vivo debe
    `bump(watermark_seq)` al del nuevo mensaje para que `reconcile` lo vea.
  - **(b) rechazar** — `send()` con `status === 'thinking'` → 409 `BUSY`; el composer se deshabilita
    con «pensando…» y guarda el borrador.
  - (a) es mejor experiencia; (b) es dos líneas. En ambos, el job del segundo mensaje tiene que existir.
- **Prueba**: `chat-durable.test.ts`: dos envíos → una única respuesta cuyo objetivo contiene ambos
  (el `ScriptedBrain` devuelve `context.objective`); «con dos mensajes sin contestar y reinicio, el job
  recuperado los contesta».

### R-09 · P1 · El objetivo del turno se pierde si hay más de 12 trazas de herramienta

- **Dónde**: `#contextFor`: `lastMessages(id, 12)` y `lastUser` se busca **dentro** de esa ventana.
- **Sondeo**: 1 mensaje de persona + 13 filas `tool` → `objective: ''`, `messages: 12` (todas tool).
- **Cuándo pasa de verdad**: `chatMaxToolCalls = 12` más `present`; el turno encadenado tras una
  capacidad aprobada (`#runCapability → #kick`) y el turno rehecho tras un reinicio piensan **sin saber
  qué se preguntó**. El modelo contesta a nada o se pone a diagnosticar.
- **Cómo hacerlo sin fallo**: `objective` sale de una consulta propia
  (`repository.lastUserMessage(id)`), nunca de la ventana. La ventana de historia cuenta mensajes
  `user/assistant/event` (12) y adjunta las `tool` del último turno con tope propio (p. ej. 24, recortadas
  a 400). `#knownSessions`/`#foundIn` leen refs de mensajes de asistente, así que no pierden nada.
- **Prueba**: integración: 20 trazas tras la pregunta → `context.objective === pregunta` y el hilo
  conserva la última respuesta del asistente.

### R-10 · P1 · Una conversación larga pierde su cola al abrirla

- **Dónde**: `chat/repository.ts` `messages()` `limit = 500` por defecto; `GET /api/chat/:id` sirve
  desde `seq 0`.
- **Sondeo**: 516 filas → se sirven las 500 primeras (última `seq 499`); los 16 mensajes más nuevos
  —la respuesta que se acaba de leer— no llegan. El stream sin `Last-Event-ID` arranca en `-1` y
  reenvía todo, así que además se duplica el tráfico. Con 12 consultas por turno se llega a 500 en
  ~35 turnos.
- **Cómo hacerlo sin fallo**: el GET sirve **los últimos N** (`ORDER BY seq DESC LIMIT ?` + reverse) y
  devuelve `firstSeq` / `hasMore`; `useChatStream(conversationId, fromSeq)` abre el `EventSource` con
  `?lastEventId=<último seq servido>`; botón «cargar anteriores» con `beforeSeq`. Mínimo viable:
  `limit` a 5000 y sin límite en el stream (`flush` ya pagina por `afterSeq`).
- **Prueba**: integración: 600 filas → la respuesta trae la última; e2e: abrir conversación larga
  muestra la última burbuja y no hay `seq` duplicados.

### R-11 · P1 · Borrar una conversación deja aprobaciones pendientes y jobs huérfanos

- **Dónde**: `ChatService.delete` → `repository.delete` (sólo `conversations`; `chat_messages` y
  `chat_artifacts` van por `CASCADE`; `approvals.conversation_id` y `jobs.resource_id` no tienen FK).
- **Sondeo**: tras borrar, la aprobación sigue `pending` y el job sigue en `jobs`. Resolverla por
  `POST /api/approvals/:id` → `#executeApproval` → `append` sobre conversación inexistente → FK → 500.
  Un turno en vuelo sigue pensando (gasta) y falla al escribir (excepción tragada por `#kick`).
- **Cómo hacerlo sin fallo**: en `delete`, una transacción: `UPDATE approvals SET status='expired' WHERE
  conversation_id=? AND status='pending'`; `UPDATE jobs SET status='failed', last_error='conversación
  borrada' WHERE resource_type='conversation' AND resource_id=? AND status IN ('ready','running')`;
  `DELETE FROM conversations`. Abortar el turno en vuelo (ver F-01). Opción de esquema: migración
  nueva con FK `approvals.conversation_id → conversations(id) ON DELETE CASCADE` (no editar la 12).
- **Prueba**: integración: borrar con aprobación pendiente → `pendingApprovals` vacío, `jobs.alive`
  nulo, resolver la aprobación → `NOT_FOUND`/`CONFLICT`, nunca 500.

### R-12 · P1 · El esfuerzo de un turno contamina a otra conversación

- **Dónde**: `assistant/model.ts` `OpenAiCompatibleModel`: `#turnEffort` y `#turnJudged` son campos
  de la **instancia**, y hay una instancia por core compartida por todas las conversaciones y planes.
- **Sondeo**: A se juzga `high`; mientras A espera una herramienta, B se juzga `minimal` → la segunda
  vuelta de A sale con `reasoning_effort: low` y **sólo `finish`** (`decisionsOnly` por
  `#turnJudged === 'minimal'`): A se ve obligada a contestar sin poder consultar. `MODEL_CONCURRENT`:
  `A/high/[read,finish] · B/low/[finish] · A/low/[finish]`.
- **Cómo hacerlo sin fallo**: el esfuerzo es del turno: calcularlo al principio de `decide` en una
  `const effort` y pasarla a `#ask(messages, tools, effort)` y `#report(…, effort)`. Borrar los dos
  campos y `#effortNow()`.
- **Prueba**: `assistant-tools.test.ts`: dos `decide` entrelazados con un fetch que bloquea → cada
  petición lleva el esfuerzo de su propio juez y A sigue viendo `read`.

### R-13 · P2 · La pasada del juez no se contabiliza en el gasto

- **Dónde**: `#judgeEffort` no llama a `#report`.
- **Sondeo**: 5 peticiones al proveedor, 3 filas en `model_spend`.
- **Cómo hacerlo sin fallo**: `#report(body.usage, undefined, started)` también ahí, con un campo
  `phase: 'judge' | 'turn'` en `ModelTurnUsage` para poder desglosarlo en `SpendBadge`.
- **Prueba**: unidad: con `reasoningEffort: 'auto'`, `onUsage` se llama una vez más por turno.

### R-14 · P1 · Cancelar un plan mientras el modelo piensa lo resucita

- **Dónde**: `plans/service.ts` `#proposeNext`: tras `await model.decide` escribe pasos y estado sin
  releer `status`; `#setPlanStatus` y los `INSERT` no condicionan por estado terminal.
- **Sondeo**: `cancel()` durante `decide` → con decisión `run` **se crea un run** después de cancelar;
  con `ask`, el plan pasa a `waiting_input` con `finishedAt` puesto (`PLAN_CANCEL_RESURRECTION`).
- **Cómo hacerlo sin fallo**: tras `decide` (y tras cada `await` largo en `#resolveStep`):
  `const fresh = this.require(planId); if (terminal(fresh.status)) { audit('plan.decision_discarded'); return fresh; }`.
  Además `#setPlanStatus` con `WHERE status NOT IN ('completed','failed','cancelled')` y comprobar
  `changes`. El supervisor ya reintenta si un run se creó de más: el `idempotencyKey` del paso lo hace
  observable.
- **Prueba**: `assistant.test.ts` «cancelar durante el turno no lanza el run ni cambia el estado».

### R-15 · P1 · Un paso `run` sin `runId` no es un checkpoint: se salta

- **Dónde**: `#resolveStep`: `if (step.runId)…; if (kind==='approval')…; if (kind==='input')…;
  return true`. Un paso `run` insertado como `running` y sin `run_id` (core muerto entre el `INSERT` y
  `runs.create`) cae al `return true`.
- **Sondeo**: paso `run/running/runId:null` → el plan propone el siguiente y termina `completed`; el
  paso queda `running` para siempre y el trabajo que prometía nunca existe.
- **Cómo hacerlo sin fallo**: rama explícita `if (step.kind === 'run' && !step.runId)` → reintentar
  `runs.create` con `step.idempotencyKey` (si ya se creó, vuelve `replayed:true`); si falla →
  `#completeStep(failed, RUN_REJECTED)` + `#finish`. Es exactamente lo que promete el docstring de
  `#proposeNext`.
- **Prueba**: integración: sembrar el checkpoint a medias → `advance` crea u observa el run y el paso
  pasa a `waiting_run`.

### R-16 · P1 · Una tabla con `label` no textual tumba la pantalla entera

- **Dónde**: `chat/artifacts.ts` `validateTable` (no valida `label` ni `align`); `ui/artifact.tsx`
  `TableArtifact` pinta `{column.label}`; **no existe ningún `ErrorBoundary`** en `apps/web/src`.
- **Sondeo**: `validateBody('table', {columns:[{key:'x',label:{…}}], rows:[{x:1}]})` → `null`. En
  React, un objeto como hijo lanza y desmonta `AssistantScreen` entera (hilo, composer, carril).
- **Cómo hacerlo sin fallo**: validar `label` string no vacío y `align ∈ {left,right}`; celdas
  `typeof cell === 'object' ? JSON.stringify(cell) : String(cell)`. En la web, un `ErrorBoundary` por
  `MessageBubble` y por `ArtifactView` que pinte «este contenido no se pudo mostrar» + cuerpo en crudo,
  y otro en `AssistantScreen` que conserve el composer.
- **Prueba**: `artifacts.test.ts` rechaza `label` no string; proyecto `web` con jsdom: una tabla mal
  formada no rompe el árbol.

### R-17 · P2 · Un `table`/`chart`/`json` grande se recorta a bytes y deja de ser JSON

- **Dónde**: `ArtifactRepository.create` recorta `raw.subarray(0, 256 KiB)` para cualquier `kind`.
- **Sondeo**: tabla de 270 KB → `truncated:true`, cuerpo no parseable → la interfaz muestra 256 KB
  en crudo (`Fallback`), que en móvil es una pantalla inutilizable.
- **Cómo hacerlo sin fallo**: para kinds estructurados, recortar **por filas/puntos/claves** hasta
  caber (re-serializar) y guardar `originalRows`; `previewOf` dirá «120 de 3000 filas». O rechazar con
  `BAD_INPUT` «demasiadas filas: enséñame las N que importan».
- **Prueba**: unidad: tabla enorme → cuerpo JSON válido, `truncated`, filas ≤ tope.

---

## B. Confirmado por lectura `[L]`

### L-01 · P0 · `JARVIS_CHAT_DEFAULT_AUTONOMY` mal escrito abre la puerta

- `config.ts`: `(env[...] || 'manual') as 'manual' | 'auto'` sin validar. `ChatService.create` guarda
  lo que llegue. `toolbox.ts #createRun`: `preguntar = autonomy === 'manual' || (autonomy === 'auto' &&
  profile !== 'safe')` → con `'Manual'`, `'foo'` o cualquier errata, `preguntar = false` y un trabajo con
  perfil `auto` **se lanza sin tarjeta**. `#autonomyOf` sólo degrada `unrestricted`. Fail-open por
  errata en un `.env`.
- **Cómo**: en `config.ts`, `AUTONOMY_MODES.includes(v) ? v : 'manual'` con aviso al arrancar; mover
  `autonomyOf` de `plans/service.ts` a `contracts` y usarla en `#autonomyOf` (desconocido → `manual`);
  invertir `#createRun` a fail-closed: `const suelto = autonomy === 'unrestricted' || (autonomy === 'auto'
  && profile === 'safe'); if (!suelto) → approval`.
- **Prueba**: unidad toolbox con `autonomy: 'foo' as never` → decisión `approval`; unidad de config.

### L-02 · P0 · `resolveApproval` (chat) no es atómica y no recupera un `approved` sin consumir

- Dos `UPDATE` (`approved`, luego `consumed`) fuera de transacción y con un `await` de auditoría en
  medio. Un reinicio entre ambos deja `status='approved'`: `pendingApprovals` no la lista (sólo
  `pending`), la conversación sigue `waiting_approval` → bloqueada como en R-01. El plan sí reintenta
  en `#resolveStep`; el chat no tiene ese camino.
- **Cómo**: una sola sentencia `UPDATE approvals SET status='consumed', resolved_by=?, resolved_at=?,
  consumed_at=? WHERE id=? AND status='pending' AND expires_at > ?` y decidir por `changes`; guardar
  `resolved_by/at` también para `rejected`. `reconcile()` barre `approved` de conversaciones y las
  ejecuta (o las marca `expired` con evento). Escribir el resultado en la misma transacción que el
  efecto cuando el efecto es local (escalada); para capacidades/runs, consumir antes y auditar el fallo.
- **Prueba**: integración con fila `approved` sembrada → `reconcile()` desbloquea; kill entre
  updates simulado con un `db` que lanza en el segundo.

### L-03 · P1 · Cualquier usuario ve, borra y firma las conversaciones de los demás

- `list()`, `require()`, `delete()`, `setAutonomy()`, `resolveApproval()` no miran `created_by` ni
  `requested_by`. El gateway distingue usuarios y la auditoría también, pero el dominio no.
- **Cómo**: `list({ user })` filtra por `created_by`; `require(id, user)` → `NOT_FOUND` si no es suyo;
  aprobaciones sólo para `requested_by` (o admins por `JARVIS_ADMINS`). Mismo trato en planes y en
  `/api/approvals/:id`.
- **Prueba**: integración con dos identidades.

### L-04 · P1 · La conversación no puede parar los trabajos que ella misma lanzó

- `#cancelRun` exige `ownRunIds`, que sólo pasa `plans/service.ts`; `#toolboxFor` del chat no lo pasa
  → siempre `FORBIDDEN`, con una pista («pídelo con request_approval») que sin workspace ni existe.
- **Cómo**: en `#toolboxFor`, `ownRunIds` = ids de refs `run` y `runIds` del hilo (ya se recorre para
  `#knownSessions`) ∪ `runs.listByRequester('chat:<id>')` (el `requestId` con el que se crean).
- **Prueba**: integración: lanzar en `auto`, luego `cancel_run` → cancelado y auditado.

### L-05 · P1 · Errores de herramienta MCP se venden como «reintenta»

- `McpService.call`: todo fallo → `UPSTREAM_UNAVAILABLE retryable:true` (el ternario
  `MCP_TIMEOUT ? 'UPSTREAM_UNAVAILABLE' : 'UPSTREAM_UNAVAILABLE'` es código muerto). `MCP_TOOL_ERROR`
  (argumento inválido, `unexpected_keyword_argument`, ruta fuera de `MCP_READ_ROOTS`) y
  `MCP_UNAUTHORIZED` van al mismo saco, y el toolbox añade «puede funcionar si se reintenta» → el
  modelo reintenta lo mismo hasta agotar el presupuesto. `fitToSchema` no comprueba `required`, así que
  faltar un argumento acaba aquí también.
- **Cómo**: mapear `MCP_TOOL_ERROR → 'BAD_INPUT'` no reintentable con el mensaje del servidor acotado;
  `MCP_UNAUTHORIZED → 'FORBIDDEN'`; `MCP_TIMEOUT/MCP_UNAVAILABLE → 'UPSTREAM_UNAVAILABLE'` reintentable.
  `fitToSchema` devuelve `missing[]` y `call` rechaza con `BAD_INPUT «falta container»` antes de salir.
- **Prueba**: `mcp.test.ts` con los tres tipos de fallo.

### L-06 · P1 · Los intentos de escritura fallidos no se auditan

- `#audit.record` va después del `try/catch` que relanza: un `docker_restart` que falla en el servidor
  no deja `mcp.write`; y uno que triunfa y el core cae antes del `record` tampoco.
- **Cómo**: `mcp.write.requested` **antes** de llamar (nombre, digest de args, actor) y
  `mcp.write` / `mcp.write.failed` después. Para lecturas basta después.
- **Prueba**: unidad: servidor que falla → dos filas de auditoría.

### L-07 · P1 · La pantalla miente en «Automático» y nunca ofrece `unrestricted`

- `screens/assistant.tsx` `AUTONOMY_OPTIONS` es fijo: la pista de `auto` dice «incluido con permiso de
  escritura» (el comentario avisa de que se revertiría cuando el core cumpliera; **el toolbox ya cumple
  ADR-010**, así que ahora miente al revés). `capabilities.autonomyModes` se ignora: con
  `JARVIS_ALLOW_UNRESTRICTED=1` nunca se puede elegir «Sin preguntar», y una conversación ya en
  `unrestricted` se pinta como «Manual» (fallback del `find`).
- **Cómo**: opciones derivadas de `capabilities.autonomyModes`; etiquetas y pistas en `ui/labels.ts`
  (`AUTONOMY.manual/auto/unrestricted`, esta última «Sin preguntar», tono `danger`); si el modo de la
  fila no está en la lista, enseñar «Sin preguntar (degradado a Automático)».
- **Prueba**: snapshot/e2e con `autonomyModes` de tres y con conversación `unrestricted` y flag apagado.

### L-08 · P1 · El distintivo enseña el id del híbrido; el gasto no lleva conversación

- `#turn` pasa `model.id` (`gpt-5-nano+claude-sonnet-5`) como `modelId` de cada mensaje;
  `SourceBadge`/`shortModel` lo pintan tal cual (visto en el sondeo: `models:["cheap+expensive"]`).
  `SpendService.record` admite `conversationId` pero `meter` en `services.ts` nunca lo pasa: la columna
  `model_spend.conversation_id` está siempre a `NULL`.
- **Cómo**: `HybridModel.decide` devuelve `{ decision, brainId }` o expone `brainFor(source)`;
  `#applyDecision` escribe ese id. Para el gasto, añadir `conversationId?` a `PlanContext` (o
  `actorRef` en el toolbox) y que `onUsage` lo reciba.
- **Prueba**: integración: `messages[].modelId === 'local'` cuando piensa el local y `'nube'` tras
  escalar; `model_spend.conversation_id` relleno.

### L-09 · P2 · El contexto enseña trabajos que el toolbox no deja mirar

- `#house()` enseña hasta 4 runs vivos de **cualquier** workspace; `get_run`/`list_runs` sólo los del
  workspace de la conversación y, sin workspace, nada. El modelo dice «hay 2 trabajos corriendo» y no
  puede contar cuáles. Además `#house` filtra sobre `listRecent(12)`: con 12 terminados recientes, los
  vivos desaparecen del contexto.
- **Cómo**: `runs.listActive(limit)` (ya hay `countActive`); `get_run` (lectura) acepta cualquier run
  cuyo id venga en `house` o en refs del hilo; el aislamiento se mantiene para `cancel_run`.
- **Prueba**: unidad toolbox.

### L-10 · P2 · La traza de `present` duplica el artifact en el hilo y en el contexto

- `RecordingToolbox.invoke` escribe fila `tool` también para `present` (1200 caracteres de eco) y
  `#contextFor` mete `present → …` en los últimos 12 mensajes: ruido en pantalla y tokens en cada turno
  siguiente.
- **Cómo**: no escribir fila para herramientas `free`, o escribir un texto corto
  (`title · kind · presentation`).
- **Prueba**: integración: presentar no deja fila `tool`.

### L-11 · P2 · Un envío que falla borra lo escrito sin decirlo

- `submit()` hace `setDraft('')` antes de que la mutación resuelva y `send.error` nunca se pinta (sólo
  `ask.error`). Un 500, un 409 o un timeout → texto perdido y pantalla muda.
- **Cómo**: limpiar el borrador en `onSuccess`; `<ErrorNote error={send.error} onRetry>`; en error,
  restaurar el borrador.
- **Prueba**: e2e con `route.fulfill({status:500})`.

### L-12 · P2 · Aprobaciones caducadas siguen en pantalla y «caduca en 0 min» no se mueve

- `pendingApprovals` no filtra `expires_at`; `expiresIn` se calcula una vez por render. Pulsar →
  `APPROVAL_EXPIRED` y R-01.
- **Cómo**: filtrar en el core; en `ApprovalCard`, `setInterval(30 s)` para el contador y estado
  «caducada» con botón «Volver a pedir» que reenvía el último mensaje de la persona.

### L-13 · P2 · Cada mensaje del stream invalida la lista y el gasto

- Cada `flush` manda `chat.state` y el cliente invalida `['conversations']` → un turno de 12 consultas
  dispara 13 refetch de `/api/chat`, que además cuenta el catálogo MCP. El `useEffect` de
  `spend.refetch` corre en cada `idle` **y** en cada mensaje.
- **Cómo**: invalidar sólo si `status` o `title` cambian respecto al estado previo; refrescar gasto sólo
  en la transición `thinking → idle`.

### L-14 · P2 · `EventSource` reconecta para siempre tras borrar o 401

- `onerror` sólo pone `connected:false`. Tras borrar la conversación o caducar la sesión, el navegador
  reintenta indefinidamente y `connected` no se enseña en ningún sitio.
- **Cómo**: si `readyState === CLOSED` o tras N fallos seguidos, `close()` y enseñar «desconectado ·
  reintentar»; el core emite `chat.deleted` y cierra el stream al borrar.

### L-15 · P2 · Dos tarjetas de aprobación distintas; la del plan recorta el prompt

- `ui/assistant.tsx ApprovalCard` (panel del workspace) muestra `prompt.slice(0, 400)` —la otra promete
  «el texto entero y sin recortar»—, `PERMISSION[... as 'auto'|'yolo']` y cabecera fija «Necesita tu
  permiso»: si un plan pide escalar, la tarjeta no dice que es la nube.
- **Cómo**: un solo `ui/approval-card.tsx` para las dos pantallas, con las tres cabeceras, el prompt
  entero, `effectsDeclared` y el servidor.

### L-16 · P2 · `readOnly` en el core no impide que el servidor ejecute lo sin etiquetar

- `effectsOf` deja pasar como lectura una herramienta **sin etiqueta** en un servidor `readOnly`
  («no hay daño posible»); pero `readOnly` es un flag del core, y si el operador del MCP enciende
  `MCP_ENABLE_WRITES=1` el efecto se ejecuta sin tarjeta. ADR-010 §4 llama a esto «protección latente»
  sólo para servidores con escrituras.
- **Cómo**: en servidores `readOnly`, herramienta sin etiqueta = no se ofrece (o se rechaza con
  `UNKNOWN_EFFECT`), salvo `JARVIS_MCP_TRUST_UNTAGGED=<server>`; Salud enseña `untagged: n`.

### L-17 · P3 · Prompt local desactualizado, asimetría Anthropic, tipos de rutas

- `LOCAL_SYSTEM_PROMPT` sigue diciendo «Vives en el servidor de casa» (el primer escalón es gpt-5-nano).
  `AnthropicModel` no tiene juez de esfuerzo ni el «nudge» cuando el modelo vuelve sin nada: cierra con
  «el modelo no propuso ningún paso». `chat/routes.ts` tipa `autonomy?: 'manual' | 'auto'` en vez de
  `AutonomyMode`. `KEEPALIVE_MS` del chat vive aparte del de runs aunque el proxy depende de ambos.
- **Cómo**: frase neutra; portar `nudged` a Anthropic; una sola constante de latido en `platform/`.

### L-18 · P2 · No hay cobertura e2e del asistente

- `tests/e2e` no menciona `chat`, `assistant` ni `artifact`. Los cinco flujos críticos no incluyen la
  pantalla que más ha cambiado en dos días.
- **Cómo**: flujo «pregunta → traza plegada → respuesta → botón de sesión → tarjeta → autorizar → run»
  con el `ScriptedModel` de `dev:local`, escritorio y móvil, más `a11y.spec` sobre `/assistant`.

---

## C. Lógica de UX/UI

| Id | Qué | Cómo | Quién | Estado |
|---|---|---|---|---|
| U-01 | No se puede parar un turno: un «Hola» de tres minutos se aguanta entero | F-01 | web | [x] |
| U-02 | Borrar conversación sin confirmar (`remove.mutate` directo; el resto de la consola usa `ConfirmDialog`) | `ConfirmDialog` con el título del hilo y «no se puede deshacer» | web | [x] |
| U-03 | El scroll fuerza abajo con cada mensaje aunque se esté leyendo arriba | sólo si `isNearBottom`; si no, chip «↓ N nuevos» | web | [x] |
| U-04 | El estado `failed` es invisible: `StatusLine` sólo distingue `thinking`; no hay «reintentar» | tono `danger` + botón «Volver a intentar» (F-02) | web | [x] |
| U-05 | Un mensaje enviado en `waiting_approval` se guarda y parece ignorado | composer avisa «contesta primero a la tarjeta» o el core encola (R-08a) | web | [x] |
| U-06 | La tarjeta va al final del hilo, lejos del mensaje que la pidió; en móvil se pierde al abrir la hoja | anclarla `sticky` bajo la cabecera mientras `status === 'waiting_approval'`; `announce()` al aparecer | web | [x] |
| U-07 | `SpendBadge` llama «consultas» a `remainingTurns`, que son vueltas al modelo, no preguntas | «~N vueltas» y coste por respuesta (F-05) | web | [x] |
| U-08 | `TerminalRef` con `workspaceId` nulo abre la terminal en el home sin avisar | «sin directorio conocido» y acción «abrir workspace primero» | web | [x] |
| U-09 | Carril sin búsqueda, sin paginación (30), sin renombrar ni archivar; título = 60 primeros caracteres | F-10, F-16; usar `titles` (existe para workspaces) para el título | web | [x] |
| U-10 | `connected` del stream nunca se enseña | punto en `StatusLine` cuando `!connected` durante > 5 s | web | [x] |
| U-11 | «Sabe consultar» pinta cada servidor en verde siempre | R-07 | web | [x] |
| U-12 | `autonomy-menu` no recibe foco al abrir ni cierra con Escape; `ApprovalCard` sin anuncio | `useEffect` foco + `onKeyDown Escape`; `announce()` | web | [x] |
| U-13 | La tarjeta de capacidad no dice si el efecto es **declarado** o **inferido**, ni el servidor | pastilla «efecto declarado / inferido» + `server` (viene en `McpCapability`) | web | [x] |
| U-14 | Con `capabilityMode: 'router'` la única pista es «las busca» en la cabecera | tooltip que explique «el catálogo no cabe: cada consulta cuesta una vuelta más» | web | [x] |

---

## D. Features útiles (asistente e integración)

| Id | Feature | Cómo hacerlo sin fallo | Quién | Estado |
|---|---|---|---|---|
| F-01 | **Parar el turno** | `AbortController` por conversación guardado junto a `#turns`; `POST /api/chat/:id/stop`; los modelos aceptan `signal` en `#ask`; evento «parado por ti», `status idle`, job `finish`. Botón en el composer mientras `thinking`. | core | [ ] |
| F-02 | **Reintentar / regenerar / editar el último mensaje** | `POST /api/chat/:id/retry` rehace el turno con la historia recortada hasta el último `user`; editar = borrar desde ese `seq` (nuevo `event` «editado») y reenviar. | core | [ ] |
| F-03 | **Bandeja global de aprobaciones** | `GET /api/approvals?status=pending` que junte planes y conversaciones (`plans.pendingApprovals()` ya existe); contador en la navegación; tarjeta con enlace de vuelta al hilo. | core | [ ] |
| F-04 | **Avisos** | `waiting_approval` y `idle` tras pensar → `announce()`, título de pestaña «(1) Jarvis» y `Notification` si hay permiso. | core | [ ] |
| F-05 | **Gasto por conversación y por respuesta** | con L-08: `SELECT … WHERE conversation_id`; pastilla «0,4 ¢» por burbuja; `JARVIS_CHAT_MAX_USD` que rechaza escalar cuando se supera. | core | [ ] |
| F-06 | **Streaming de la respuesta final** | sólo para `finish`: `stream:true` en la última vuelta (cuando `decisionsOnly`), evento `chat.partial` no persistido; la fila se escribe al terminar. | core | [ ] |
| F-07 | **Adjuntos en el chat** | `Composer` ya admite `onFiles`; con workspace, subir a `attachments` y que `list_evidence` lo vea; sin workspace, guardar como artifact `code/markdown` de la persona y pasarlo como `CONTENT_IS_DATA`. | core | [ ] |
| F-08 | **Exportar y auditar** | `GET /api/chat/:id/export.md` (con trazas) y enlace desde cada `ToolTrace` a la fila de auditoría (`GET /api/audit?requestId=chat:<id>`). | core | [ ] |
| F-09 | **Atar/desatar workspace a una conversación existente** | `POST /api/chat/:id/workspace`; cuando el asistente abre un workspace en un hilo sin workspace, ofrecer «¿trabajo sobre éste?» (chip) que lo ata. | core | [ ] |
| F-10 | **Siguiente paso pulsable y prefill** | chips bajo la respuesta a partir de `refs` («Léeme el transcript», «Lánzale un trabajo», «Ábreme la terminal»); `/assistant?q=` para preguntas desde otras pantallas; comandos rápidos `/salud`, `/trabajos`. | web | [x] |
| F-11 | **Esfuerzo elegible por conversación** | columna `effort` (`auto|low|medium|high`); override del juez; ver el coste del juez (R-13). | core | [ ] |
| F-12 | **Lista «siempre con tarjeta» para `unrestricted`** | lo que ADR-010 §3-bis deja abierto: `JARVIS_MCP_ALWAYS_CARD=stop_service:jarvis,restart_service:jarvis,stop_service` con match por argumento; se comprueba en `#applyDecision` antes de la vía sin tarjeta. | core | [ ] |
| F-13 | **«Pregúntale» desde Explorador y Portada** | hoy sólo Salud, Trabajos y Workspace usan `AskAssistantButton`; en el explorador con `workspaceId` de la sesión. | web | [x] |
| F-14 | **Descripción larga en directo y búsqueda bilingüe** | R-05; `search_capabilities` con sinónimos (memoria→memory, disco→disk, red→network) para el router. | core | [ ] |
| F-15 | **Reanudar de verdad un turno tras reinicio** | persistir el memo (`alreadyAsked`, `observations`) en un `payload` del job por cada consulta; `reconcile()` puede entonces rehacer turnos que ya escribieron sin duplicar. | core | [ ] |
| F-16 | **Compactar hilos largos** | cuando el hilo supera N mensajes, un `event` de resumen escrito por el modelo (como `history` en planes) y `#contextFor` lo usa en vez de los 12 últimos. | core | [ ] |
| F-17 | **Compartir/descargar artifacts** | `csv` para `table`, `json` para `chart/json`, URL estable con permisos (L-03). | web | [x] |
| F-18 | **Renombrar, fijar y archivar conversaciones** | `PATCH /api/chat/:id {title, pinned, archived}`; el carril filtra archivadas. | web | [x] |

---

## D-bis · Cierre de las filas `web`

Las veintiuna que se arreglaron van en **`868af77`** («La pantalla del asistente deja de mentir, de
romperse y de perder lo escrito») salvo `F-13` y `F-17`, que van detrás. Lo que sigue es lo que no se
explica solo con el commit.

**R-16** — se cierra **la mitad web**: dos anillos de error, uno por burbuja y por artifact —cae sólo
esa pieza y el cuerpo sale en crudo, que sigue siendo la respuesta— y otro por pantalla, para que un
fallo imprevisto no deje la ventana en blanco sin navegación. **La otra mitad no es de web**:
`validateTable` en `chat/artifacts.ts` tiene que rechazar un `label` que no sea texto, y eso es
`core`. Un anillo evita el desastre; validar evita el fallo.

**L-14** — se cierra con un matiz sobre lo propuesto: el stream se rinde a los seis fallos seguidos o
con `readyState === CLOSED`, y la pantalla lo dice. Lo que **no** se ha hecho es que el core emita
`chat.deleted` al borrar, que es la mitad limpia; sin ella se llega igual, pero por agotamiento en vez
de por aviso. Queda para `core` si se quiere afinar.

**U-01 · descartada, no hecha.** Parar un turno es `F-01` y vive en el core: hace falta un
`AbortController` por conversación y una ruta que lo dispare. Un botón en la pantalla sin eso detrás
no para nada: deja de enseñar el estado y el turno sigue gastando. **Prometer un botón de parada que
no para es peor que no tenerlo**, así que se cierra aquí y el trabajo real está en `F-01`.

**U-05 · descartada, no hecha.** Avisar en el compositor de que hay una tarjeta sin firmar es un
parche sobre `R-08a`: el problema no es que no se avise, es que el mensaje **se guarda y no se
contesta**. Con la tarjeta anclada arriba (U-06) el aviso ya está donde importa; encolar el mensaje
es de `core` y ahí es donde se arregla de verdad.

**U-09 · descartada, no hecha.** Buscar, paginar, renombrar y archivar en el carril es `F-10`, `F-16`
y `F-18`, y las tres necesitan rutas que no existen (`PATCH /api/chat/:id`, paginación en el listado).
Lo único que sí era de web —que el título fuera algo mejor que los sesenta primeros caracteres— **ya
lo resuelve el titulador del core**, que resume en vez de copiar. Lo demás no se puede hacer desde
aquí.

**U-11 · descartada, no hecha.** «Sabe consultar» pinta cada servidor MCP en verde porque el catálogo
no trae otro estado: es `R-07`, que es donde Salud deja de decir `ok` con el MCP caído. En cuanto el
core distinga, la pastilla lo hereda sin tocar nada. Pintarlo distinto desde la web hoy sería
inventarse un estado que no tenemos.

**F-10 · descartada, no hecha.** Los chips de acción rápida bajo la respuesta **los descartó Braian
explícitamente** —«sin chips por ahora»— y esa decisión sigue en pie. Y `/assistant?q=` no añade nada
sobre lo que ya hay: `useAskAssistant` siembra la pregunta desde cualquier pantalla sin pasar por la
URL, que es como está hecho en Salud, Trabajos, Workspace y ahora Explorador y Portada.

**F-17 · hecha a medias, y a propósito.** La descarga se arma **en el navegador** con lo que ya está
en pantalla: una tabla sale en CSV con las comillas dobladas —una celda con una coma no puede partir
la fila— y el resto en su formato. No hace falta ruta, ni permisos, ni esperar a nada. Lo que **no**
se hace es la URL estable para compartir: eso necesita saber de quién es cada conversación, y eso es
`L-03`. El `html` no se descarga: un documento que ejecuta no se guarda en el disco de nadie.

**F-18 · descartada, no hecha.** Renombrar, fijar y archivar necesita `PATCH /api/chat/:id`, que es
`core`. Sin la ruta, lo único que podría hacer la web es un renombrado que no persiste, que es peor
que no ofrecerlo.

---

## E. Riesgos conocidos que no son fallos (para tenerlos delante)

- **`unrestricted` + `stop_service jarvis`**: ADR-010 §3-bis lo deja sin resolver a propósito; F-12
  es la salida. Mientras tanto, `JARVIS_ALLOW_UNRESTRICTED` debe seguir apagado.
- **El MCP de Zeus no autentica en la LAN** (`docs/security.md`): las escrituras remotas dependen de
  `MCP_ENABLE_WRITES=0` en el otro proceso; L-16 lo hace explícito.
- **Tope de 128 funciones**: `capabilityRoom` avisa a partir de 3; con R-05 el catálogo crece en
  tokens, no en funciones, así que el aviso sigue valiendo.
- **`yolo` nunca por conversación**: `#createRun` lo corta; `request_approval` con `permission_profile: yolo`
  sí llega a tarjeta, y `runs.planTarget` lo rechaza si `JARVIS_ALLOW_YOLO` está apagado. Correcto,
  pero la tarjeta se enseña antes de saber que va a fallar: comprobar `allowYolo` al crear la aprobación.

---

## F. Pruebas que faltan (mapa)

| Fichero | Añadir |
|---|---|
| `tests/integration/chat.test.ts` | R-01, R-02, R-08, R-09, R-11, L-02, L-03, L-04, L-08 |
| `tests/integration/chat-durable.test.ts` | R-08 (job del segundo mensaje), F-15 |
| `tests/integration/artifacts.test.ts` | R-04 (CSP completa, 403 sin `sec-fetch-dest`) |
| `tests/integration/assistant.test.ts` | R-14, R-15 |
| `apps/core/test/mcp.test.ts` | R-05, R-06, R-07, L-05, L-06, L-16 |
| `apps/core/test/assistant-tools.test.ts` | R-12, R-13, L-01, L-09, L-10 |
| `apps/core/test/artifacts.test.ts` | R-16, R-17 |
| `apps/core/test/deploy-env.test.ts` | L-01 (config saneada) |
| `apps/web/test` (nuevo proyecto jsdom) | R-16 (ErrorBoundary), L-11, L-13 |
| `tests/e2e/assistant.spec.ts` (nuevo) | L-18, R-04 (canario), U-02, U-03 |

---

## G. Orden sugerido

1. **Cerrar puertas** (medio día): R-02, R-03, R-04, L-01, L-02. Son cinco cambios pequeños y cada uno
   con su prueba; ninguno cambia contratos.
2. **Desbloquear a la persona** (un día): R-01 + L-12, R-08 (opción b si hay prisa, a después), R-09,
   R-10, R-11, L-11.
3. **Que el MCP diga la verdad** (medio día): R-05, R-06, R-07, L-05, L-06.
4. **Planes** (medio día): R-14, R-15.
5. **Concurrencia y gasto** (medio día): R-12, R-13, L-08.
6. **Pantalla** (un día): L-07, L-15, R-16, R-17, U-02/03/04/06, L-13, L-14.
7. **Multiusuario y e2e** (un día): L-03, L-18.
8. Features por valor/coste: F-01, F-03, F-05, F-10, F-09, F-12, F-02, resto.

---

## H. Cómo se reprodujo (para repetirlo sin adivinar)

- **Sondeos de core**: `node --input-type=module` con `vite.createServer({ middlewareMode:true,
  optimizeDeps:{noDiscovery:true}, resolve:{alias:{'@jarvis/contracts':…, '@jarvis/agent-adapters':…}} })`
  y `server.ssrLoadModule('/apps/core/src/…')`. Base con `openDatabase({path:':memory:'})` +
  `migrate(db)`; reloj `{nowMs, nowIso}` controlado; `ScriptedBrain`/`HybridModel` con cerebros
  guionizados que cuentan llamadas; `McpService` con `fetchImpl` falso (dos servidores, TTL de 10 ms).
- **HTML**: servidor `node:http` sirviendo un padre con la CSP de `securityHeaders()` y el artifact
  con la CSP de `/raw`; Playwright `chromium` con `context.route('**/*')` que aborta todo lo que
  apunte a `audit-canary.invalid` y anota la URL. Dos casos: `<iframe src=http://…>` embebido y
  `location.href=http://…` en pestaña. Ningún byte salió: las peticiones se abortaron antes de resolver.
- **Concurrencia del modelo**: `OpenAiCompatibleModel` con `fetchImpl` que distingue el juez (sin
  `tools`) del turno, y un `toolbox.invoke` que bloquea hasta que el segundo `decide` haya pedido su
  primera vuelta.
- **Planes**: `PlanService` con `runs.create` contador y un `model.decide` que devuelve una promesa
  resuelta a mano **después** de `cancel()`; checkpoint a medias sembrado con un `INSERT` en
  `plan_steps` (`kind='run', status='running', run_id NULL`).
