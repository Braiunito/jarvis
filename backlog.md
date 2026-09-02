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

**Los estados que la pila falsa no produce.** El distintivo de cuota tiene cuatro estados y el
agente falso sólo genera uno: axe nunca ve el rojo de «te queda poca cuota», que es justo el que
hay que poder leer antes de mandar trabajo. En vez de fabricar una cuenta gastada, se mide el CSS
que los pinta: se inserta un distintivo de cada tono en una tarjeta real y se calcula el contraste
con la misma fórmula que usa axe, en los dos temas. Cubre todos los sitios donde aparece un
distintivo, no sólo la cuota.

Ojo con una trampa al medir así: `color-mix()` se computa como `color(srgb r g b)` con componentes
de 0 a 1, no como `rgb()` de 0 a 255. Leerlo mal da contrastes inventados —y fue lo que hizo fallar
la primera versión de esta comprobación con colores que sí cumplen.

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

### [x] UX-11 · Descartar lo que ya has mirado, y ver cuántas terminales hay

Cerrada el 2026-09-02, con el core de la sesión paralela (`acknowledged_at`, `POST /api/runs/ack`,
`metrics.terminals`).

- **Visto**: por fila en las que reclaman, y «Dar todos por vistos» en la tarjeta de «requieren que
  mires». No cambia el estado del trabajo, sólo deja de reclamar. El filtro por `acknowledgedAt` se
  aplicó también en el carril y en la portada, no sólo en `metrics`: si los tres sitios cuentan
  distinto, el aviso deja de significar algo.
- **Chip de terminales abiertas** junto a Terminal, y sólo cuando el core las ha contado alguna vez
  (`terminals.at !== null`). Un cero que en realidad es «no lo sé» es peor que no pintar nada.

### [x] UX-14 · Empezar una sesión desde cero (front de TEC-10)

Cerrada el 2026-09-02 sobre el core de la sesión paralela (`POST /api/sessions/new`). Hasta ahora
sólo se podía continuar lo que ya existía: para abrir una conversación nueva había que ir a la
máquina, arrancarla a mano y esperar a que el índice la viera.

- **Trabajo y terminal viva se eligen a la vista**, con el control segmentado y una línea que dice
  qué hace cada uno. No son la misma cosa —uno deja evidencia, el otro es un TTY— y esconder la
  elección en un desplegable hace que se acabe eligiendo por descarte.
- **No se ofrece lo imposible**: goro1 no tiene ningún agente y OpenCode sólo está en dos máquinas,
  así que las combinaciones que no existen salen deshabilitadas y con el motivo. Pero «no lo he
  comprobado» no es «no lo tiene»: mientras el sondeo no conteste no se deshabilita nada, que es la
  lección de HZ-04.
- **El prompt es opcional**: sin él se crea el workspace vacío y la primera tarea se escribe en el
  compositor, como en cualquier otro. Con él, además se lanza.
- **Dos estados nuevos que la pantalla sabe contar**: `sessionLaunched: false` («sin estrenar»: la
  conversación no existe aún en la máquina, así que un historial vacío no es una pérdida) y
  `sessionPending` («id asignándose»: Codex y OpenCode eligen el suyo y lo dicen al arrancar, así
  que ese identificador no se ofrece para copiar todavía).

Entradas: botón en el explorador —buscar sirve para continuar; cuando no hay nada que continuar, se
empieza—, primera acción rápida de la portada, la paleta con Ctrl+K, y el estado vacío del
explorador. Prueba E2E: «empezar una sesión desde cero», por el camino sin prompt, que es el que
deja el estado raro.

### [x] UX-13 · La línea de tiempo no repite lo mismo cuatro veces

Cerrada el 2026-09-02. Un agente que razona emite el mismo evento cada pocos segundos, y la
actividad se llenaba de tarjetas idénticas —«salida sin clasificar · el modelo está pensando»,
cuatro seguidas— que empujaban fuera de la pantalla lo único que se venía a leer.

- **Se agrupa lo consecutivo e idéntico**, con su `×N` y el rango de horas («19:18:32 → 19:18:36»).
  La firma es lo que se pinta, no el payload: dos eventos que se leen igual son, para quien mira, el
  mismo evento repetido. **Lo distinto no se junta nunca**, aunque llegue seguido: «paso 1/3» y
  «paso 2/3» son dos cosas que el agente dijo, y fundirlas escondería información. Hay test E2E de
  esa garantía, que es la que se rompe sin querer al optimizar.
- **Razonar deja de ser «sin clasificar»**: se reconoce por lo que el propio evento dice de sí
  mismo —su `subtype` o la nota del adaptador—, no adivinando, y se etiqueta «razonando».
- **Un evento crudo con nota se cuenta con la nota**. Antes se pintaban tres chips (`type: raw`,
  `payload: 6 campos`, `note: …`) y había que leer los tres para enterarse de uno.

Los eventos ya guardados no cambian al redesplegar, así que esto arregla también lo que hay en las
sesiones de ahora, no sólo lo que llegue a partir de aquí.

### [x] HZ-25 · El titulador nunca llamó al modelo, y por eso los nombres eran malos

Encontrado el 2026-09-02 al probarlo punta a punta contra el bastión, después de que el usuario
reportara títulos como «/model model» y «Bien, esa campanita debería ir en el».

Tres fallos encadenados, y el primero explica los otros dos:

1. **Las variables del titulador estaban en el `.env` y no se pasaban al contenedor.** `deploy/compose.yml`
   no incluía `JARVIS_TITLE_*` en el entorno del core, así que `titleApiKey` llegaba vacía, el
   modelo era `null` y **todos** los títulos salían del heurístico local. Un ajuste configurado que
   no llega es peor que uno ausente, porque nadie vuelve a mirarlo.
2. **El heurístico se tragaba el ruido de la CLI.** `<command-name>/model</command-name>` llega al
   transcript con `role: "user"`, y al quitar sólo las etiquetas quedaba «/model model». Ahora los
   bloques de comando se quitan enteros y hay un clasificador (`sessions/message-kind.ts`) que
   distingue texto, comando, salida de comando y aviso.
3. **El primer mensaje no era el primero.** Se pedían los últimos 20 mensajes y se trataba el
   primero de esa ventana como el primero de la sesión: en una sesión larga, eso es un mensaje
   cualquiera de la mitad —de ahí «Bien, esa campanita debería ir en el»—. Ahora el primero sale
   del `preview` que ya guarda el índice, que llega gratis con la fila que se lee para localizar la
   sesión.

Medido contra `qwen/qwen3.6-27b` en Groq con la clave real:

| llamada | resultado | tiempo |
|---|---|---|
| sin `reasoning_effort` | `<think>` y `finish_reason: "length"`, sin título | 14,6 s |
| con `reasoning_effort: "none"` | `revisar despliegue y corregir campana` | 6,3 s |

O sea que el ajuste heredado del LiteChat viejo era necesario **y** el tiempo de espera de 8 s se
quedaba corto para el modelo real: subido a 15 s, que nadie espera a esto.

### [x] HZ-24 · El explorador enseñaba 50 de 73 sesiones, y no lo decía

Encontrado el 2026-09-02 al no cuadrar dos números: el core marcaba 20 sesiones vacías y la consola
decía «17 ocultas». No era un fallo de pintado —el bundle servido coincidía con el compilado— sino
que `index-client.ts` mandaba `limit: String(query.limit ?? 50)`, heredando el valor por defecto
del índice. Medido contra el índice desplegado: `/api/sessions?limit=2000` devuelve 73 filas con 20
vacías; `/api/sessions` a secas devuelve 50 con 17.

Con 73 sesiones en la flota, 23 no aparecían nunca en el explorador y nada lo indicaba. Quien mira
una lista recortada en silencio concluye que lo que falta no existe.

Arreglado en dos partes, porque subir el número a secas sólo mueve el problema más lejos: el límite
se decide en el servicio (300) y `SessionSearchResult` gana `truncated`, que el explorador dice
cuando la consulta se llenó. Test: «el índice no cabe entero».

### [x] UX-12 · El nombre se queda puesto, y las sesiones fantasma no estorban

Cerrada el 2026-09-02, con dos fallos que se veían como uno solo.

**El título automático no persistía.** `touch()` protegía sólo `title_source = 'user'`, así que
volver al explorador y pulsar la misma sesión mandaba otra vez el título del índice y deshacía el
automático. Desde fuera se ve como que renombrar no guarda nada, y a partir de ahí nadie se fía de
la función. Ahora protege `'user'` y `'auto'`: los dos son mejores que el del índice, que es lo
que puso la CLI. Y `SessionSummary` lleva `workspaceTitle`, porque la lista enseñaba el nombre del
índice aunque el workspace ya tuviera otro.

**Las sesiones fantasma, con el dato correcto.** El stack anterior ya había decidido detectarlas
por contadores y **no por el patrón del título** (`CHANGELOG` de LiteChat, «Sesiones vacías»), y el
motivo sigue siendo el mismo: `Claude a758cca7` es la consecuencia —el índice cae a ese nombre
cuando ningún mensaje de la persona sirve para titular—, no la causa.

Medido sobre las **73 sesiones reales del bastión**: 20 tienen ese título, 17 están vacías del todo
(0 y 0), y las 3 restantes tienen `user_messages: 2` con `assistant_messages: 0`. Esas tres son el
caso que faltaba: sus únicos turnos de usuario son envoltorios de comando (`<command-name>`,
`[Request interrupted`), que el parser descarta como candidatos a título. Tienen contador de
usuario y no tienen nada que reanudar.

O sea que el dato que hacía falta no existía, así que se añadió **en el origen**:

- `aisessions` cuenta ahora `user_text_messages` —turnos de la persona que dicen algo— con columna
  propia y `SCHEMA_VERSION` 2 → 3, que reconstruye el índice solo al arrancar. 34 tests en verde
  con uno nuevo para el caso de los `/comando`. **Requiere reconstruir y redesplegar su imagen.**
- El core expone `empty` en `SessionSummary`, calculado con los contadores. Con un índice antiguo
  que no manda el campo, degrada a la regla de siempre en vez de romperse.
- La interfaz las oculta por defecto con un contador para enseñarlas, las marca «Vacía» cuando se
  enseñan, y la vista previa explica que reanudarla da un agente sin contexto —que es lo que se
  veía como «[sin respuesta]» y parecía un fallo de la aplicación.

### [x] UX-10 · El título automático, al entrar y no sólo al terminar

Cerrada el 2026-09-02. El nombre del workspace venía del índice, y lo que el índice sabe es lo que
la CLI puso: Claude nombra sus sesiones `Claude a758cca7` y Codex arrastra el preámbulo entero
—`<environment_context><cwd>/home/zeus</cwd>…`— como título. Ninguno sirve para reconocer un
trabajo en una lista, que es para lo único que existe un título.

- **Se dispara al entrar en el workspace**, no sólo al terminar un run: es cuando hay más contexto
  y cuando alguien lo está mirando. Va en segundo plano y la respuesta trae `titlePending`, así que
  la pantalla no espera a un modelo para pintarse y el nombre llega solo unos segundos después.
- **Sólo se renombra lo que no sirve** (`looksAutomatic`): hashes, UUID, el identificador de la
  sesión, lo que empieza por etiqueta o por JSON, rutas, textos sin letras, nombres de relleno
  («new session», «sin título») y cualquier cosa de más de 120 caracteres, que es un mensaje
  pegado donde no toca. Un título que ya sirve se queda, lo pusiera quien lo pusiera.
- **Las cuatro reglas del stack anterior siguen en pie**: el título de una persona gana siempre;
  hay ventana de frescura para que entrar dos veces no cueste dos llamadas ni cambie el nombre a
  mitad de mirarlo; la escritura comprueba la propiedad en el `WHERE`, porque entre leer y escribir
  cabe un renombrado; y sin modelo hay nombre igual, sacado del mensaje de la persona.
- **Grok y Qwen, con sus límites**: presupuesto de llamadas por minuto en todo el proceso
  (`JARVIS_TITLE_PER_MINUTE`, 8 por defecto); pasado el tope se nombra con el heurístico local en
  vez de esperar un 429. Y `reasoning_effort: "none"` para la familia Qwen, que si no gasta el
  presupuesto pensando y devuelve `finish_reason: "length"` sin título — el mismo fallo que ya
  estaba documentado en el LiteChat viejo.

**Los trabajos también se nombran por lo que se pidió.** `Run` gana `promptPreview` —el mensaje de
la persona, sin preámbulos, en una línea y recortado— y con él se titulan las listas de
«Trabajos de este workspace» y de Trabajo. Un identificador como `rt40nhvqeujq` no le dice nada a
nadie, y una lista de doce obliga a abrirlos uno a uno.

**Y el hilo de Actividad empieza por lo que pediste**, en azul frente al violeta del agente, para
no tener que recordar qué se había pedido al leer lo que contestó.

Ficheros: `workspaces/{title,routes}.ts`, `runs/repository.ts`, `contracts/runs.ts`, migración 7,
`ui/{event-log,labels}.ts(x)`, `screens/{workspace,runs}.tsx`, `api/queries.ts`.
Prueba: `npx vitest run apps/core/test/title.test.ts` (15 casos, con los títulos reales de Claude
y Codex).

---

## Bloque técnico · pendiente tras la migración

### TEC-01 · Transporte nativo de OpenCode
Hoy OpenCode va por `opencode run` como los demás. Su servidor HTTP/SSE daría sesiones vivas.

### TEC-02 · Recetas y runbooks tipados
Sólo cuando haya datos de qué se repite de verdad. No inventar un motor de workflows antes.

### [x] TEC-03 · Compactación de eventos antiguos

Hecho el 2026-09-02 · `apps/core/src/runs/retention.ts` (nuevo), `apps/core/test/retention.test.ts`
(nuevo, 12 pruebas), enganchado en `services.ts` y `main.ts`, ajustes en `config.ts`, check
`eventRetention` en `health/service.ts`.

La política del ADR-007 ya estaba decidida y nadie la aplicaba: el event log crecía para siempre.
Ahora un barrido periódico —al arrancar y cada 6 h, como el de spools— la ejecuta sobre la base
local:

- **Entre 7 y 30 días** se compacta sólo el payload pesado (`agent.tool`, `agent.raw`,
  `runner.stderr`): se sustituye por su huella `sha256`, el tamaño original y un resumen de una
  línea. El texto y el razonamiento se dejan enteros, que es lo que alguien vuelve a leer.
- **Pasados los 30** sobreviven los estructurales —estado, destino, arranque, resultado, error—,
  que son los que hacen que un trabajo antiguo siga siendo legible como historia.
- **Lo vivo no se toca nunca**, y `seq` no se renumera jamás: los huecos se quedan como huecos,
  porque es identidad pública y durable (ADR-005 en espíritu, RUN-EVENT-01 en la letra).

Dos decisiones que conviene no deshacer sin motivo. **Sin esquema nuevo**: se pregunta primero a
`runs` quién ha caducado y se baja después a los eventos de cada uno por su clave primaria
`(run_id, seq)`, así que no hace falta índice; al revés se lee entera la tabla grande cada seis
horas para descubrir que casi nada ha caducado. Y **no depende de la flota**: la base es local y se
limpia aunque no haya un solo host alcanzable, a diferencia del barrido de spools.

La prueba **ejecuta el barrido** contra una base real con trabajos de distintas edades y mira qué
quedó — no compara la consulta que se generaría. En este proyecto ya pasó lo contrario: una
limpieza estuvo meses «implementada» porque su test comprobaba la cadena del comando en vez de
correrlo.

Queda fuera a propósito el «export opcional» que el ADR menciona para lo de más de 30 días: es
opcional y nadie lo ha pedido todavía.

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

### [x] TEC-07 · La cuota sólo se ve en el workspace

Hecho el 2026-09-02. Enterarse de que a una cuenta le queda un 8% **después** de mandar trabajo es
enterarse tarde, y desde la portada y el Run Center también se lanza.

`/api/metrics` devuelve ahora `usage`: la ventana **más apretada** de cada cuenta, leída de los
snapshots que ya dejan el sondeo y los propios trabajos —no toca la red— y ordenada por lo que
primero va a molestar. Una sola por cuenta a propósito: el detalle por ventana sigue en el
workspace, que es donde hace falta.

Dónde cabe sin convertir cada pantalla en un panel de contadores:

- **portada**, dentro de «Reparto por agente», que es la tarjeta que ya habla de agentes: una barra
  por cuenta con su restante, en rojo por debajo del 15%;
- **Run Center**, en el sitio de «duración típica» **sólo cuando la cuota está baja**. Si va
  sobrada manda la duración, que es lo que se mira el resto del tiempo, con el restante como pista
  en la línea de abajo.

Ficheros: `apps/core/src/metrics/service.ts`, `apps/web/src/screens/{home,runs}.tsx`.

### [x] TEC-09 · La cuota se aprende del propio trabajo

Hecho 2026-09-02 · `apps/core/src/runs/service.ts` (`onQuota`), `apps/core/src/usage/service.ts`
(`recordFromAgent`), cableado en `services.ts`

Cada ejecución de Claude emite un `rate_limit_event` con `unifiedWindows` —`five_hour` y
`seven_day`, con su utilización y su reinicio—, que es exactamente lo que el sondeo caro saca
abriendo un TTY doce segundos y raspando una pantalla. Ahora el core lo lee al vuelo y actualiza el
snapshot.

Lo que lo hizo urgente: en vultr el sondeo por pantalla **no funciona** —la CLI es una versión
distinta y el panel no se dibuja a tiempo—, así que la consola enseñaba «cuenta · sin cuota leída»
sin más salida. Con esto, la cuota apareció sola en cuanto se lanzó un trabajo: sesión 86%
disponible, semana 95%, con sus horas de reinicio. Es más fresco, más barato y no depende de la
versión del CLI que haya en cada máquina; el sondeo queda de respaldo para cuando no hay actividad
reciente.

### [x] TEC-10 · Empezar una sesión desde cero

Hecho 2026-09-02 · `POST /api/sessions/new`, migración 9, `workspaces/{use-cases,repository}.ts`,
`runs/service.ts`, `adapters/claude.ts`

Se elige agente, máquina, carpeta opcional y qué se quiere: **un trabajo** o **una terminal viva**.
Antes sólo se podía continuar lo que ya existía, así que estrenar obligaba a ir a la máquina,
arrancar la conversación a mano y esperar a que el índice la viera.

Lo que costó decidir fue de quién es el identificador. **Claude acepta `--session-id`**, así que
Jarvis lo pone y el workspace nace con su identidad definitiva. **Codex y OpenCode** generan el
suyo y lo dicen en su primer evento: hasta entonces el workspace lleva uno provisional
(`sessionPending`) y lo **adopta una sola vez** — la identidad de un workspace no cambia por ningún
otro motivo (ADR-005).

El `prompt` es opcional: sin él se crea la sesión y se escribe la primera instrucción en el
compositor, como en cualquier otra. Quien decide si un trabajo estrena o continúa es el core, no
quien llama: mirar `sessionLaunched` es más fiable que pedirle a la interfaz que se acuerde.

Comprobado contra las máquinas: Claude en el bastión (`SESION-NUEVA-OK`), Codex adoptando su id
real (`01a06448-…`, `CODEX-NUEVA-OK`) y una tmux estrenada desde cero.

Esto obligó a cambiar un contrato congelado —`ADAPT-CLAUDE-01/no-resume` ahora lleva el
`--session-id`—; el fixture lleva la nota de por qué, y se añadió el caso contrario.

### [x] TEC-11 · Una sesión sin `cwd` conocido no se puede reanudar, y el error no lo dice

Hecho 2026-09-02 · `packages/agent-adapters/src/project-dir.ts` (nuevo),
`apps/core/src/sessions/cwd-resolver.ts` (nuevo), `runs/service.ts`, `sessions/service.ts`,
`workspaces/{repository,use-cases}.ts`, migración 10, `adapters/claude.ts`

Claude Code guarda las conversaciones por directorio, así que `claude --resume <id>` desde otro
sitio responde «No conversation found with session ID»: suena a sesión inexistente cuando lo que
pasa es que se está mirando en la carpeta equivocada. Diez sesiones de la flota estaban así.

**Por qué el path no se puede invertir a ciegas.** El slug del proyecto es el `cwd` con cada
carácter no alfanumérico convertido en guion, y ese aplanado pierde información:
`/var/www/vhosts/fmgagro.com` y `/var/www/vhosts/fmgagro/com` producen exactamente el mismo
nombre. Así que se generan las lecturas posibles —cada guion vuelve a ser una barra o un `?` de
glob, las más literales primero— y **decide la máquina**, en una sola llamada, cuál existe. Las
cinco sesiones sin `cwd` de la flota se resolvieron a la primera: `contaduria.braianmaciel.com` en
vultr, `fmgagro.com` y `crm.nextambulances.com` en goro3, `/var/www/vhosts` y `/root` en goro2.

**Lo que apareció por el camino y valía más que la tarea.** En la misma llamada se comprueba el
directorio que declara el índice, no sólo los deducidos: un `cwd` que se movió o se borró hacía
morir el trabajo con un `cd` fallido y un código de salida 2, sin nada que lo explicara. Y el
adaptador no leía el campo `errors` del resultado, que es donde Claude pone el motivo cuando
falla: el trabajo terminaba en rojo y con el resultado en blanco.

El directorio deducido se guarda con su origen (`Workspace.cwdSource`: `index` | `derived` |
`user`) porque no es lo mismo un dato que declaró el transcript que uno que dedujo el sistema, y
la interfaz debería poder decirlo. Un directorio escrito por una persona no lo pisa ninguna
deducción posterior, y esa condición vive en el SQL, no en quien llama.

Pruebas: `packages/legacy-contract-tests/test/project-dir.test.ts` (RESUME-CWD-01, RESUME-HINT-01;
el barrido se **ejecuta** en sh, bash y zsh, que es la lección de `buildSweepCommand`),
`apps/core/test/cwd-resolver.test.ts` y dos casos de punta a punta en `durable-runs.test.ts`
contra un directorio real.

**Lo que la prueba contra la flota enseñó, y que obligó a reescribir el mensaje.** Con la
derivación puesta, el workspace de vultr aprendió su directorio —`cwd_source: derived`— y el
trabajo salió hacia él… y Claude volvió a decir que no encontraba la conversación. La causa no era
la carpeta: ver HZ-27. El mensaje distingue ahora los dos casos, porque decir «indica el directorio
correcto» cuando el directorio ya es el correcto es cambiar un engaño por otro.

### TEC-08 · El sondeo de cuota de Claude depende de una pantalla de terminal
Leer `/usage` es abrir un TTY desechable, teclear dentro y raspar el texto: doce segundos y roto
en cuanto Claude Code cambie ese diseño. Es lo que hay mientras no exista una salida legible por
máquina; conviene revisarlo en cada actualización del CLI. Codex ya se pregunta por JSON-RPC, que
es como debería ser en los tres.

---

## Cierre de la migración

Vienen del plan (`migration-mission/04-migration-plan.md`) y no estaban anotados aquí, que es lo
que el propio plan pedía en su fase 7. **Los dos piden días de calendario**: repartir manos no los
acelera, así que lo que se cierra es su parte ejecutable y el resto queda con fecha de revisión.

### MIG-06 · Gate M6 · convivencia

Criterio de cierre, tal cual el plan:

- siete días de uso normal sin fallo P0/P1 de autenticación, destino, pérdida o durabilidad;
- copia diaria y un restore de muestra comprobado;
- los smokes corren después de **cada** despliegue;
- el rollback **ensayado**, no sólo escrito;
- el stack viejo disponible pero sin recibir escrituras — hecho el 2026-09-02: `jarvis-bridge-1`
  parado con `restart=no` y `jarvis.service` pendiente de desactivar.

Ejecutable ya: el ensayo de rollback, los smokes tras despliegue y el restore de muestra.

### MIG-07 · Gate M7 · cierre

- ampliar la ventana a 30 días según criticidad;
- exportar la última bitácora del stack viejo;
- retirar los contenedores viejos **sin borrar copias**;
- archivar LiteChat en solo lectura con la etiqueta del último despliegue;
- actualizar `runbook` y `CLAUDE.md` del repo nuevo;
- cerrar sólo tareas cuyo criterio esté demostrado.

## Pendientes del plan que nadie había anotado

El plan los llamaba «después del corte» y se quedaron dentro de él. Se anotan aquí para que existan
como tareas, no para hacerlos ya: el orden lo decide el uso.

### TEC-12 · Aprobaciones de diff y de despliegue

Hoy una aprobación describe la acción con un digest, pero lo que se autoriza sigue siendo texto. Un
cambio de ficheros o un despliegue se aprueban mejor viendo **qué cambia**: el diff, los ficheros
tocados y el destino. Encaja con el Assistant, que ya pide permiso antes de lo que tiene efectos.

### TEC-13 · Políticas por workspace y por host

El perfil de permisos se elige por trabajo y se olvida entre uno y otro. Una política —«en este
host nunca `yolo`», «este workspace siempre `safe`»— es lo que evita elegir bien doce veces y mal
la trece. Requiere decidir qué gana cuando la política y la elección se contradicen: hoy no hay
respuesta escrita.

### TEC-14 · Handoff entre sesiones

Pasar un contexto de un agente a otro —de Claude a Codex, o entre máquinas— sin copiar y pegar a
mano. El material ya existe (transcript, evidencia de runs, adjuntos); falta decidir qué viaja y
qué se queda, que es la parte difícil.

## Auditorías del 2026-09-02

Dos revisiones estáticas del árbol, guardadas en
[`docs/audits/`](./docs/audits/): la
[general](./docs/audits/2026-09-02-auditoria-jarvis.md) (9 fallos que rompen promesas del producto,
33 acotados, más pulido) y la
[diferencial de Codex](./docs/audits/2026-09-02-auditoria-diferencial-codex.md) (20 hallazgos
distintos, sin repetir los de la primera).

Se guardan enteras y no se resumen aquí a propósito: cada hallazgo trae su evidencia con fichero y
línea, y ese detalle es lo que permite arreglarlo sin volver a investigarlo. Lo que sí vive aquí es
**quién lleva qué**, porque somos tres trabajando en el mismo árbol.

| Zona | Quién | Hallazgos |
|---|---|---|
| Core, adaptadores, Assistant | `litechat-ea` | A1, A2 (+A2b), A3, A6, A7, A8, A9, M1–M24, N01, N04–N09, N12, N14–N19 |
| Despliegue, gateway, seguridad | `jarvis-69` | M31, M32, M33, N02, N10, N11, N13 |
| Consola web | esta sesión | A4 (mitad de interfaz), A5, M25–M30, N03, N20 |

**Lo primero es A1 y A2**, y no por gusto: sin ellos «parar» y «durable» son promesas falsas.
Cancelar mata el subshell y deja al agente vivo gastando cuota y tocando ficheros con el permiso
que se quería cortar; y un run cuya tmux muere en `running` se queda así cuatro horas.

**N02 no es un bug, es una decisión de producto**: hoy cualquier cuenta autenticada puede verlo y
tocarlo todo. Con una sola persona no se nota; en cuanto haya dos, hay que decidir si un workspace
tiene dueño. Eso lo decide el usuario, no nosotros.

## Propuestas sin acordar

Ideas que salieron trabajando y que **no se tocan hasta que el usuario diga**. Están escritas para
que no se pierdan y para que la decisión se tome mirándolas, no de memoria. Ninguna es un defecto:
las dos son superficie nueva.

### PROP-01 · Que un paso del plan diga qué evidencia miró

Salió al diseñar TEC-06. Cuando el Assistant pueda leer adjuntos, diffs y ficheros de un run, su
razonamiento seguirá siendo invisible: se ve el resultado, no en qué se apoyó. Un paso que dijera
«leyó `error.log`» o «miró los cambios en `src/`» haría auditable el razonamiento y no sólo su
conclusión, que es lo que hace falta para confiar en un plan que no has seguido en directo.

Coste: un campo nuevo en el paso y su pintado. **No está en TEC-06** y por eso no entra con ella.

### PROP-02 · Enseñar el diff en la tarjeta de aprobación

Hoy una aprobación lleva `summary` —texto— y su digest atado a la acción. Aprobar un cambio de
ficheros o un despliegue se hace mejor viendo **qué cambia**. Requiere que el core capture el diff
y lo guarde junto a la aprobación, así que es tarea con nombre propio y no un adelanto de otra.
Emparenta con TEC-12.

## Hallazgos

> **Nota de la parte de interfaz de HZ-27** (2026-09-02). Se eligió ofrecer lo único que funciona
> en vez de avisar de lo que va a fallar: en una sesión sin un solo turno, el compositor se
> sustituye por «empezar una conversación aquí», con la máquina y la carpeta ya puestas, y la vista
> previa del explorador ofrece lo mismo antes de abrirla. Un aviso que dice «esto va a fallar» y
> aun así deja pulsar Enviar es una trampa con un cartel.
>
> La regla distingue dos vacíos que se parecen: una sesión **estrenada desde Jarvis** también está
> vacía, pero funciona —su primer trabajo la crea—, así que ahí el compositor se queda. Se afirma
> sólo con el transcript ya cargado: mientras carga, no se sabe.
>
> También se pinta `cwdSource: 'derived'` como «deducida» junto a la ruta: es fiable —el core
> comprobó que ese directorio existe en la máquina— pero es una deducción, y si se equivocara el
> agente leería y editaría los ficheros de otra carpeta.

Cosas que aparecieron trabajando en otra tarea. Se anotan aquí para que no se pierdan y para que
quien las arregle sepa de dónde salieron.

### [x] HZ-27 · Las sesiones que dejó el puente antiguo no son sesiones, y no hay forma de recuperarlas

Las **10 sesiones sin `cwd`** del índice —vultr 1, goro2 5, goro3 4— tienen un transcript de **una
sola línea**:

```json
{"type":"bridge-session","sessionId":"…","bridgeSessionId":"cse_…","lastSequenceNum":0}
```

Ni un turno. Son marcas que escribió el puente del stack anterior al registrar una sesión que nunca
llegó a tener contenido. Por eso el índice no traía su `cwd`: el `cwd` se lee de las líneas de
mensaje, y no hay ninguna.

Están en un limbo, comprobado contra la máquina y no deducido:

```
claude --resume <id>      → No conversation found with session ID: <id>
claude --session-id <id>  → Session ID <id> is already in use.
```

No se pueden continuar —no hay nada que continuar— ni estrenar con su identificador, porque para
Claude el archivo ya existe. Lo único que se puede hacer desde Jarvis es empezar una conversación
nueva; borrar el archivo es una decisión sobre la máquina, no sobre nuestra base.

Qué se hizo con esto: el mensaje de TEC-11 lo dice cuando el caso es éste, en vez de mandar a
corregir un directorio que ya era correcto. Qué **no** se hizo, y por qué: rechazar el trabajo
antes de lanzarlo. Sería posible —el índice ya marca estas sesiones como vacías— pero ese dato
puede estar viejo, y rechazar una sesión que sí tiene turnos porque el índice aún no los ha visto
es peor que un trabajo que falla con una explicación exacta.

En la interfaz se resolvió ofreciendo en vez de avisando (`3f4d7e7`): en una sesión sin un solo
turno, el compositor se sustituye por «empezar una conversación aquí» con máquina y carpeta ya
puestas. Un aviso que dice «esto va a fallar» y aun así deja pulsar Enviar es una trampa con un
cartel.

Y el core lo **afirma** en vez de dejar que se deduzca: `SessionSummary.resumable`. La regla que la
interfaz tenía que inventar —no salió de Jarvis, no tiene turnos, no tiene trabajos, y sólo se
sabe con el transcript ya cargado— es exactamente la clase de deducción que este hallazgo enseñó a
desconfiar. Con la distinción que importa: una sesión estrenada desde Jarvis y aún sin lanzar
también está vacía, y **sí** es utilizable, porque su primer trabajo es el que la crea.

### [x] HZ-26 · `bin/jarvis backup` no funciona contra el stack desplegado

Encontrado 2026-09-02 al respaldar antes de un despliegue · lo arregla `jarvis-69`

`deploy/Dockerfile.core` no copia `scripts/` a la imagen, así que
`compose exec core node /app/scripts/backup.mjs` falla con `MODULE_NOT_FOUND` desde que existe. Y
el consejo que da al fallar —ejecutarlo desde el repositorio— es imposible de seguir donde hace
falta: las rutas viven dentro de un volumen de Docker y el bastión no tiene Node, que es
justamente la gracia de `bin/jarvis`. El único comando que la documentación ofrece para respaldar
producción era el único que no se podía ejecutar en producción.

La copia previa a este despliegue se hizo a mano con `VACUUM INTO` desde el propio contenedor, que
es lo que el script hace, y quedó verificada en `/home/zeus/jarvis/backups/`.

### [x] HZ-25 · El Assistant estaba apagado porque el core hablaba con el proveedor equivocado

Hecho 2026-09-02 · `apps/core/src/assistant/model.ts` (`OpenAiCompatibleModel`), `config.ts`,
`services.ts`, `deploy/compose.yml`

El panel del Assistant llevaba días diciendo «no hay modelo configurado en el core», y la lectura
fácil era que faltaba una credencial. Faltaba **la que el core sabía usar**: la migración trajo el
motor de planes y el modelo contra la Messages API de Anthropic, pero esta casa tiene —y llevaba
meses usando— una credencial de OpenAI. Con el proveedor equivocado no hay clave que valga.

Ahora el core habla los dos protocolos, el proveedor se elige con `JARVIS_MODEL_PROVIDER` y por
defecto se deduce de la URL. El compose pasa además `JARVIS_MODEL_BASE_URL` y el proveedor: sin
eso, una credencial de OpenAI acababa llamando a la API de Anthropic y el Assistant quedaba
configurado y aun así roto, que es peor que apagado.

Al probarlo contra el modelo real salió un fallo que ningún test con un doble habría encontrado:
cuando el modelo pide **dos herramientas en el mismo mensaje**, la API exige una respuesta por cada
`tool_call_id` y devuelve 400 si falta alguna. Se respondía sólo a la primera, así que el plan
moría en el primer turno en que quería mirar dos cosas antes de decidir —que es lo normal—.
Corregido y con test.

Comprobado en zeus de punta a punta: objetivo → el modelo decide un paso con su motivo → trabajo
real en goro2 (`node: v22.21.0 git: 2.47.3`) → síntesis que cita el trabajo por su id y ofrece los
siguientes pasos concretos.

### [x] HZ-26 · La línea de tiempo se llenaba de «el modelo está pensando»

Hecho 2026-09-02 · `packages/agent-adapters/src/adapters/claude.ts`

Claude Code emite un contador de razonamiento cada pocos segundos, y guardarlo ponía cinco tarjetas
idénticas seguidas que empujaban fuera de la pantalla lo único que se venía a leer: qué hizo el
agente y qué respondió. Ya no se guarda; que sigue trabajando lo dice su estado.

### [x] HZ-24 · Veintitrés sesiones de la flota no aparecían nunca

Hecho 2026-09-02 · `apps/core/src/sessions/{service,routes}.ts`, `packages/contracts/src/sessions.ts`

El explorador enseñaba 50 de las 73 sesiones de la flota, y nada decía que faltaran. El tope estaba
en **dos capas**: el servicio heredaba el defecto del cliente del índice, y la ruta —que es la que
mandaba— inventaba un `?? 50` propio cuando nadie pedía límite. Arreglar sólo el servicio no cambió
nada, porque la ruta seguía pisándolo; se vio porque la respuesta llegaba marcada como recortada
con 50 filas, que sólo cuadra si el límite efectivo era 50.

Ahora la ruta no inventa límite —lo decide el servicio— y `SessionSearchResult` lleva `truncated`,
que el explorador cuenta: una lista recortada en silencio hace concluir que lo que falta no existe.
Comprobado en zeus: 73 sesiones, `truncated: false`, repartidas goro2 27 · goro3 19 · bastion 18 ·
vultr 7 · bevrim 2.

### [x] HZ-21 · La limpieza de spools no existía, y su comando no funcionaba

Hecho 2026-09-02 · `packages/agent-adapters/src/runner.ts`, `apps/core/src/runs/{supervisor,remote-runner,spool}.ts`
· test `RUNNER-SWEEP-01`

Salud enseñaba «Limpieza de spools · sin datos» y se quedaba en 9/10. Detrás había dos fallos, uno
tapando al otro:

1. **Nadie barría.** El check existía y `noteSweep()` también, pero no había una sola llamada en
   todo el repositorio: la limpieza nunca se implementó. El disco de cada máquina de la flota
   crecía sin tope con spools de trabajos de hace meses.
2. **El comando de barrido estaba roto de origen.** `buildSweepCommand` anidaba comillas simples
   dentro de comillas simples y **ningún** shell remoto lo aceptaba: bash respondía `syntax error`
   y zsh `parse error near then`. Aunque alguien hubiera llamado a `noteSweep`, el barrido habría
   fallado en las seis máquinas a la vez.

Ahora el supervisor barre al arrancar y cada seis horas (`JARVIS_SWEEP_INTERVAL_MS`,
`JARVIS_SPOOL_RETENTION_DAYS`), resolviendo el spool con el home de cada host; un host caído no
detiene a los demás. El comando se reescribió con un `while read` que sí parsea, y su test
**ejecuta el barrido en un shell de verdad** en vez de comparar la cadena: comprobar el texto es lo
que dejó pasar el error original. En zeus: 10/10 en comprobaciones.

### [x] HZ-22 · «Requieren atención» no se podía vaciar

Hecho 2026-09-02 · migración 8, `runs/{repository,routes}.ts`, `metrics/service.ts`

El aviso contaba todo lo que había fallado en la ventana, sin forma de decir «ya lo he visto»: un
fallo de hace tres días pedía lo mismo que uno de hace un minuto, así que el número no bajaba nunca
y dejaba de mirarse. Ahora hay `POST /api/runs/:id/ack` y `POST /api/runs/ack`, y el contador sólo
suma lo no reconocido. No cambia el trabajo: sigue fallido, con su estado y sus eventos; sólo deja
de reclamar.

### [x] HZ-23 · No había forma de saber cuántas terminales estaban abiertas

Hecho 2026-09-02 · `apps/core/src/terminal/service.ts`, `apps/core/src/metrics/service.ts`

La navegación avisa de trabajo y de salud, pero no de terminales vivas, que es justo lo que se
olvida abierto. Contarlas cuesta un ssh por máquina, así que `/api/metrics` publica el último
recuento conocido con TTL de un minuto y refresca por detrás: una consola que espera a seis
servidores para pintar un número es peor que un número de hace un minuto. Sólo se pregunta a los
hosts que ya se saben con tmux, y mientras no se haya contado nunca el dato viaja como `at: null`
para que la interfaz no pinte un cero que en realidad es «no lo sé».

Abrir y cerrar **mueven el número en el momento**, sin esperar al siguiente recuento: son acciones
deliberadas de una persona, y el caso que de verdad importa es cerrar la última terminal de una
máquina y que el aviso siga marcando una —uno se va creyendo que dejó algo abierto—. Un contador
que miente tranquilizando es peor que no tenerlo. El ajuste es optimista (reengancharse a una que
ya estaba no suma) y el recuento de fondo corrige cualquier desvío. Comprobado en zeus: 2 → abrir
→ 3 → cerrar → 2, al instante.

### [x] HZ-20 · Ninguna conversación de la flota se podía leer

Hecho 2026-09-02 · `aisessions/src/aisessions/{serve,cli}.py`, `deploy/compose.yml`,
`apps/core/src/sessions/service.ts`

Abrir una sesión de goro2, goro3, vultr o bevrim enseñaba el destino, el título y el trabajo de
Jarvis, pero la pestaña «Conversación» salía vacía y el resumen decía «0 mensajes». El motivo
estaba en el índice: `/api/export` rechaza con 501 las sesiones que no son de su propia máquina,
por una decisión suya —exportar una remota implica que el servidor abra un ssh—. Como el índice
sólo indexa el bastión en local, eso dejaba fuera **toda la flota**, que es casi todo.

En el despliegue de Jarvis esa precaución no aplica: el índice ya tiene la clave de la flota
montada y ya sincroniza por ssh. Se añadió `--allow-remote-export` a `aisessions serve` (apagado
por defecto, sólo lectura, claude y codex; opencode sigue necesitando el agente) y el compose lo
activa. De paso, el core explica el 501 en vez de repetir «index responded 501»: dice de qué
máquina es la sesión y qué sigue funcionando sin eso.

Comprobado en la consola del bastión: una sesión de goro2 abre con sus 40 últimos mensajes de 368,
con la procedencia a la vista («escrito por el agente en goro2, Jarvis sólo lo lee»).

### [x] HZ-17 · Los dos stacks compartían identidad de Compose

Hecho 2026-09-02 · `deploy/compose.yml` (`name: jarvis-next`)

El compose nuevo declaraba `name: jarvis`, igual que el del stack anterior, y con servicios que se
llaman igual (gateway, core, aisessions). Docker los trataba como el mismo proyecto: los
contenedores nuevos ocupaban los nombres de los viejos, y **cualquier `docker compose up` lanzado
desde el árbol anterior —o su `jarvis.service`, que seguía habilitado— los recreaba con las
imágenes de antes, encima y sin avisar**. En el bastión eso significa que un reinicio podía
deshacer el despliegue.

Además, un `compose down` sobre ese proyecto se habría llevado por delante `tailscaled`, que es
por donde se entra a zeus desde fuera: eran huérfanos del mismo nombre. El stack nuevo se llama
ahora `jarvis-next`, con sus propios volúmenes (los datos se copiaron, los antiguos siguen
intactos como vuelta atrás), y su unidad de systemd documenta que hay que desactivar la anterior.

### [x] HZ-18 · `$HOME` en la configuración se expandía en el bastión

Hecho 2026-09-02 · `deploy/compose.yml`, `deploy/.env.example`, `apps/core/src/main.ts`

`JARVIS_SPOOL_ROOT=$HOME/...` parecía correcto, pero **Compose interpola `$HOME` con el entorno de
la máquina donde se lanza**: al core le llegaba `/home/zeus/...` ya expandido, y entonces cada
máquina de la flota intentaba escribir en el home del bastión. El síntoma al otro lado era
`mkdir: cannot create directory '/home/zeus': Permission denied`, que no señala a la configuración
por ningún lado.

Se escribe con `~`, que no expande ni Compose ni el shell, y el core avisa al arrancar si el spool
empieza por el home de su propio proceso —que es la huella de este error—.

### [x] HZ-19 · El montaje de la clave de la flota apuntaba a un sitio inexistente

Hecho 2026-09-02 · `deploy/compose.yml`, `deploy/.env.example`

El compose montaba `./secrets/ssh`, y las rutas relativas se resuelven contra el fichero compose:
`deploy/secrets/ssh`, un directorio que nadie crea y que el `.gitignore` ni siquiera cubre —protege
`secrets/` en la raíz—. Docker creaba un directorio vacío y el core respondía «Could not resolve
hostname bastion» para los seis hosts. Ahora el defecto es `../secrets/ssh` y el ejemplo explica
que en un despliegue conviene ruta absoluta.

### [x] HZ-14 · El empaquetado nunca se había construido desde cero

Hecho 2026-09-02 · `.dockerignore` (nuevo), `deploy/Dockerfile.{core,gateway}`

Al desplegar de verdad en zeus, la imagen del gateway falló con veinte errores encabezados por
«Cannot find module `@jarvis/contracts`». La causa no estaba en el código: **no había
`.dockerignore`**, así que el contexto de construcción se llevaba `node_modules`, `dist` y —lo que
lo rompía— los `*.tsbuildinfo`, que viven fuera de `dist/`. Dentro del contenedor, `tsc -b` leía
ese estado incremental heredado, daba los paquetes por compilados y no generaba los tipos; el
build del front se caía después, señalando a un sitio que no era la causa.

Ahora hay `.dockerignore` con lo que jamás debe entrar (incluidos secretos y bases) y los
Dockerfiles compilan con `tsc -b --force`, para que el resultado no dependa de lo que traiga el
contexto.

### [x] HZ-15 · El stack no podía construir su propio índice de sesiones

Hecho 2026-09-02 · `deploy/Dockerfile.aisessions` (nuevo), `deploy/aisessions-sync.sh` (nuevo)

`deploy/compose.yml` esperaba una imagen `aisessions:latest` construida por otro. En zeus existía
sólo porque la había construido el stack de LiteChat, que es justo el que se va a archivar: el
despliegue nuevo no se podía reconstruir por sí mismo. Ahora el índice se construye desde el
repositorio de aiSessions —vecino, con su ruta configurable— y el bucle de sincronización de la
flota vive en `deploy/`, no prestado del repo anterior.

### [x] HZ-16 · El puerto de la consola estaba fijo, y con él la posibilidad de un corte

Hecho 2026-09-02 · `deploy/compose.lan.yml`

La superposición de red local publicaba `8080` a pelo, que es el puerto que ocupa el stack
anterior. Levantar el nuevo al lado para compararlos —que es como se hace un corte con vuelta
atrás— exigía tumbar el viejo primero. Ahora es `JARVIS_LAN_PORT`.

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
