# La consola

Qué promete la interfaz y con qué reglas está hecha. No es una guía de uso —eso se ve usándola—
sino el sitio donde viven las decisiones que se tomaron una vez y no conviene volver a discutir
desde cero, con el porqué de cada una.

## El orden es el de los flujos, no el de las entidades

El carril lateral no lista secciones por lo que son sino por el orden en que se trabaja:

| | |
|---|---|
| **Inicio** | retomar: qué hay abierto, qué corre y qué pide algo de ti |
| **Asistente** | preguntar: a la casa, a las máquinas, o por dónde seguir |
| **Sesiones** | encontrar la conversación que existe en alguna máquina |
| **Trabajo** | vigilar lo que se mandó y cómo acabó |
| **Terminal** | intervenir a mano |
| **Salud** | diagnosticar cuando algo va raro |

Buscar es una consulta, no una navegación: filtrar en Sesiones no cambia el workspace activo.
Abrir una sesión es lo único que cambia de contexto, y es atómico.

## El Asistente enseña su trabajo

Va segundo en el carril, justo después de Inicio, porque es por donde se empieza a preguntar
cuando no se sabe todavía qué se está buscando. Antes esto vivía dentro de un workspace y sólo
servía si ya habías elegido una sesión, que es pedirle el contexto a quien viene a preguntar
precisamente por eso.

Tres decisiones que gobiernan la pantalla:

**Cada consulta se ve, con su nombre real.** Cuando el asistente mira la memoria del servidor, en
el hilo aparece `zeus.memory_pressure` y se puede desplegar para ver qué devolvió. Un asistente
que consulta seis cosas y contesta una frase sin enseñar de dónde sale es indistinguible de uno
que se lo inventa. Va plegado porque el hilo lo lee una persona y un volcado de JSON entre dos
frases lo rompe.

**De dónde salió cada respuesta, en la burbuja.** «Casa» o «nube», con forma propia y no sólo
color. Es la pregunta que alguien se hace sobre una respuesta concreta —¿esto ha costado dinero?—
y no sobre la conversación entera, así que va en cada una y no en una leyenda.

**Cuánta cuerda tiene, donde se está usando.** El selector Manual/Automático está en la cabecera
del hilo y no enterrado en unos ajustes: es la decisión que más cambia lo que va a pasar a
continuación. En manual, hasta lanzar un trabajo en modo seguro pasa por una tarjeta. Lo que
`auto` **no** suelta nunca —tocar una máquina, escribir, parar trabajo humano, salir a la nube—
no se puede apagar desde aquí, porque eso separa «que trabaje solo» de «que decida solo».

Las tarjetas de permiso van dentro del hilo, con el nombre exacto de la capacidad y sus argumentos
sin recortar. Entre lo que se lee y lo que se ejecuta no cabe un cambio: el digest lo garantiza.

## Sesión y trabajo no son lo mismo

Es la confusión más frecuente y por eso está explicada dentro de la propia pantalla de Trabajo.

Una **sesión** vive en la máquina: la crea el agente —Claude, Codex, OpenCode— la primera vez que
alguien le habla, sigue existiendo aunque Jarvis esté apagado, y se puede continuar desde la
terminal sin pasar por aquí.

Un **trabajo** es una ejecución lanzada desde Jarvis sobre una de esas sesiones: tiene destino,
permiso, línea de eventos y resultado. Vive en Jarvis, y es lo que se puede parar, reintentar y
auditar. Una sesión puede tener muchos trabajos; un trabajo pertenece siempre a una sesión.

## Lo que el producto promete antes de pulsar

- **El destino y el permiso se ven antes de Send.** Mandar trabajo a la máquina equivocada es el
  error caro de este producto; que la etiqueta y la ejecución digan lo mismo es media defensa, y la
  otra media es que se vea.
- **El permiso se dice en castellano y por lo que puede hacer**: «sólo lectura», «puede editar»,
  «sin restricciones». Nunca por el nombre de la bandera de la CLI.
- **El borrador no se pierde** por navegar, fallar ni recargar, y sólo se borra cuando el servidor
  confirma que el trabajo existe.
- **Lo que escribió el agente remoto y lo que hizo Jarvis nunca se mezclan** sin decirlo.

## Reglas de la interfaz

Cada una salió de un fallo concreto. Están aquí para que no se deshagan por parecer mejoras.

**El JSON no se enseña si se puede contar.** Un evento del agente que sabemos interpretar se cuenta
en una línea; uno que es un objeto plano se pinta como chips de campo y valor; el volcado crudo
queda a un clic. Un tipo de evento nuevo no puede romper la pantalla ni obligar a leer llaves.

**Lo repetido se cuenta una vez.** Los eventos idénticos y consecutivos se agrupan con su `×N` y su
rango de horas. Lo distinto no se junta nunca, aunque llegue seguido: dos respuestas son dos cosas
que el agente dijo, y fundirlas escondería información.

**Dónde contestó la IA se ve sin buscarlo.** La respuesta del agente pesa más que el resto —tipografía
de lectura, banda violeta, aire— y la línea de tiempo permite aislar sólo las respuestas. Es el
único sitio con ese realce: si todo destaca, no destaca nada.

**Un estado se distingue por forma, no sólo por color.** Todos los distintivos llevan icono además
de color, para que «terminado» y «falló» se diferencien sin ver bien el verde y el rojo.

**Un vacío dice qué hacer.** «No hay nada» es media información; la otra media es si eso es normal
y qué falta para que deje de estarlo. Una lista de sesiones vacía distingue tres cosas que se veían
igual: el índice aún no ha barrido, barrió y no encontró nada, o los filtros no dejan pasar nada.

**Un error ofrece la siguiente acción**: reintentar, ver qué salto falla, o copiar el diagnóstico
—código, mensaje, petición y hora, sin prompts ni salida del agente— para pedir ayuda sin
transcribir nada a mano.

**Un esqueleto de carga tiene la forma de lo que viene**, para que la página no salte al llegar.

**Se ofrece lo que funciona en vez de avisar de lo que va a fallar.** Una sesión que el agente no
puede reanudar no enseña el compositor: enseña «empezar una conversación aquí», con la máquina y la
carpeta ya puestas. Un aviso que dice «esto va a fallar» y aun así deja pulsar Enviar es una trampa
con un cartel.

**Lo que no se ha comprobado no se afirma.** Un host sin sondear no se marca «sin tmux»; un
contador que aún no se ha calculado no se pinta como cero; una carpeta deducida se marca «deducida».

**`aria-live` anuncia transiciones, no tokens.** Se anuncia que el trabajo terminó o que un plan
pide permiso; jamás el texto que el agente va escribiendo, que se leería palabra a palabra.

## Accesibilidad

Comprobada con axe (WCAG 2.1 AA) en las seis pantallas y las cuatro pestañas del workspace, en los
dos temas y en escritorio y teléfono: [`tests/e2e/a11y.spec.ts`](../tests/e2e/a11y.spec.ts).

- «Saltar al contenido» es el primer paso del tabulador;
- el foco se ve siempre, con una sola regla y no una por componente;
- 44 px de objetivo táctil cuando se navega con el dedo, decidido por tipo de puntero y no por
  ancho de pantalla;
- los distintivos se componen contra la tarjeta y no contra lo que haya detrás, para que su
  contraste no dependa de dónde estén;
- con el teclado virtual abierto, la terminal encoge y sus teclas siguen alcanzables.

Al medir contraste desde `getComputedStyle`, ojo: `color-mix()` se computa como `color(srgb r g b)`
con componentes de 0 a 1, no como `rgb()` de 0 a 255. Leerlo mal suspende colores que sí cumplen.

## Nombres

El título de un workspace se arregla **al entrar**, no sólo al terminar un trabajo. Sólo se
renombra lo que no sirve —hashes, el `<environment_context>` que arrastra Codex, rutas, vacíos— y
un título escrito por una persona gana siempre. Hay ventana de frescura para que entrar dos veces
no cueste dos llamadas al modelo ni cambie el nombre mientras lo miras.

Los trabajos se titulan con el mensaje que se envió, no con su identificador: `rt40nhvqeujq` no le
dice nada a nadie. El identificador queda debajo, que es donde hace falta al citarlo.

## Dónde está cada cosa

```
apps/web/src/app.tsx          el armazón: carril, cabecera, barra de estado, anuncios
apps/web/src/screens/         una pantalla por destino del carril, más el workspace
apps/web/src/ui/              piezas compartidas
  bits.tsx                    vacíos, cargas y errores, con sus tres reglas
  primitives.tsx              tarjeta, métrica, pestañas, segmentado, confirmación
  event-log.tsx               la línea de tiempo de un trabajo y el detalle en crudo
  icons.tsx                   un icono por concepto, en un solo sitio
  labels.ts                   el vocabulario del producto, en un solo sitio
  charts.tsx                  gráficos a mano; el porqué de no traer una librería
  new-session.tsx             estrenar una sesión desde cero
  announce.tsx               la única región `aria-live` de la aplicación
apps/web/src/api/queries.ts   TanStack Query: los datos del servidor, sin store global
apps/web/src/api/chat-stream.ts  el hilo del asistente en directo, con el mismo contrato SSE
```

Las librerías de interfaz que entran y las que se descartaron, con su coste en bundle, están en
[ADR-008](adr/0008-ui-libraries.md).
