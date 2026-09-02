# Backlog · Jarvis

Estado: abierto · creado 2026-09-02

Este backlog es lo que viene **después** de terminar la migración técnica (M0–M5 + empaquetado y
evidencias, ver [`docs/migration/`](./docs/migration/)). El orden de arriba abajo es el orden de
ejecución previsto: **se arranca por UX-01**.

Convención: `[ ]` pendiente · `[-]` en curso · `[x]` hecho (con fecha, ficheros y comprobación).

---

## Bloque UX · repensar la consola (prioridad 1)

Encargo del 2026-09-02: repensar UI/UX, revisar qué librerías merece la pena incluir, mejorar los
textos, reordenar los accesos alrededor de flujos de trabajo reales, y asegurar que Assistant y
título automático existen.

### [x] UX-01 · Vocabulario del producto, en español y sin jerga heredada

Hecho 2026-09-02 · `apps/web/src/ui/labels.ts` + las cinco pantallas · `npm run test:e2e`

`safe` / `auto` / `yolo` son nombres de la CLI, no del producto. La etiqueta que ve una persona
tiene que decir qué puede hacer el agente, no cómo se llama la bandera por dentro.

| Interno (no cambia) | Lo que se muestra | Frase de ayuda |
|---|---|---|
| `safe` | **Sólo lectura** | Puede mirar y proponer. No cambia nada. |
| `auto` | **Puede editar** | Escribe ficheros en el destino, sin sandbox de red. |
| `yolo` | **Sin restricciones** | Ejecuta cualquier cosa en la máquina. Pide confirmación aparte. |

- El valor interno (`permissionProfile`) **no** se renombra: es contrato con las CLIs y con la
  auditoría, y renombrarlo rompería fixtures y el histórico.
- La traducción vive en un solo sitio del front, junto al resto de etiquetas.
- Repasar en la misma pasada: `run` → «trabajo» / «ejecución» donde sea texto corrido, `workspace`
  se queda (es el objeto del dominio), `stale` → «último dato conocido, de hace X», `failed` →
  «falló», `timed_out` → «se agotó el tiempo».
- Todo mensaje de error debe decir **qué pasó, dónde y qué hacer ahora**; el código técnico va en
  segundo plano, para copiar.

### [x] UX-02 · Elegir librerías de interfaz (decisión con ADR)

Hecho 2026-09-02 · [ADR-008](docs/adr/0008-ui-libraries.md). Entraron `cmdk` (paleta) y
`lucide-react` (iconos, ISC). Radix por componente cuando llegue el ticket que lo pida; Base UI se
revisa cuando publique estable — su 1.0 sigue saliendo como `rc` en npm. Bundle: 156 → 180 KiB
gzip, techo 400.

Los iconos están mapeados en `apps/web/src/ui/icons.tsx`, en paralelo al vocabulario: navegación,
estados de trabajo y de plan, permisos, salud, procedencia, acciones y paleta. Un estado se
distingue por forma además de por color.

Hoy el front es React + CSS propio, sin dependencias de UI. Funciona, pero hay piezas que no
merece la pena escribir a mano: menús accesibles, diálogos con foco atrapado, paleta de comandos,
listas largas virtualizadas y avisos.

Candidatas a evaluar, con el criterio de **no reintroducir una plataforma genérica** (fue la causa
de la migración) y de que cada una resuelva un problema concreto:

| Necesidad | Candidata | Por qué / riesgo |
|---|---|---|
| primitivas accesibles (menú, diálogo, tabs, tooltip) | Base UI o Radix Primitives | headless, sin estilos impuestos; riesgo: peso y otra API que aprender |
| sistema de estilos | Tailwind v4 (o seguir con CSS propio + tokens) | el equipo ya lo conoce; riesgo: clases largas en JSX y otra cadena de build |
| componentes ya compuestos | shadcn/ui | se copia el código al repo, no es dependencia; riesgo: arrastra Tailwind + Radix |
| paleta de comandos | cmdk | resuelve el quick switcher de UX-04 |
| listas largas | @tanstack/react-virtual | el explorador puede tener miles de sesiones |
| iconos | lucide-react | consistencia; sólo si se importa por icono, no el paquete entero |
| avisos | sonner, o un componente propio de 40 líneas | evaluar si compensa la dependencia |
| formularios | ninguna | los formularios de esta consola son de 2–3 campos |

Entregable: ADR-008 con la decisión, el presupuesto de bundle (hoy 155 KiB gzip; techo 400 KiB) y
la lista de lo que **no** se adopta y por qué.

### [x] UX-03 · Assistant: que exista de verdad en la interfaz

Cerrada el 2026-09-02. El panel del workspace delega un objetivo, enseña los pasos como lista con
su estado, pide permiso con una tarjeta que dice acción, destino, permiso y caducidad, y cierra
con la síntesis.

Lo que faltaba y ya está:

- **`waiting_input`**: cuando el plan pregunta algo hay dónde contestar (`QuestionCard` +
  `useAnswerPlan` contra `POST /api/plans/:id/input`). Sin ese hueco, un plan que preguntaba se
  quedaba parado sin decir por qué;
- **cada paso enlaza con su trabajo**: si el paso lanzó un run, la fila lleva el botón que abre su
  evidencia. Un plan que cuenta una historia que no se puede comprobar no sirve de nada;
- **la síntesis enlaza a la evidencia**: `step.output.evidence` se pinta como lista de trabajos
  citados con su estado, sin copiar buffers;
- **aviso fuera de la pantalla donde nació**: la cabecera lleva «N esperan tu permiso» en todas las
  pantallas, alimentado por `/api/metrics` (`plans.waitingApproval`).

Ficheros: `apps/web/src/ui/assistant.tsx`, `apps/web/src/api/queries.ts`, `apps/web/src/app.tsx`.
Prueba: `npm run build`, `npx playwright test` (flujo 4).

### [x] UX-04 · Reordenar los accesos por flujo, no por entidad

Cerrada el 2026-09-02, junto con la adaptación de todas las vistas al lenguaje visual de
`sketch/`. Hecho: paleta de comandos (Ctrl+K y botón, porque el atajo se lo queda algún
navegador), «seguir donde lo dejaste» como primera acción de la portada, contador de trabajo y de
lo que pide atención en la navegación, barra inferior en móvil, y la terminal que se abre desde el
workspace con host y sesión ya elegidos —y se conecta sola, porque quien pulsó «Abrir terminal» ya
eligió; volver es un clic porque el enlace lleva `from`—. La oferta de terminal del Assistant usa
el mismo camino.

Las cinco pantallas quedaron con el mismo armazón: carril de secciones ordenado por flujo, cabecera
con migas y buscador, barra de estado abajo, y dentro tarjetas, métricas reales del servidor
(`/api/metrics`), tablas comparables y línea de tiempo. Ficheros: `apps/web/src/app.tsx`,
`screens/{home,explorer,workspace,runs,terminal,health,login}.tsx`,
`ui/{primitives,charts,page-meta,event-log,icons}.tsx`, `styles.css`.

Hoy la navegación es una lista de secciones (Inicio, Sesiones, Runs, Terminal, Salud). Los flujos
reales son otros:

1. **retomar** — buscar, previsualizar, abrir, continuar;
2. **delegar** — describir objetivo, confirmar alcance, observar;
3. **vigilar** — qué está corriendo, qué pide algo de mí;
4. **intervenir** — entrar a la terminal, parar, reintentar;
5. **diagnosticar** — qué salto está roto y cómo se copia.

Trabajo concreto:
- paleta de comandos (Ctrl/Cmd+K) que salte a workspace, host, run o acción sin usar el ratón;
- «continuar donde estaba» como primera acción de la portada;
- la terminal se abre desde el workspace con el host y la sesión ya elegidos, no como sección
  suelta donde hay que rellenar dos selectores;
- Run Center accesible desde cualquier pantalla con un indicador de cuántos piden atención;
- móvil: barra inferior con las cuatro acciones reales, no el menú de escritorio encogido.

### [x] UX-05 · Título automático del workspace

Hecho 2026-09-02 · `apps/core/src/workspaces/title.ts`, migración 5 (`title_source`), título
editable en la consola. Sin modelo configurado se nombra con el prompt; con `JARVIS_TITLE_*` se
usa un modelo pequeño. El título que escribe una persona gana y no se vuelve a tocar
(`npx vitest run apps/core/test/title.test.ts`).

Un workspace se llama hoy como el título que trae el índice, o como su id, que no dice nada.

- generar un título corto a partir del primer prompt y del primer resultado;
- hacerlo en el core con el modelo pequeño configurado (`JARVIS_TITLE_*`), nunca en el navegador;
- **un título escrito por una persona siempre gana** y no se vuelve a tocar (regresión conocida
  del stack viejo: el título automático pisaba el que el usuario había puesto);
- si no hay modelo configurado, se cae a las primeras palabras del prompt: sin modelo no se queda
  sin nombre.

### [x] UX-06 · Estados vacíos, de carga y de error con oficio

Cerrada el 2026-09-02. Los tres estados que más se repiten tienen ahora una regla cada uno, escrita
en `apps/web/src/ui/bits.tsx`: un vacío dice qué hacer, un esqueleto tiene la forma de lo que
viene, y un error ofrece la siguiente acción. Un callejón sin salida no es un estado.

- **Vacíos con salida.** `Empty` admite acción, y la lleva donde existe: la portada sin workspaces
  manda a buscar una sesión, el explorador sin resultados distingue «no hay nada» de «tus filtros
  no dejan pasar nada» —y en el primer caso enlaza a Salud, porque un índice vacío suele ser un
  salto roto—, el workspace sin trabajos ofrece escribir la primera tarea. La variante `tight` es
  para los paneles laterales, donde un vacío centrado de 200 px es peor que el problema.
- **Esqueletos con forma.** `Loading` tiene cinco formas (`list`, `table`, `stats`, `timeline`,
  `text`) que imitan la pieza real, así que al llegar el contenido la página no salta. Se anuncia
  una vez, no una por fila.
- **Errores con siguiente paso.** `ErrorNote` da siempre al menos un camino: reintentar cuando el
  servidor dice que se puede, «ver qué salto falla» cuando el código es de conexión
  (`HOST_UNREACHABLE`, `TMUX_MISSING`, `INDEX_UNAVAILABLE`…), y copiar el diagnóstico —código,
  mensaje, petición, hora y pantalla— para pedir ayuda sin transcribir a mano. Lo copiado no lleva
  prompts ni salida del agente.
- **`aria-live` para transiciones, no para tokens.** Una sola región en toda la aplicación
  (`ui/announce.tsx`): el trabajo cambió de estado, el plan pide permiso, la terminal se
  desconectó. La respuesta del agente **no** es una región viva: se leería token a token y no se
  entendería nada. `useAnnounceOnChange` calla en el primer render, porque llegar a una pantalla
  con algo ya terminado no es una novedad.

Ficheros: `ui/bits.tsx`, `ui/announce.tsx` (nuevo) y las seis pantallas.
Prueba: `npx playwright test a11y` (el aviso de la terminal se comprueba de rebote: el texto
«conectada» aparece dos veces, en el distintivo y en la región de anuncios).

### [x] UX-07 · Repaso de accesibilidad y móvil

Cerrada el 2026-09-02, y con test que lo sostiene: `tests/e2e/a11y.spec.ts` pasa axe (WCAG 2.1 A y
AA) por las seis pantallas y por las cuatro pestañas del workspace, en escritorio y en teléfono.

- **Foco visible y orden de tabulación.** Una regla base `:focus-visible` en vez de que cada
  componente traiga la suya —había piezas sin ninguna—, y un «Saltar al contenido» como primer
  elemento del orden, porque con cinco destinos delante llegar al compositor costaba una docena de
  saltos. El test recorre la portada **con el tabulador**: `element.focus()` no dispara
  `:focus-visible` y un test que lo use mide otra cosa.
- **44 px de verdad.** Por tipo de puntero (`pointer: coarse`), no por ancho: una tableta con dedo
  tiene el mismo problema y un escritorio estrecho no lo tiene. Medido en 390×844.
- **Contraste AA en ambos temas.** Salieron seis fallos reales. El de fondo: los distintivos
  pintaban el texto del color del estado sobre un fondo teñido con ese mismo color **y con
  `transparent`**, así que el contraste real dependía de lo que hubiera detrás; dentro de una fila
  seleccionada el verde caía a 4.1:1. Ahora se componen contra `--bg-card` y son deterministas.
  También se corrigieron `--text-faint` (era 3.8:1, y ahí viven las horas y los `seq`), el blanco
  sobre el botón primario en oscuro (3.5:1 → relleno propio `--accent-fill`) y los tonos del tema
  claro, medidos sobre su propio tinte y no sobre el blanco.
- **Nombres accesibles en el teléfono.** `.chip-text` se escondía con `display: none`, y eso deja
  sin nombre a los botones que en pantalla estrecha sólo enseñan icono: «Salir» era un botón sin
  más. Ahora se esconde de la vista pero no del árbol.
- **Regiones con scroll alcanzables.** La conversación y el JSON del evento son zonas con scroll
  propio: sin `tabindex` no había forma de recorrerlas sin ratón.
- **Teclado virtual.** `dvh` mide la ventana, no lo que queda visible: la terminal y la fila de
  teclas acababan debajo del teclado, que es justo cuando se usan. La pantalla publica
  `--viewport` desde `visualViewport` y el alto lo resuelve el CSS; con el teclado abierto la barra
  de secciones se retira para dejarle el sitio a las teclas útiles. El test simula el encogimiento
  y comprueba que Esc sigue dentro de lo visible.

Alta: `@axe-core/playwright` 4.13.0 (MPL-2.0), sólo de desarrollo: no viaja en el bundle.

### [x] UX-08 · Los eventos del agente se leen, no se descifran

Cerrada el 2026-09-02. La línea de tiempo de un trabajo volcaba el JSON crudo de cada evento, y en
el Run Center directamente `JSON.stringify(payload)`. Ahora cada evento es una tarjeta con su
color y su forma:

- lo que se sabe contar se cuenta en una línea (destino, cambio de estado, respuesta, herramienta,
  resultado);
- lo que es un objeto plano —el arranque del agente, lo que llega sin clasificar, un tipo de
  evento que aún no conocemos— se pinta como chips de campo y valor, que es lo que un objeto es;
- el crudo queda a un clic, en un modal con el JSON plegable y un botón de copiar.

La regla, escrita en `apps/web/src/ui/event-log.tsx`: **el JSON no se enseña si se puede contar**.
Un evento nuevo no rompe la pantalla ni obliga a leer llaves.

Altas: `@radix-ui/react-dialog` (ya estaba) y `react-json-view-lite` 2.5.0 (MIT, ~7 KiB), en el
ADR-008. Coste total del bloque: 191 → 195 KiB gzip.

### [x] UX-09 · Dónde contestó la IA se ve sin buscarlo

Cerrada el 2026-09-02, a petición directa: en un flujo largo, encontrar la respuesta del agente
costaba leer la línea de tiempo entera. Un trabajo típico son treinta eventos de fontanería
—estados, herramientas, arranques— y dos de respuesta, y todos pesaban lo mismo.

- **La respuesta pesa más que el resto.** `agent.text`, `agent.result` y `agent.error` se pintan
  con tipografía de lectura (14 px, interlineado 1.68) en vez de tipografía de log, banda violeta
  —el color que ya significa «el agente» en todo el producto—, sombra, más aire y un punto relleno
  y más grande en el carril, para localizarla desplazando sin leer.
- **Se pueden aislar.** La línea de tiempo ofrece «Todo · Sólo respuestas» cuando hay bastante
  ruido para que sirva (más de cuatro eventos y al menos una respuesta), y dice cuántas hay entre
  cuántos eventos. No borra nada: vuelve con un clic.
- **La conversación y la síntesis, igual.** Lo que dijo el agente en el transcript y el
  «Resultado» de un plan comparten el mismo tratamiento, porque son la misma cosa.

Es a propósito el **único** sitio del producto con este realce: si todo destaca, no destaca nada.

Ficheros: `ui/event-log.tsx`, `ui/assistant.tsx`, `styles.css`.

---

## Bloque técnico · pendiente tras la migración

### TEC-01 · Transporte nativo de OpenCode
Hoy OpenCode va por `opencode run` como los demás. Su servidor HTTP/SSE daría sesiones vivas.

### TEC-02 · Recetas y runbooks tipados
Sólo cuando haya datos de qué se repite de verdad. No inventar un motor de workflows antes.

### TEC-03 · Compactación de eventos antiguos
La política está en ADR-007; falta el trabajo periódico que la aplica.

### TEC-04 · Migración del almacén de autenticación
`users.json` → SQLite y/o SimpleWebAuthn. Es una misión aparte con verificador dual y rollback
propio (ADR-006), no un ticket suelto.

### TEC-05 · Segunda opinión
Mandar el mismo objetivo a dos proveedores y comparar. Vuelve sólo como acción explícita.

### TEC-06 · El Assistant no ve la evidencia que no es texto (M4-17)
El coordinador ya consulta sesiones, transcript, salud y trabajos (`apps/core/src/assistant/`),
pero los adjuntos, los diffs y los ficheros de un run le son invisibles: no hay herramienta que
los liste ni que enseñe su previsualización con procedencia. Es lo que la misión llamaba «context
packets». Hasta que exista, un plan que dependa de un fichero adjunto tiene que pedirle a un run
que lo lea.

### TEC-07 · La cuota sólo se ve en el workspace
`/api/usage` está sondeado y cacheado por host y proveedor, pero la portada y el Run Center —donde
también se decide lanzar trabajo— no la enseñan. El dato ya está y es barato (`usage.lastKnown`
no toca la red); falta decidir dónde cabe sin convertir cada pantalla en un panel de contadores.

### TEC-09 · La cuota viene gratis en cada run de Claude, y se está tirando
Cada ejecución emite un `rate_limit_event` con `unifiedWindows`: `five_hour` y `seven_day` con su
utilización y su reinicio. En la campaña real coincidía **exactamente** con lo que el sondeo caro
saca abriendo un TTY doce segundos. Aprovecharlo significa que la cuota se refresca sola cada vez
que trabaja un agente y que el sondeo queda como respaldo para cuando no hay actividad reciente.
Toca contratos (un tipo de evento nuevo) y el `UsageService`, así que va como ticket propio.

### TEC-10 · No se puede empezar una sesión nueva desde Jarvis
Todo run hace `resume` de una sesión existente. Para estrenar una conversación en una máquina hay
que crearla fuera y esperar a que el índice la vea. El stack anterior tenía `resume: false` en su
herramienta; aquí no hay equivalente, y se notó al probar OpenCode en vultr, donde no había ninguna
sesión indexada que reanudar.

### TEC-11 · Una sesión sin `cwd` conocido no se puede reanudar, y el error no lo dice
Claude Code guarda las conversaciones por directorio: `claude --resume <id>` desde otro sitio
responde «No conversation found with session ID», que suena a sesión inexistente cuando lo que pasa
es que se está mirando en la carpeta equivocada. Pasó con una sesión real de vultr cuyo `cwd` el
índice no traía. Hace falta (a) derivar el directorio del path del transcript, que lo codifica, y
(b) que el mensaje diga que el problema es el directorio.

### TEC-08 · El sondeo de cuota de Claude depende de una pantalla de terminal
Leer `/usage` es abrir un TTY desechable, teclear dentro y raspar el texto: doce segundos y roto
en cuanto Claude Code cambie ese diseño. Es lo que hay mientras no exista una salida legible por
máquina; conviene revisarlo en cada actualización del CLI. Codex ya se pregunta por JSON-RPC, que
es como debería ser en los tres.

---

## Hallazgos

Cosas que aparecieron trabajando en otra tarea. Se anotan aquí para que no se pierdan y para que
quien las arregle sepa de dónde salieron.

### [x] HZ-09 · El spool por defecto hacía imposible lanzar cualquier trabajo

Hecho 2026-09-02 · `packages/agent-adapters/src/hosts.ts`, `apps/core/src/runs/{service,supervisor,remote-runner}.ts`

`JARVIS_SPOOL_ROOT` viene por defecto como `$HOME/.local/state/jarvis/runs`, y `spoolLayout` exige
una ruta absoluta: `$HOME` entrecomillado no lo expande nadie. Un despliegue que no fijara esa
variable respondía **500 «internal error»** a cada `POST /api/runs`. No se había visto nunca porque
dev-local y los tests fijan una ruta absoluta propia; el valor por defecto del producto no se
ejercitaba en ningún sitio.

Ahora la sonda de capacidades trae también el `$HOME` de cada máquina —sale gratis, va en la misma
llamada— y el spool se resuelve con el home del **host que ejecuta**: `/home/zeus/...` en zeus y
`/root/...` en vultr. Cada run guarda su directorio, así que leerlo o cancelarlo después usa el que
se decidió al crearlo y no la configuración de hoy. Comprobado contra zeus: el spool aparece en
`/home/zeus/.local/state/jarvis/runs/<run>/`.

### [x] HZ-10 · Un trabajo de Codex terminaba «bien» y con el resultado en blanco

Hecho 2026-09-02 · `apps/core/src/runs/service.ts`

Con codex-cli 0.152 —los contratos se congelaron con 0.149— el evento final del turno trae métricas
y ya no repite el texto de la respuesta. El agente contestaba, el evento `agent.text` estaba ahí, y
aun así el run se guardaba con `resultSummary` vacío: la tarjeta no enseñaba nada, el título
automático se quedaba sin material y la síntesis del Assistant no podía citar el resultado. Ahora,
si el evento final no trae texto, se usa lo último que dijo el agente. Vale para los tres
proveedores: cualquier CLI que deje de repetirse queda cubierta.

### [x] HZ-11 · Los eventos nuevos de Claude Code salían como «sin traducir»

Hecho 2026-09-02 · `packages/agent-adapters/src/adapters/claude.ts`, `apps/web/src/ui/event-log.tsx`

Claude Code 2.1.258 emite dos tipos que el adaptador no conocía: `system/thinking_tokens` (el
contador de razonamiento, que llenaba la línea de tiempo de tarjetas vacías) y `rate_limit_event`.
Ninguno rompía nada —degradaban a crudo, como está diseñado—, pero se leían como un fallo del
producto. Ahora el adaptador les pone nombre y la interfaz enseña esa nota en vez de «evento sin
traducir todavía», que es lo que hay que hacer con una CLI que saca versión cada semana.

### [x] HZ-12 · Los errores de las CLIs llegaban con el color de terminal dentro

Hecho 2026-09-02 · `apps/core/src/runs/supervisor.ts` · test en `apps/core/test/run-state.test.ts`

`opencode` escribe sus errores con secuencias ANSI aunque nadie mire, y la cola de `stderr` viaja
tal cual a la tarjeta del trabajo: se leía «[91m[1mError: [0mSession not found». Ahora se limpia
antes de guardarla.

### [x] HZ-13 · La frescura del índice contaba el bastión dos veces

Hecho 2026-09-02 · `apps/core/src/sessions/index-client.ts`

El índice llama `local` a la máquina donde corre, que **es** el bastión, y además puede tener
sesiones bajo su nombre propio. Sin fusionar, la interfaz enseñaba «zeus ok hace 2 días · zeus ok
hace 13 horas» sin manera de saber cuál valía. Ahora se fusionan por host: se suman las sesiones y
se conserva la actividad más reciente.

### [x] HZ-06 · Reabrir una sesión borraba el nombre que había escrito una persona

Hecho 2026-09-02 · `apps/core/src/workspaces/repository.ts` · `apps/core/test/title.test.ts`

UX-05 dejó cerrada la regla —el título de una persona gana y no se vuelve a tocar— y el
`TitleService` la respeta. Pero el explorador manda `title: session.title` en **cada** apertura, y
`touch()` hacía `title = COALESCE(?, title)` sin mirar `title_source`: renombrabas el workspace,
volvías a Sesiones, pulsabas la misma sesión y el nombre volvía al del índice. La misma regresión
del stack viejo entrando por otra puerta. Ahora la reapertura respeta `title_source = 'user'`; el
`cwd` y el `source_root` sí se refrescan, que es lo que se quiere de una reapertura.

### [x] HZ-07 · «40 mensajes» de una sesión de trescientos

Hecho 2026-09-02 · `apps/core/src/sessions/{index-client,service}.ts`, `apps/web/src/ui/usage.tsx`

La cabecera contaba `transcript.messages.length`, y el transcript se pide de 40 en 40. El número
era el tamaño de la página, presentado como el tamaño de la sesión. El total sale gratis de la
fila del índice que ya se buscaba para resolver la clave; ahora viaja en la respuesta como
`messageCount` y la interfaz dice cuándo está viendo sólo los últimos.

### [x] HZ-08 · Un sondeo de cuenta vacío se guardaba como bueno

Hecho 2026-09-02 · `apps/core/src/usage/service.ts` · `tests/integration/usage.test.ts`

Si `claude auth status` respondía sin JSON y `/usage` no dejaba nada raspable, el resultado era un
snapshot con cuenta nula y cero límites, persistido como dato bueno durante cinco minutos: la
cabecera enseñaba un badge que decía «cuenta» y nada más, sin manera de saber que había fallado.
Ahora, sin cuenta ni cuotas, es un error con su motivo; y el sondeo a medias —cuenta sí, cuotas
no, que es lo que devuelve un Claude recién instalado con su pantalla de bienvenida— se reintenta
**una vez** saltándose el TTL, que es la solución que ya traía el stack anterior.

De paso, las CLIs falsas del testkit simulan ahora `claude auth status --json`, la pantalla
`/usage` y `codex app-server`, así que este camino se puede ver funcionando en `npm run dev:local`
y está cubierto de punta a punta.

### [x] HZ-01 · Dos turnos simultáneos de un plan proponían el mismo paso dos veces

Encontrado el 2026-09-02 mientras se rehacía la interfaz: la suite fallaba de forma intermitente
—tres pasos `run` donde debía haber dos— y sólo con la suite entera en paralelo.

`PlanService.advance` se llama desde cuatro sitios (el supervisor, crear el plan, responder una
pregunta y resolver una aprobación) y dentro espera dos veces largas: lanzar un run y preguntar al
modelo. Dos llamadas concurrentes veían el mismo historial y las dos proponían un paso. Con un
modelo de verdad eso además cuesta dinero.

Arreglado serializando los turnos por plan (`#running`/`#queued` + `#advanceOnce`) y con una
migración que lo sostiene desde la base: `UNIQUE INDEX plan_steps (plan_id, ordinal)` (versión 6).
Regresión: «dos avances simultáneos son un solo turno» en `tests/integration/assistant.test.ts`.

### [x] HZ-05 · `.e2e/` estaba versionado, con `session.key` y `users.json` dentro

234 ficheros que generan al arrancar la pila de pruebas (`.e2e/`) y la de desarrollo (`.dev/`) —los shims del ssh falso y el estado del
gateway— estaban en git. Entre ellos `session.key` y `users.json` con el hash de la
contraseña de prueba, en las dos. No hay secreto real ahí (la contraseña está escrita en el propio
test y todo se regenera en cada ejecución), pero es exactamente lo que la regla del proyecto
prohíbe, y además ensuciaba cada `git status` con veinte ficheros borrados.

Sacados del índice y añadidos a `.gitignore` junto con `test-results/` y
`playwright-report/`. **Queda pendiente decidir** si se limpia el historial:
como no hay secreto real, la opción barata es no reescribirlo. Este repo tampoco tiene instalado
el hook de secretos que sí tiene LiteChat (`core.hooksPath`), y por eso nada avisó.

### [x] HZ-03 · La lista de terminales enseñaba el mundo de hace un rato

Abrir una terminal no invalidaba `['terminals', host]`, así que la lista seguía diciendo «ninguna
sesión abierta aquí todavía» mientras el API devolvía la sesión recién creada. Sólo se veía cuando
llegabas a la pantalla **antes** de que existiera la sesión —que es el caso normal—, y por eso
había pasado desapercibido. Abrir es ahora una mutación (`useOpenTerminal`) que invalida la lista,
igual que destruir.

### [x] HZ-04 · «No lo hemos comprobado» se enseñaba como «no tiene tmux»

`/api/hosts` sin `probe=1` devuelve lo último que se sabe, y de un host nunca sondeado eso es
`tmux: false` con `stale: true`. El selector de máquina lo pintaba como «(sin tmux)» y lo
deshabilitaba, cuando conectarse funcionaba perfectamente. Ahora sólo se marca lo que se ha
comprobado de verdad.

### [x] HZ-02 · El E2E de la terminal dependía de quién llegara antes

El test comprobaba el banner del agente falso, que sólo aparece la primera vez: al reengancharse,
tmux redibuja la pantalla actual, no el historial. En escritorio pasaba y en móvil fallaba porque
la sesión ya existía. Ahora se comprueba el eco de lo que se teclea, que es lo que de verdad
demuestra que hay un TTY al otro lado.
