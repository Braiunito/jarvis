# Auditoría diferencial de Jarvis — Codex

Fecha: 2026-09-02  
Material revisado: `src(8).txt`, `backlog.md`, `CHANGELOG.md` y `auditoria-jarvis.md`.

## Objetivo y método

Esta es una segunda auditoría estática y **diferencial**: he contrastado cada punto con
`auditoria-jarvis.md` y he excluido sus hallazgos A1–A9, M1–M33 y su bloque de observaciones
menores. No vuelvo a contabilizar un problema conocido con otro nombre.

Los hallazgos siguientes salen del código fuente, no de `dist/`. No se ha desplegado la pila ni se
ha probado contra los hosts reales; por eso distingo los casos confirmados por flujo de código de
los que dependen de la configuración del despliegue. Las líneas son las del volcado entregado y
pueden moverse al aplicar cambios.

## Resumen ejecutivo

He encontrado **20 problemas adicionales**:

| Prioridad | Cantidad | Significado |
|---|---:|---|
| P0 | 2 | Puede tumbar el core o rompe el aislamiento de seguridad |
| P1 | 10 | Puede impedir una función principal, duplicar trabajo o incumplir una garantía explícita |
| P2 | 8 | Riesgo relevante de robustez, degradación, operación o UX |

Los cinco que corregiría antes son:

1. La protección de consumidor SSE lento entra en recursión y puede desbordar la pila del core.
2. Si hay más de una cuenta humana, todas tienen control administrativo sobre los datos y procesos
   de las demás.
3. La UI no sabe completar una política `password+passkey`, ni ninguna que incluya TOTP.
4. Se pueden ejecutar dos agentes simultáneamente sobre la misma conversación remota.
5. La idempotencia de `createRun` tiene una carrera y puede crear dos runs con la misma clave.

---

## P0 — Críticos

### N01 · El corte por consumidor SSE lento provoca recursión infinita

**Evidencia:** `apps/core/src/runs/sse.ts:38-47`.

`write()` escribe el chunk y, si `writableLength` supera 8 MiB, vuelve a llamar a `write()` para
emitir `jarvis.dropped`. El buffer sigue por encima del umbral —y cada llamada añade otro chunk—,
por lo que nunca alcanza `close()`: recurre hasta lanzar `RangeError: Maximum call stack size
exceeded`. Al ocurrir dentro de un callback de socket/event bus puede terminar el proceso core, no
sólo la conexión lenta que se quería proteger.

**Corrección:** marcar `closed = true` antes de cualquier notificación y escribir el aviso una sola
vez directamente con `reply.raw.write`, o cerrar sin intentar encolar más datos. Capturar también
los errores síncronos de `write/end`.

**Prueba de regresión:** respuesta falsa con `writableLength > MAX_PENDING_BYTES`; un evento debe
causar como máximo una notificación, un `end`, una desuscripción y ninguna excepción.

### N02 · No hay autorización por propietario ni roles: toda cuenta autenticada es administradora

**Condición:** P0 si el despliegue admite dos o más cuentas humanas. Si Jarvis es estrictamente
monooperador, debe declararse como límite de seguridad del producto.

**Evidencia:**

- `apps/core/src/app.ts:48-75` sólo autentica una identidad firmada.
- `apps/core/src/runs/routes.ts:28-75` permite listar, leer, cancelar, reconocer y reintentar
  cualquier run sin comparar `createdBy`.
- `apps/core/src/workspaces/routes.ts:63-130` permite leer, renombrar y escribir borradores de
  cualquier workspace; el borrador sí se separa por usuario, el workspace no.
- `apps/core/src/plans/routes.ts:21-68` expone planes/aprobaciones globales y permite resolverlos.
- `apps/core/src/terminal/routes.ts:7-41` permite listar, capturar o destruir terminales globales.

Los campos `created_by` se almacenan, pero casi nunca se usan como control de acceso. Así, la cuenta
B puede leer prompts/resultados de A, cancelar sus trabajos, aprobar una acción de su Assistant o
destruir una terminal en sus hosts.

**Corrección:** decidir y documentar uno de estos modelos: (a) sólo existen cuentas administradoras
de confianza; o (b) ownership/roles reales. En (b), centralizar `requireWorkspaceAccess`,
`requireRunAccess`, `requirePlanAccess` y permisos de terminal; no repartir comprobaciones ad hoc
por cada ruta. Las aprobaciones deben poder resolverlas sólo su creador o un rol explícito.

**Prueba de regresión:** matriz E2E con usuarios A/B/admin para GET y mutaciones de workspace, run,
plan, aprobación, adjunto y terminal. B debe recibir 404/403 sin filtrar siquiera la existencia.

---

## P1 — Altos

### N03 · La pantalla de login no implementa la cadena de autenticación que anuncia el servidor

**Evidencia:**

- `apps/gateway/src/routes/auth.ts:98-115` devuelve
  `{authenticated:false,next,pending}` cuando falta otro factor.
- `apps/gateway/src/routes/auth.ts:301-340` implementa `/auth/totp/verify`.
- `apps/web/src/screens/login.tsx:37-87` ignora por completo la respuesta de `password/verify` y
  `passkey/verify`, llama siempre a `onAuthenticated()` y nunca reenvía `pending`.
- `apps/web/src/screens/login.tsx:110-144` no tiene formulario TOTP ni recuperación.

Con `JARVIS_AUTH_POLICY=password+passkey`, el primer paso no emite cookie, la SPA se cree autenticada
y `/auth/me` vuelve a rechazarla. `passkey+password` pierde igualmente el token pendiente. Cualquier
política con `totp` es imposible desde la web.

**Corrección:** implementar una máquina de estados impulsada por `next` y `pending`; mostrar un solo
paso activo, conservar el token sólo en memoria y enviarlo al siguiente endpoint. Añadir TOTP y
código de recuperación. `onAuthenticated()` sólo debe ejecutarse con `authenticated === true`.

**Prueba de regresión:** E2E para `passkey`, `password`, `password+passkey`, `passkey+password` y una
cadena con TOTP; incluir recarga/cancelación a mitad del flujo y token pendiente de otra cuenta.

### N04 · Dos runs pueden escribir simultáneamente sobre la misma sesión de agente

**Evidencia:** `apps/core/src/runs/service.ts:197-302` y
`apps/core/src/runs/repository.ts:187-197`.

La única admisión es el contador global de activos. No hay comprobación, bloqueo ni cola por
`workspaceId`/`SessionRef`. Dos envíos manuales, dos planes o un plan y una persona pueden ejecutar a
la vez `--resume` sobre la misma conversación. El resultado puede ser historial remoto corrupto,
contexto divergente, modificaciones de ficheros en conflicto y una respuesta que no corresponde al
orden visible en Jarvis.

Esto es distinto de la carrera del límite global ya descrita en M9: aunque ese contador fuese
atómico, seguiría faltando la exclusión por conversación.

**Corrección:** definir la semántica. Lo más seguro es una cola FIFO por workspace/sesión y permitir
concurrencia sólo entre sesiones distintas. Defenderla también en SQLite (lease o restricción sobre
la entidad que posea el turno), no únicamente en memoria.

**Prueba de regresión:** dos `POST /api/runs` concurrentes al mismo workspace: uno arranca y el otro
queda en cola; contra workspaces distintos ambos pueden arrancar hasta el límite global.

### N05 · La idempotencia de crear runs no es atómica y puede duplicar efectos

**Evidencia:**

- `apps/core/src/runs/service.ts:211-227` consulta la clave antes de varios `await`.
- El run se inserta en `apps/core/src/runs/service.ts:295-302`.
- La clave no se guarda hasta `apps/core/src/runs/service.ts:328-331`, después de insertar eventos y
  auditoría.
- `apps/core/src/runs/repository.ts:282-287` resuelve el conflicto actualizando sólo
  `response_json`, pero conserva el `request_hash` y `resource_id` de la primera fila.

Dos peticiones simultáneas con la misma clave pueden ver “no existe”, crear runs distintos y luego
chocar al guardar la clave. Peor: el segundo `ON CONFLICT` deja `resource_id` apuntando al primer run
pero sustituye la respuesta por el target del segundo. Un crash entre insertar el run y guardar la
clave también duplica al reintentar.

**Corrección:** reservar la clave y crear el recurso en una única transacción. La inserción de la
clave debe ganar una sola vez; el perdedor lee y devuelve el recurso ganador. Nunca actualizar una
fila idempotente ya resuelta con datos de otra ejecución.

**Prueba de regresión:** `Promise.all` con 20 peticiones idénticas debe producir un solo run; inyectar
un crash en cada frontera transaccional y comprobar que el retry devuelve ese mismo run.

### N06 · El cliente puede forzar si se crea o se reanuda una sesión

**Evidencia:**

- `packages/contracts/src/runs.ts:167-178` publica `startsSession` en `CreateRunRequest`.
- `apps/core/src/runs/routes.ts:12-24` pasa el body completo.
- `apps/core/src/runs/service.ts:239-247` afirma que lo decide el core, pero usa
  `request.startsSession ?? workspace.sessionLaunched === false`.

Un cliente puede mandar `false` en un workspace sin estrenar y obligar a reanudar una sesión que aún
no existe, o `true` en una conversación existente y arrancar otra desde cero. Esto rompe el
invariante que el propio comentario declara y hace que la corrección dependa de que todas las UIs
sean benignas y estén actualizadas.

**Corrección:** quitar el campo del contrato HTTP y derivarlo sólo del estado persistido. Si un caso
interno necesita override, usar un tipo/entrada no expuesta por REST y auditarla.

**Prueba de regresión:** cuerpos con `startsSession:true/false` deben rechazarse por esquema o ser
ignorados; el primer run y los posteriores deben conservar su semántica aunque el cliente mienta.

### N07 · Los adjuntos prometidos como “sólo lectura” son escribibles por el agente

**Evidencia:** `apps/core/src/attachments/service.ts:1-10`, `169-180` y `249-261`.

El fichero termina con modo `0600`. El agente corre con el mismo usuario remoto que creó el fichero,
por lo que puede editarlo o borrarlo. El texto “Treat them as read-only” es una instrucción al modelo,
no una barrera. Incluso `0400` sólo evitaría un accidente: el propietario podría cambiar de nuevo el
modo si dispone de shell.

**Corrección:** si “read-only” es una garantía de seguridad, ejecutar el agente con otro UID y
entregar los ficheros mediante un bind mount realmente `ro`/directorio no poseído por ese UID. Si no
se puede aislar, rebajar explícitamente la promesa a “se pide al agente que no los modifique” y
verificar hash al terminar para avisar de alteraciones.

**Prueba de regresión:** desde el proceso real del agente, intentar escribir, renombrar, borrar y
cambiar permisos; todas las operaciones deben fallar para poder llamarlo sólo lectura.

### N08 · La limpieza de adjuntos no sobrevive a crashes y deja además subidas fallidas huérfanas

**Evidencia:**

- `apps/core/src/runs/service.ts:377-390` confirma el estado terminal y lanza
  `releaseForRun()` sin esperarlo ni persistir primero `release_pending`.
- `apps/core/src/attachments/service.ts:270-307` sólo barre `staged` vencidos y
  `release_pending`; nunca recupera un `claimed` cuyo run ya terminó.
- `apps/core/src/attachments/service.ts:169-209` puede completar el `mv` remoto antes de detectar que
  el cuerpo recibido no coincide con `Content-Length`.
- El `catch` de `stage`, líneas 154-164, marca `failed`, pero `sweep()` tampoco limpia `failed` ni
  sus `.part`/ficheros finales.

Si el core cae justo después de confirmar el run terminal, el adjunto queda `claimed` para siempre.
Una subida corta puede dejar el fichero final y una fila `failed`, también para siempre.

**Corrección:** cambiar los adjuntos a `release_pending` dentro de la misma transacción que termina
el run; el barrido debe reconciliar `claimed` contra runs terminales y limpiar `failed` antiguos,
incluidos `.part`. La operación remota debe ser idempotente.

**Prueba de regresión:** matar el core en cada punto entre transición, marcado y `rm`; al reiniciar,
un barrido converge siempre a “sin fichero remoto + fila released/expired”. Probar cuerpo menor y
mayor que `Content-Length`.

### N09 · El Assistant puede cancelar trabajo humano sin aprobación

**Evidencia:** `apps/core/src/assistant/toolbox.ts:163-172` declara `cancel_run` como observación
(`decides:false`) y `apps/core/src/assistant/toolbox.ts:466-479` ejecuta la cancelación inmediatamente.

El modelo puede cancelar cualquier run activo del workspace, incluidos los creados manualmente y
los de otra persona, sin una tarjeta de aprobación. Además, el transcript y la salida de agentes son
contexto no confiable: una instrucción inyectada puede inducir al coordinador a parar trabajo caro o
irrepetible. La acción queda auditada, pero la auditoría no evita el efecto.

**Corrección:** convertir la cancelación en decisión aprobable, o limitarla estrictamente a runs
creados por ese mismo plan y permitirla sólo bajo una política explícita de autocancelación. Un run
manual nunca debería ser cancelable por texto proveniente del modelo sin intervención humana.

**Prueba de regresión:** un modelo guionizado que invoque `cancel_run` sobre un run manual debe
producir aprobación/denegación, no cambiar su estado.

### N10 · Emisión ilimitada de challenges WebAuthn permite agotar memoria sin autenticarse

**Evidencia:** `apps/gateway/src/routes/auth.ts:34-61`, `118-135` y `219-243`.

Cada llamada anónima válida a `/auth/passkey/options` añade una entrada al `Map` durante cinco
minutos. `throttle()` sólo consulta el contador; la ruta de options no llama a `penalize()`, así que
emitir challenges con éxito nunca consume intentos. No existe límite global ni por IP/usuario.
Un atacante puede crear entradas más rápido de lo que el barrido por minuto las elimina.

**Corrección:** limitar la **emisión**, no sólo los fallos de verificación; conservar como máximo uno
o unos pocos challenges vivos por IP/flujo y aplicar un límite global con rechazo temprano. El mismo
principio debe aplicarse a enrolamiento.

**Prueba de regresión:** tras N solicitudes de options desde una identidad de red, N+1 devuelve 429
y el número de challenges vivos permanece acotado.

### N11 · Una lista de revocación corrupta o no persistida reactiva sesiones cerradas

**Evidencia:** `apps/gateway/src/lib/session.ts:65-92`.

Si `revoked-sessions.json` no se puede parsear, `loadRevoked()` captura el error y sustituye todo por
un mapa vacío. Si `persistRevoked()` falla, logout devuelve éxito igualmente; el token queda revocado
sólo en memoria hasta reiniciar. En ambos casos, un token capturado que el usuario creía cerrado
vuelve a ser válido hasta su `exp`.

**Corrección:** fallar cerrado para sesiones existentes cuando el almacén de revocación sea
ilegible, conservar una copia anterior verificada y hacer escritura atómica duradera. Logout debe
informar un fallo si no puede garantizar la revocación del servidor.

**Prueba de regresión:** revocar un token, corromper el fichero y reiniciar; el token no debe volver a
autenticar. Simular `ENOSPC/EACCES` durante logout y comprobar respuesta y estado.

### N12 · `JARVIS_CORE_TIMEOUT_MS` está definido pero el proxy no lo usa

**Evidencia:** `apps/gateway/src/config.ts:120-123` frente a
`apps/gateway/src/proxy.ts:43-98` y `106-171`.

El timeout aparece en configuración, pero no se aplica ni al request HTTP ni al handshake del
WebSocket. Un core que acepta conexión y deja de responder puede mantener API, uploads y upgrades
abiertos indefinidamente, consumir sockets y dejar la UI en “cargando”.

**Corrección:** aplicar timeout de conexión/cabeceras y responder 504 con el contrato de error. SSE
y un WebSocket ya establecidos no deben recibir el timeout normal de 30 s; necesitan timeout de
handshake y política de inactividad/heartbeat específica.

**Prueba de regresión:** upstream que acepta y nunca responde: API y upgrade fallan dentro del plazo;
un SSE activo que manda keepalives sigue vivo más allá de ese plazo.

---

## P2 — Medios

### N13 · El upgrade WebSocket no valida `Origin`

**Evidencia:** `apps/gateway/src/app.ts:110-145`. El gateway valida cookie y usuario, pero no compara
`req.headers.origin` con `config.origins` antes de reenviar la terminal.

`SameSite=Strict` ayuda contra sitios cruzados, pero no sustituye la validación de origen del
WebSocket: cookies no aíslan puertos y otro servicio controlado en el mismo site/host puede abrir un
socket con las credenciales de la víctima. El resultado es CSWSH contra una terminal interactiva.

**Corrección:** exigir un `Origin` exacto de la allowlist (con tratamiento explícito sólo para
clientes no navegador, si se admiten). Rechazar antes de contactar al core.

**Prueba de regresión:** origen permitido obtiene 101; origen distinto, ausente bajo política web o
con puerto no permitido obtiene 403 y no se crea SSH.

### N14 · La terminal no tiene control de flujo y cada resize puede crear otro proceso SSH

**Evidencia:**

- `apps/core/src/terminal/websocket.ts:195-208` ignora el booleano de `socket.write()`.
- `apps/core/src/terminal/gateway-upgrade.ts:91-92` sigue leyendo stdout/stderr aunque el navegador
  no pueda consumir; la línea 126 ignora backpressure de stdin.
- `apps/core/src/terminal/gateway-upgrade.ts:105-116` lanza un `resizePty` por mensaje.
- `apps/core/src/terminal/pty.ts:77-111` crea un proceso SSH por resize/find sin timeout.

Un móvil lento puede hacer crecer buffers de Node. Un cliente autenticado puede mandar cientos de
resizes y acumular procesos SSH, especialmente si el host no responde.

**Corrección:** pausar stdout al recibir `false` y reanudar en `drain`, limitar bytes pendientes y
cerrar al excederlos; hacer lo mismo hacia stdin. Debounce/coalescing de resize, un único proceso en
vuelo y timeout/kill explícito.

**Prueba de regresión:** socket artificialmente bloqueado mantiene memoria bajo un límite; 1.000
resizes rápidos producen sólo el último ajuste y como máximo un SSH simultáneo.

### N15 · La caché de último resultado bueno del índice crece sin límite

**Evidencia:** `apps/core/src/sessions/index-client.ts:99-170`.

`#lastGood` es un `Map` permanente cuya clave es `JSON.stringify(query)`. Cada texto de búsqueda,
combinación de filtros o límite distinto añade otra entrada con hasta cientos de sesiones; no hay
TTL, LRU ni máximo. La búsqueda es autenticada, pero el uso normal prolongado —o una cuenta
maliciosa— hace crecer la memoria del core sin recuperación.

**Corrección:** LRU con límite de entradas/bytes y TTL; valorar cachear sólo consultas canónicas y no
búsquedas arbitrarias. La fecha `at`, hoy no usada, debería gobernar la expiración.

**Prueba de regresión:** miles de queries únicas no superan el máximo configurado y una entrada
expirada no se devuelve como fallback.

### N16 · Un fallo de refresco de cuota se ve “stale” sólo en esa petición, pero no en métricas

**Evidencia:**

- `apps/core/src/usage/service.ts:93-109` reconstruye cualquier fila con `stale:false`, incluso si
  `refresh_error` no es nulo.
- `apps/core/src/usage/service.ts:159-166` devuelve el cache como stale al fallar, pero no persiste el
  error.
- `apps/core/src/metrics/service.ts:159-192` decide `stale` exclusivamente desde
  `refresh_error` persistido.

La pantalla del workspace que provocó el refresh puede avisar, mientras el panel global sigue
mostrando la misma cuota como fresca. Una petición posterior dentro del TTL vuelve a leerla con
`stale:false`.

**Corrección:** persistir `refresh_error` conservando datos y `fetched_at` del último éxito; al leer,
derivar `stale` del error y/o edad. Un éxito posterior limpia el error.

**Prueba de regresión:** éxito → fallo → lecturas desde workspace y métricas: ambas muestran el mismo
snapshot viejo y stale; un nuevo éxito lo vuelve fresh.

### N17 · Los números de entorno no se validan y `NaN` puede crear bucles calientes

**Evidencia:** `apps/core/src/config.ts:10-135` y `apps/gateway/src/config.ts:61-123` convierten casi
todos los valores con `Number()` sin comprobar finitud, signo ni relaciones.

Ejemplos: `JARVIS_POLL_INTERVAL_MS=abc` produce `NaN`, que en timers equivale de hecho a 0 y puede
crear sondeo SSH continuo; `JARVIS_RUN_TIMEOUT_MS=abc` llega a una fecha inválida; valores negativos
rompen TTL, retención, límites o timeouts. Tampoco se verifica que drop sea posterior a compactación
o que cuota de adjuntos sea coherente con el tamaño individual.

**Corrección:** esquema central de configuración al arrancar, con `finite`, enteros, mínimos/máximos,
enums y relaciones entre campos. Fallar inmediatamente con el nombre y valor inválido, antes de
abrir el puerto.

**Prueba de regresión:** tabla de env inválidos (`abc`, `Infinity`, 0, negativos, relaciones
imposibles) que debe impedir startup; probar también los límites válidos.

### N18 · La importación puede quedar a medias y rechaza texto legítimo como si fuera un secreto

**Evidencia:** `apps/core/src/import/routes.ts:6-20` hace sólo un cast TypeScript;
`apps/core/src/import/service.ts:46-54` busca claves prohibidas sobre el JSON serializado y
`apps/core/src/import/service.ts:69-142` procesa cada conversación sin transacción.

Hay dos fallos:

1. Un mensaje que contenga literalmente, por ejemplo, `"tokens":` puede activar la expresión sobre
   el JSON serializado aunque sea conversación normal, no una propiedad del export.
2. Un mensaje mal formado puede fallar después de insertar/enlazar el workspace y varios mensajes.
   El informe marca error, pero el retry encuentra el origen ya existente y deja el estado parcial.

Además, al no validar el esquema en runtime, un `provider`, rol o estructura inválidos atraviesan el
cast hasta que alguna operación casualmente falla —o se persisten datos incoherentes.

**Corrección:** validación TypeBox/Ajv real en la ruta; buscar claves prohibidas recorriendo sólo
claves de objetos, no el texto serializado; transacción por conversación con contador actualizado
después del commit.

**Prueba de regresión:** mensaje cuyo texto contiene todas las palabras prohibidas debe importarse;
un fallo en el mensaje N revierte workspace, vínculo, mensajes y borrador de esa conversación.

### N19 · Restore confía en rutas y etiquetas arbitrarias del manifiesto

**Evidencia:** `scripts/restore.mjs:32-60` usa `file.name` directamente en `join(from, file.name)` y
`join(authDir, file.name)`, y cualquier etiqueta distinta de `core-db` se trata como fichero de auth.

Un manifiesto alterado puede usar `../` para salir de los directorios esperados; el checksum sólo
confirma el contenido leído, no que la ruta sea válida. Con `--force`, una copia no confiable puede
sobrescribir un destino fuera de `authDir`. Tampoco se exige un único `core.db` ni el allowlist de
nombres que sí genera `backup.mjs`.

**Corrección:** validar esquema, `basename(name) === name`, contención tras `resolve`, etiquetas
exactas y allowlist (`core.db`, `users.json`, `session.key`, `internal.key`,
`revoked-sessions.json`, `audit.log`); rechazar duplicados y faltas críticas antes de copiar nada.

**Prueba de regresión:** manifiestos con `../`, nombre absoluto, symlink, etiqueta desconocida,
duplicado y ausencia de core deben abortar sin modificar ningún destino.

### N20 · El cliente SSE acumula todo el run con coste cuadrático

**Evidencia:** `apps/web/src/api/run-stream.ts:19-38`.

Por cada evento se copia el array completo (`events: [...previous.events, event]`) y el `Set` de
secuencias vistas nunca se poda. Un run verboso consume memoria lineal y trabajo total O(n²), además
de provocar un render por evento. En móvil, miles de eventos pueden congelar la pantalla justo
cuando más hace falta poder cancelar o leer el resultado.

**Corrección:** buffer acotado/ventana virtualizada, append por lotes y estado de cursor separado.
Los datos antiguos pueden pedirse paginados al abrir detalle; la vista viva no necesita retenerlos
todos en memoria.

**Prueba de regresión:** reproducir 50.000 eventos y fijar umbrales de memoria, renders y tiempo; la
vista conserva los últimos N más el cursor sin perder el estado terminal.

---

## Orden de corrección propuesto

### Bloque 1 — Evitar caída, fuga entre usuarios y duplicación

N01, N02, N04 y N05. Son invariantes de proceso/datos; conviene resolverlos antes de añadir más UI.

### Bloque 2 — Hacer ciertas las promesas de acceso y seguridad

N03, N06, N07, N09, N10, N11 y N13.

### Bloque 3 — Recuperación y operación

N08, N12, N14, N15, N16, N17 y N19.

### Bloque 4 — Integridad de flujos secundarios y rendimiento web

N18 y N20.

## Gate de aceptación recomendado

No consideraría Jarvis “100% funcional” sólo por cerrar tickets individuales. Antes de producción,
el gate debería exigir conjuntamente:

- E2E de todas las políticas de autenticación soportadas.
- Matriz de autorización con dos usuarios reales, o declaración explícita y enforceable de
  “sólo administradores”.
- Pruebas de concurrencia por sesión e idempotencia con barreras reales, no mocks secuenciales.
- Fault injection al matar core/gateway durante create, terminalización y limpieza de adjuntos.
- Clientes lentos para SSE/WebSocket y hosts SSH que aceptan conexión pero no responden.
- Restore hostil y restore de una copia real en un directorio vacío.
- Soak test de un run muy verboso y miles de búsquedas de sesión.

## Criterio de cierre

Cada punto debe cerrarse con: cambio de código, prueba automatizada que falla antes del cambio,
evidencia de ejecución de esa prueba y actualización del contrato/documentación cuando la garantía
real sea más débil que la que muestra la interfaz.
