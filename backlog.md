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

### UX-06 · Estados vacíos, de carga y de error con oficio

- cada pantalla vacía explica qué hacer, no sólo que está vacía;
- los esqueletos de carga tienen la forma del contenido que viene;
- un error ofrece siempre la siguiente acción (reintentar, abrir salud, copiar diagnóstico);
- `aria-live` anuncia transiciones de estado, no cada token que llega.

### UX-07 · Repaso de accesibilidad y móvil

- foco visible y orden de tabulación en las cinco pantallas;
- objetivos táctiles de 44 px de verdad, comprobados en 390×844;
- contraste AA en ambos temas;
- la terminal móvil con teclas Esc/Tab/flechas/Ctrl+C ya está: falta probarla con teclado virtual
  abierto, que es cuando el layout se rompe.

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

### TEC-08 · El sondeo de cuota de Claude depende de una pantalla de terminal
Leer `/usage` es abrir un TTY desechable, teclear dentro y raspar el texto: doce segundos y roto
en cuanto Claude Code cambie ese diseño. Es lo que hay mientras no exista una salida legible por
máquina; conviene revisarlo en cada actualización del CLI. Codex ya se pregunta por JSON-RPC, que
es como debería ser en los tres.

---

## Hallazgos

Cosas que aparecieron trabajando en otra tarea. Se anotan aquí para que no se pierdan y para que
quien las arregle sepa de dónde salieron.

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
