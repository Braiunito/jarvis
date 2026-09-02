# Changelog

Todas las entradas describen **qué cambió para quien usa esto**, no qué ficheros se tocaron.

## [0.1.0] — en curso · migración desde LiteChat

### Añadido

- **Contratos congelados** (M0): 91 pruebas doradas que fijan lo que la migración promete
  conservar — entrecomillado SSH, allowlist de hosts, estrategias A/B, los tres adaptadores de CLI
  y el protocolo del spool remoto. Corren sin red, sin Docker y sin bastión.
- **Gateway** (M1): passkeys con el mismo formato de `users.json` v1 que el stack anterior, así que
  una credencial ya enrolada entra sin volver a registrarse. Cadena de pasos configurable,
  revocación de sesión en el servidor y la escotilla de HTTP plano, apagada por defecto y ruidosa
  cuando está encendida.
- **Core** (M2/M3): workspaces con identidad estable, borradores con compare-and-swap, y runs
  durables. Un run vive en una tmux del host con su spool, no en la conexión SSH del core: se
  puede reiniciar el core a mitad de una ejecución sin perderla ni duplicarla.
- **SSE reanudable**: `Last-Event-ID` reconstruye exactamente desde un `seq` conocido. Desconectar
  no toca el run.
- **Terminal viva** (M4): attach a tmux por WebSocket con TTY real, teclas de móvil y detach limpio
  al cerrar. Salir no mata la sesión.
- **Assistant durable** (M4): un objetivo se convierte en pasos que viven en SQLite. El modelo
  propone y el core ejecuta, así que un plan sobrevive a un reinicio. Las aprobaciones son de un
  solo uso, caducan y su digest las ata a la acción concreta que se autorizó.
- **El Assistant, con herramientas de verdad** (M4-04/05/06/11): el coordinador ya no decide a
  ciegas. Dentro de su turno busca sesiones en la flota, lee el transcript de la que trabaja,
  pregunta por la salud de cada salto, mira los trabajos del workspace y para uno que va mal. Esas
  herramientas llaman a los mismos casos de uso que la API —así que lo que hace el Assistant se
  audita igual que lo que hace una persona— y sólo alcanzan el workspace de su plan. Lo que
  devuelven va acotado, y lo dice. La síntesis cita los trabajos por su identificador en vez de
  copiar su salida, y puede dejar **ofrecida** una terminal viva, que abre la persona y nunca el
  modelo. El presupuesto de consultas por turno lo aplica el servidor: un turno acaba siempre en un
  paso que se puede guardar, nunca en un bucle de preguntas.
- **Importación desde LiteChat** (M5): idempotente por instalación y conversación, con procedencia
  visible. Un export que traiga claves de proveedor se rechaza entero en vez de limpiarse por
  detrás.
- **Backup y restore** verificados: `VACUUM INTO` para la base, checksums en el manifiesto e
  `integrity_check` al restaurar.
- **Consola** (web): React sin stores globales. El destino y el permiso se ven antes de enviar, el
  borrador sobrevive a navegar y a fallar, y lo que escribió el agente remoto nunca se confunde con
  lo que hizo Jarvis.
- **La consola, ordenada por flujos** (UX-04): carril de secciones en el orden en que se trabaja
  —retomar, vigilar, intervenir, diagnosticar—, cabecera con migas y buscador (Ctrl+K), y barra de
  estado con entorno, máquinas, tiempo en pie y versiones. En el teléfono el carril baja y se
  queda en iconos. La portada abre por «continuar donde lo dejaste» y enseña números de verdad,
  calculados en el servidor (`/api/metrics`), no una cuenta de la última página cargada.
- **La terminal se abre desde donde hace falta**: pulsar «Abrir terminal» en un workspace lleva la
  máquina y la sesión ya elegidas y conecta sola —esa decisión ya la tomaste—, con un enlace de
  vuelta al workspace del que se vino.
- **Los eventos del agente se leen** (UX-08): cada evento es una tarjeta con su color y su forma.
  Lo que se sabe contar se cuenta en una línea; lo que es un objeto plano se enseña como chips de
  campo y valor; el JSON crudo queda a un clic, plegable y con botón de copiar. Antes la línea de
  tiempo era un volcado.
- **Cerrar una terminal desde la interfaz**: junto a «Reconectar», y en cada fila de la lista de
  sesiones. Destruir sigue siendo explícito —salir de la pantalla no mata nada— así que lo pide
  con un diálogo que nombra la sesión y la máquina antes de tocarlas.
- **Lo que ya has mirado deja de reclamar**: un trabajo fallido se puede dar por visto, uno a uno
  o todos de golpe, desde Trabajo. No cambia de estado —sigue fallido, con sus eventos y su
  evidencia—, sólo deja de contar en «requieren atención». Sin eso, cuatro fallos de la semana
  pasada dejaban el aviso encendido para siempre y el número acababa siendo ruido de fondo. El
  contador baja a la vez en el carril, en la portada y en el Run Center: un aviso que se
  contradice a sí mismo deja de mirarse.
- **Cuántas terminales hay abiertas**, junto a Terminal en el carril. Se enseña sólo cuando se ha
  contado de verdad: un cero que en realidad significa «todavía no lo sé» haría creer que no hay
  ninguna.
- **La cuota se ve donde también se decide lanzar**: en la portada, dentro de la tarjeta que ya
  habla de agentes, y en Trabajo cuando está baja. Antes sólo aparecía dentro de un workspace, así
  que enterarse de que a una cuenta le quedaba un 8% pasaba después de mandar el trabajo.
- **Se puede empezar una sesión desde cero**: eliges agente, máquina, carpeta y permiso, y si
  quieres un trabajo o una terminal viva. Antes había que ir a la máquina, arrancarla a mano y
  esperar a que el índice la viera. Las combinaciones que no existen —una máquina sin ese agente—
  no se ofrecen, y si dejas la primera tarea en blanco se crea el workspace vacío y la escribes
  allí, como en cualquier otro.
- **La actividad deja de repetir lo mismo**: los eventos idénticos seguidos —un agente razonando
  emite uno cada pocos segundos— se cuentan una vez, con cuántas veces pasó y desde cuándo hasta
  cuándo. Lo distinto no se junta: dos respuestas seguidas siguen siendo dos. Y lo que llegaba como
  «salida sin clasificar» mientras el modelo razonaba se llama ahora «razonando».
- **Los títulos automáticos ya los escribe el modelo**: las variables del titulador estaban en el
  `.env` y no llegaban al contenedor, así que el modelo nunca se llamó y todos los nombres salían
  del heurístico local. De ahí «/model model» y frases sueltas sacadas de la mitad de un hilo.
- **Lo que se teclea en la CLI deja de parecer un mensaje**: `/model` y su salida se enseñan como
  una línea corta —comando, salida, aviso— en vez de como algo que escribió una persona, y no
  entran en el material con el que se pone nombre a la sesión.
- **Trabajo explica qué es un trabajo**: una sesión vive en la máquina y existe aunque Jarvis esté
  apagado; un trabajo es una ejecución que lanzaste desde aquí sobre esa sesión, con destino,
  permiso, eventos y resultado. Una sesión puede tener muchos trabajos.
- **Una lista de sesiones vacía dice por qué lo está**: el índice todavía no ha barrido, barrió y
  no encontró nada, o tus filtros no dejan pasar nada. Antes las tres se veían igual.
- **El explorador enseñaba 50 sesiones de 73** y no lo decía: el core pedía al índice su página por
  defecto. Ahora pide muchas más y, cuando aun así se llena, la pantalla avisa de que hay más y de
  cómo llegar a ellas. Una lista recortada en silencio hace concluir que lo que falta no existe.
- **El nombre puesto se queda puesto**: renombrar un workspace —a mano o automáticamente— ya no se
  deshace al volver al explorador y pulsar la misma sesión, y la lista de sesiones enseña ese
  nombre en vez del que trae el índice.
- **Las sesiones donde nunca pasó nada dejan de estorbar**: se ocultan por defecto, con un contador
  para verlas y un aviso de que reanudarlas da un agente sin contexto. Se detectan por sus
  contadores de mensajes, no por el patrón del título: `Claude a758cca7` es la consecuencia, no la
  causa. Para distinguir las que sólo guardan un `/comando` que nadie contestó, el índice cuenta
  ahora los turnos de la persona que dicen algo de verdad.
- **Los workspaces se llaman por lo que se pidió** (UX-10): al entrar en uno cuyo nombre no sirve
  —`Claude a758cca7`, el `<environment_context>` que arrastra Codex, un hash, un vacío— se sustituye
  por lo que la persona pidió, en segundo plano y sin que la pantalla espere. Lo que escribe una
  persona gana siempre y no se vuelve a tocar, un título recién puesto no se regenera, y si el
  modelo no está o se agotó su cuota el nombre sale igual del propio mensaje.
- **Los trabajos también**: en «Trabajos de este workspace» y en Trabajo, cada fila se titula con
  el mensaje que se envió en vez de con su identificador, que sigue debajo para cuando hay que
  citarlo.
- **El hilo de Actividad empieza por lo que pediste**, en azul frente al violeta del agente, así
  que se lee la respuesta sin tener que recordar la pregunta.
- **Dónde contestó la IA se ve sin buscarlo** (UX-09): en un trabajo largo, lo que dijo el agente
  son dos líneas entre treinta de fontanería. Ahora la respuesta se pinta con tipografía de
  lectura, banda violeta y aire alrededor, y la línea de tiempo ofrece «Sólo respuestas» para
  aislarlas de un clic. La conversación y la síntesis de un plan comparten el mismo tratamiento.
- **Los tres estados que más se repiten, con oficio** (UX-06): una pantalla vacía dice qué hacer y
  lleva ahí —la portada sin workspaces manda a buscar una sesión, un explorador sin resultados
  distingue «no hay nada» de «tus filtros no dejan pasar nada»—; los esqueletos de carga tienen la
  forma de lo que viene, así que la página no salta al llegar; y un error ofrece siempre la
  siguiente acción: reintentar, ver qué salto falla, o copiar el diagnóstico —sin prompts ni salida
  del agente— para pedir ayuda sin transcribir nada a mano.
- **Se puede operar sin ratón y sin ver bien** (UX-07): «Saltar al contenido» como primer paso del
  tabulador, foco visible en todo, objetivos de 44 px cuando se navega con el dedo, y contraste AA
  comprobado con axe en las seis pantallas y en los dos temas. Los cambios de estado —un trabajo
  que termina, un plan que pide permiso, una terminal que se cae— se anuncian a los lectores de
  pantalla; la respuesta del agente no, porque se leería token a token.
- **La terminal deja de esconderse bajo el teclado**: con el teclado virtual abierto, la terminal
  encoge y la fila de teclas (Esc, Tab, flechas, Ctrl+C) sigue a mano, que es justo cuando hace
  falta.
- **El Assistant, completo en la interfaz** (UX-03): cuando el plan pregunta, hay dónde contestar;
  cada paso enlaza con el trabajo que lanzó; la síntesis enlaza con los trabajos que la sostienen;
  y si un plan pide permiso mientras estás en otra pantalla, la cabecera lo dice.

- **Cuenta y cuota, en la cabecera del workspace**: se enseña lo que **queda** de cada ventana
  —«sesión 55% · semana 88%»—, no lo gastado, con la ventana siempre pegada al número, aviso en
  rojo por debajo del 15% y el detalle completo al pasar por encima: correo, plan, en qué máquina
  se ejecutaría y cuándo se reinicia cada ventana. Se refresca al volver a la pestaña sin gastar
  cuota, porque el TTL vive en el servidor. OpenCode no publica cuota y por eso ni se le pregunta.

- **Los avisos de la consola se pueden vaciar y dicen la verdad**: el contador de «requieren
  atención» tiene ahora un «visto» por trabajo y otro para todos, así que deja de arrastrar fallos
  de hace días; junto a Terminal hay un aviso de cuántas hay abiertas, que se mueve en el momento
  al abrir o cerrar una; y la limpieza de spools —que estaba declarada en Salud pero no existía—
  se ejecuta al arrancar y cada seis horas, con lo que las comprobaciones pasan de 9/10 a 10/10.

- **El Assistant, encendido**: delegas un objetivo y el coordinador lo parte en pasos que son
  trabajo real en la máquina —con su motivo, su destino y su permiso a la vista—, pide permiso
  antes de lo que tenga efectos, y cierra con una síntesis que cita los trabajos por su id y
  ofrece qué hacer a continuación. Habla tanto con la API de Anthropic como con cualquier
  endpoint compatible con OpenAI, que es lo que permite usar la credencial que ya hubiera.

- **Empezar una sesión desde cero**: se elige agente, máquina y carpeta, y si se quiere mandar un
  trabajo o abrir una terminal viva. La conversación se estrena desde la consola en vez de tener
  que ir a la máquina a crearla y esperar a que el índice la vea.

- **El historial deja de crecer para siempre**: lo que pesa de un trabajo viejo no es su historia
  —quién lo lanzó, dónde y cómo acabó— sino las salidas de herramienta y los volcados crudos. A
  los 7 días se sustituyen por su huella y un resumen de una línea; a los 30 queda el esqueleto
  del trabajo. Nada desaparece en silencio: un evento compactado dice que lo está y cuánto
  ocupaba, y su número de orden sigue siendo el suyo, así que un enlace a un evento concreto
  nunca apunta a otro. `/api/health` enseña cuándo fue la última limpieza y cuánto liberó.

- **Una conversación ya no se pierde porque nadie sepa en qué carpeta vive**: Claude Code archiva
  por directorio, así que reanudarla desde otro sitio responde «No conversation found with session
  ID» —que suena a sesión borrada cuando lo único que pasa es que se está mirando donde no es—. El
  core deduce ahora el directorio del nombre con que Claude guardó el proyecto y lo **confirma
  contra la máquina** antes de usarlo; el workspace se queda con él marcado como deducción, para
  que la consola pueda decir que eso lo dedujo el sistema en vez de presentarlo como un hecho. De
  paso se comprueba también el directorio que declaraba el índice: uno que se movió o se borró
  hacía morir el trabajo con un `cd` fallido. Y si aun así no se encuentra, el error explica que el
  problema es el directorio y no la sesión.

### Corregido durante la migración

Fallos reales encontrados al probar contra tmux y procesos de verdad, no al leer el código:

- una línea de salida más grande que el trozo de lectura dejaba el run **bloqueado para siempre**;
  ahora la lectura crece hasta un tope y, si se supera, se anota y se sigue;
- una cancelación no se confirmaba nunca si al wrapper lo mataban antes de publicar su estado;
  ahora una tmux ausente cuenta como «parado», que es lo que de verdad significa;
- cerrar el socket de la terminal se llevaba por delante la sesión tmux; ahora se pide un detach
  limpio antes de soltar el ssh;
- el gateway consumía el cuerpo de las peticiones antes de reenviarlas y el core se quedaba
  esperando bytes que nadie iba a mandar;
- un fallo anterior al primer evento (un `cwd` que no existe, un binario que falta) se reportaba
  como «salió con código 2»; ahora el core adjunta la cola de `stderr` y dice qué pasó;
- lo que contestaba una persona a una pregunta del Assistant no llegaba al modelo: el plan
  continuaba, pero sin haber leído la respuesta. Ahora viaja en el contexto del paso siguiente y
  queda en el historial del plan;
- un chip con un valor largo —una lista de herramientas, un `cwd` hondo— se salía de su tarjeta y
  además impedía que los de al lado se encogieran: en un contenedor flex nada baja de su contenido
  sin `min-width: 0`, y sin eso el recorte con puntos suspensivos no llega a aplicarse nunca;
- en el teléfono, los botones que sólo enseñan icono se quedaban sin nombre para un lector de
  pantalla: «Salir» era «botón». El texto se escondía de la vista y del árbol accesible a la vez;
- los distintivos de estado perdían contraste según lo que tuvieran detrás —dentro de una fila
  seleccionada, el verde de «terminado» caía a 4.1:1—, porque el fondo teñido era transparente;
- abrir una terminal no refrescaba la lista de sesiones: la pantalla decía «ninguna sesión abierta»
  con la sesión ya creada al otro lado;
- el selector de máquina marcaba «(sin tmux)» y deshabilitaba hosts que sólo estaban **sin
  comprobar**, cuando conectarse funcionaba;
- dos avances simultáneos de un plan proponían el mismo paso dos veces —el plan acababa con un
  paso que nadie pidió y una llamada al modelo de más—; ahora los turnos de un plan se serializan
  y la base lo sostiene con un índice único por posición;
- **volver a abrir una sesión desde el explorador deshacía el nombre puesto a mano.** El explorador
  manda el título del índice en cada apertura y la reapertura no miraba de dónde venía el título:
  la misma regresión del stack viejo, entrando por otra puerta. La ruta de trabajo sí se sigue
  refrescando al reabrir, que es lo que se quiere;
- la cabecera decía «40 mensajes» de una sesión de trescientos: contaba los de la página traída,
  no los de la sesión. Ahora enseña el total que conoce el índice y dice cuándo se están viendo
  sólo los últimos;
- un sondeo de cuenta que no traía ni cuenta ni cuotas se guardaba como snapshot bueno y dejaba un
  hueco silencioso durante cinco minutos. Ahora eso es un error con su motivo, y el sondeo a medias
  de un Claude recién instalado —el que enseña la bienvenida antes de `/usage`— se reintenta una
  vez saltándose el TTL, como hacía el stack anterior.

### Probado contra máquinas de verdad (2026-09-02)

Primera campaña fuera del laboratorio: el stack entero —índice, core, gateway y consola— contra
**zeus**, **goro2** y **vultr**, con las CLIs instaladas allí y las cuentas reales. Lo que
funcionó: detección de capacidades por máquina, trabajo durable con Claude y con Codex, estrategia
nativa en el tercer servidor, cancelación confirmada en cuatro segundos, terminal tmux viva,
cuenta y cuota reales en la cabecera, y un host inalcanzable que deja el resto de la consola
usable en vez de tumbarla.

Lo que sólo se ve saliendo del laboratorio, y ya está corregido: el spool por defecto hacía
imposible lanzar cualquier trabajo; un resultado de Codex se perdía por un cambio de su CLI; los
eventos nuevos de Claude Code se leían como un fallo; los errores llegaban con el color de
terminal dentro; y la frescura del índice contaba el bastión dos veces.

### Decidido

Siete ADR: límite de privilegio entre gateway y core, SQLite en un nodo con umbrales medidos para
PostgreSQL, runner remoto con tmux y spool, un transporte por necesidad, identidad de sesión y
workspace, compatibilidad de passkeys sin re-enrolamiento, y política de retención y redacción.

### Aplazado a propósito

Marketplace de mods, ejecución de JS/Python desde el contenido, filesystem virtual en el
navegador, proveedores de chat genéricos y modo cliente-only. No vuelven por nostalgia: cada uno
tendría que declarar entidad, destino, permiso, estados de fallo y comportamiento móvil.
