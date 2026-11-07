# La consola

Qué promete la interfaz y con qué reglas está hecha. No es una guía de uso —eso se ve usándola—
sino el sitio donde viven las decisiones que se tomaron una vez y no conviene volver a discutir
desde cero, con el porqué de cada una.

## Tres destinos, Sesiones es la portada, y Salud es el escudo

| | |
|---|---|
| **Sesiones** | retomar: las conversaciones de las máquinas, agrupadas por carpeta |
| **Trabajo** | vigilar lo que se mandó y cómo acabó |
| **Terminal** | intervenir a mano |
| **Salud** (el escudo de arriba) | diagnosticar cuando algo va raro; también la cuota y los datos del sistema |

Hubo una portada de cifras y una sección de Asistente. Se quitaron el 2026-11-07: la portada
repetía lo que ya dicen estas pantallas, y el asistente se usaba poco para lo que pesaba.

**Salud no está en el carril: se entra por el escudo de la cabecera**, y es la única entrada (ni
carril ni paleta; sólo un error de conexión enlaza a ella, porque es justo donde se diagnostica).
El escudo dice el estado de todo sin abrir nada: verde y callado con todo en orden; tachado si se
entra sin autenticación o por HTTP; con exclamación si algo falla. Antes eso estaba repartido en
tres sitios —el destino del carril, un chip de conexión insegura y un «Conectado» al pie del
carril— para una sola pregunta: ¿va todo bien?

En el teléfono el carril baja a una barra con **Sesiones en el centro**, entre Trabajo y Terminal:
es la portada y lo que más se toca, y el centro es donde cae el pulgar.

## Menos a la vista, un clic más

La regla del rediseño compacto: se enseña lo mínimo para reconocer algo y el resto está a un clic.

- **Sesiones se agrupan por dónde se ejecutaron**, con el nombre corto de la carpeta —`jarvis`, no
  `/var/www/jarvis`—. Se agrupa por el nombre y no por la ruta: `jarvis` en zeus y en goro1 es el
  mismo proyecto para quien mira. La ruta completa aparece al abrir el grupo y al pulsar la sesión.
  Grupos y sesiones van por lo último que se movió. El grupo abierto vive en la URL (`?g=`).
- **Una sesión es un hilo de turnos plegados.** Un turno es lo que pediste y lo que hizo el agente
  hasta contestar; plegado se lee en dos líneas —lo que pediste, lo último que contestó— y el
  último viene abierto. Desplegado es el turno entero, con el proceso en tarjetas compactas que
  también se despliegan.
- **Transcript y trabajos van en el mismo hilo**, sin repetirse: un trabajo lanzado desde Jarvis
  también acaba en el transcript de la máquina, y cuando un turno es el de un trabajo gana el
  trabajo, que dice lo mismo y además trae el proceso (`ui/turns.ts`).
- **Lo que se consulta de vez en cuando va plegado**: los detalles de una sesión, lo que va bien en
  Salud, el «dónde y cómo» de un trabajo.
- **Cada respuesta del agente se copia de un clic**, con el Markdown tal cual: en su esquina dentro
  del hilo, y en la tarjeta plegada la última, sin abrirla. Si el core sólo guardó el principio de
  una respuesta larga (4000 caracteres), la tarjeta plegada no lo ofrece: se copia desde dentro,
  donde está entera.

## Sesión y trabajo no son lo mismo

Es la confusión más frecuente.

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
de lectura, banda violeta— y se lee entera, con su markdown. El resultado con el que Claude cierra
un turno repite su último mensaje; cuando es idéntico se queda en su línea —«terminado · 3 turnos»—
y el texto se lee una vez.

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

**`aria-live` anuncia transiciones, no tokens.** Se anuncia que el trabajo terminó; jamás el texto
que el agente va escribiendo, que se leería palabra a palabra.

## Accesibilidad

Comprobada con axe (WCAG 2.1 AA) en las cuatro pantallas, con un grupo abierto y con un hilo
plegado, desplegado y con sus detalles, en los dos temas y en escritorio y teléfono: [`tests/e2e/a11y.spec.ts`](../tests/e2e/a11y.spec.ts).

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
apps/web/src/app.tsx          el armazón: carril, cabecera, anuncios
apps/web/src/screens/         una pantalla por destino del carril, más el workspace
apps/web/src/ui/              piezas compartidas
  bits.tsx                    vacíos, cargas y errores, con sus tres reglas
  primitives.tsx              tarjeta, segmentado, confirmación
  event-log.tsx               la línea de tiempo de un trabajo y el detalle en crudo
  turns.ts                    el hilo de una sesión en turnos: transcript y trabajos, sin repetir
  markdown.tsx                las respuestas del agente con formato, sin HTML crudo
  icons.tsx                   un icono por concepto, en un solo sitio
  labels.ts                   el vocabulario del producto, en un solo sitio
  charts.tsx                  el medidor de la cuota
  new-session.tsx             estrenar una sesión desde cero
  announce.tsx               la única región `aria-live` de la aplicación
apps/web/src/api/queries.ts   TanStack Query: los datos del servidor, sin store global
apps/web/src/api/run-stream.ts   los eventos de un trabajo en directo, por SSE
```

Las librerías de interfaz que entran y las que se descartaron, con su coste en bundle, están en
[ADR-008](adr/0008-ui-libraries.md).
