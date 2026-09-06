# ADR-010 · La autonomía es una escalera, y el peldaño lo marca el efecto fuera de Jarvis

Fecha: 2026-09-05 · Estado: propuesto · Amplía a
[ADR-009](0009-local-brain-and-mcp-client.md) y a [ADR-001](0001-gateway-core-privilege-boundary.md)

## Contexto

ADR-009 §5 dejó dicho que la autonomía la elige quien escribe, con dos modos —`manual` y `auto`— y
una lista de excepciones que no se apagan desde la interfaz. Al construir encima aparecieron tres
cosas que ese ADR no había tenido que responder.

**El contrato prometía una cosa y el código hacía otra.** `packages/contracts/src/chat.ts` dice que
en `auto` se siguen preguntando «los perfiles `auto` y `yolo`», y `#createRun` sólo convierte la
decisión en aprobación cuando el modo es `manual`. Es decir: hoy, en automático, el asistente lanza
un trabajo que **escribe ficheros en una máquina** sin que nadie firme una tarjeta.

**La autonomía no existía en los planes.** El toolbox se construye en dos sitios —la conversación y
el motor de planes— y el segundo no pasa `autonomy`. Con el valor por defecto `'auto'`, dentro de un
plan la rama de aprobación no se toma nunca. No era un descuido de tecleo: era **la ausencia de una
decisión**. Nadie había contestado qué significa la autonomía cuando no hay nadie escribiendo en
cada turno.

**Y hacía falta un tercer peldaño.** El encargo pedía un modo «sin restricciones» para trabajo
sostenido, que es una petición razonable y que obliga a decir en voz alta qué es exactamente lo que
no se abre nunca.

Ese nombre, además, **ya está cogido**: «Sin restricciones» es la etiqueta visible del perfil de
permiso `yolo` (`ui/labels.ts`), con tono de peligro y la ayuda «Ejecuta cualquier cosa en la
máquina». Llamar igual al modo de autonomía haría que el mismo texto significara dos cosas
distintas en la misma pantalla, y precisamente las dos que este documento existe para no confundir:
**qué permiso lleva un trabajo** y **cuánta cuerda hay sin firma**. En la interfaz el tercer modo se
llama **«Sin preguntar»**, que nombra el eje. El valor del enum se queda en `unrestricted`, que es
contrato y no etiqueta.

Medido en producción el 2026-09-05, antes de tocar nada: `JARVIS_CHAT_DEFAULT_AUTONOMY=manual`, las
40 conversaciones existentes en `manual` —ninguna se ha cambiado nunca—, dos planes en toda la vida
del sistema, y los 16 trabajos con perfil de escritura lanzados por una persona. El agujero es real
y hoy no circula nadie por él; pero está **a un clic**, porque el segmento manual/automático es un
botón y el texto que hay debajo promete lo que el código no cumple.

## Decisión

### 1. El criterio: si el gesto tiene efecto fuera de Jarvis

La frontera de qué puede hacer el asistente por su cuenta **no es «leer contra escribir»** ni
«barato contra caro». Es si el gesto tiene efecto fuera de Jarvis.

Abrir un workspace lo hace el asistente: es una fila que dice «me interesa esta sesión», no entra en
ninguna máquina, y abrirla dos veces devuelve la misma. Abrir una terminal viva levanta una tmux en
un servidor, así que se **ofrece** y la abre una persona. Las dos son «escrituras» si se miran por
el otro eje, y por eso el otro eje no sirve.

Este criterio ordena el resto del documento y es lo que hay que aplicar a cada capacidad nueva.

Sirve además para lo que no es una herramienta. Un artifact HTML que el asistente entrega ejecuta
código en el navegador de quien lo lee, lo que suena a concesión grande y no lo es: comprobado en un
navegador real con contenido hostil dentro, embebido y abierto como pestaña con la cookie en el
contexto, el script corre y no alcanza nada —padre, cookie y `localStorage` dan `SecurityError`, y
ni un intento llega a la red—. El gesto se queda dentro, así que se puede conceder. Lo que decide no
es que ejecute código: es hasta dónde llega.

### 2. La escalera, con tres peldaños

| | `manual` | `auto` | `unrestricted` |
|---|---|---|---|
| leer (índice, transcript, salud, capacidad de sólo lectura) | directo | directo | directo |
| trabajo en perfil `safe` | tarjeta | directo | directo |
| trabajo en perfil `auto` (escribe ficheros) | tarjeta | **tarjeta** | directo |
| capacidad MCP con etiqueta de efecto | tarjeta | tarjeta | directo |
| capacidad MCP **sin etiqueta**, con efecto inferido | tarjeta | tarjeta | **tarjeta** |

La fila del perfil `auto` en modo `auto` es el arreglo: es lo que el contrato ya prometía.

### 3. Lo que no abre ningún modo

- **El perfil `yolo`.** Lo que aporta la ruta de `request_approval` no es el perfil: es la tarjeta,
  que enseña qué se va a ejecutar y caduca. Un modo que se salte la tarjeta se salta la única
  prueba de que alguien vio lo que iba a correr.
- **La salida a la nube.** No es peligro, es dinero y datos saliendo de casa: el contexto de un
  turno lleva transcripts, rutas y diffs. ADR-009 ya lo rechazó como automatismo y el motivo no
  cambia porque la persona ponga un modo más suelto.
- **`DEFAULT_DENIED_TOOLS`** (`mcp/config.ts`): apagar o reiniciar el bastión, e instalar paquetes
  en él. Su propio comentario lo dice: una aprobación es una tarjeta que se lee en diez segundos, y
  esto merece una terminal y una persona mirando. Es justo el gate que un motor de trabajo
  sostenido va a querer saltarse «sólo para reiniciar un servicio».
- **Un servidor MCP declarado de sólo lectura.** El modo relaja quién firma, no qué está enchufado.
- **Parar trabajo que lanzó una persona.** Eso no es privilegio, es propiedad.
- **Abrir terminales.** Se ofrece; la abre una persona. Es el criterio de §1 aplicado.
- **La frontera del gateway (ADR-001).** Un modo guardado en la base del core no puede tocar lo que
  aplica quien firma la identidad.

### 3-bis. Lo que se lleva por delante la supervisión, tampoco — y esto está sin resolver

Una tarjeta existe para que alguien vea qué se va a ejecutar. Una acción que destruye **el
mecanismo que enseña el resultado** deja la tarjeta sin efecto hacia atrás: da igual haber firmado
si nadie va a poder leer qué pasó. Así que un modo más suelto no debería poder abrir una acción que
apaga aquello con lo que se le vigila.

El caso concreto, comprobado en el servidor MCP de esta casa el 2026-09-06: `MCP_SERVICE_ALLOWLIST`
incluye `jarvis`, así que **`stop_service` y `restart_service` alcanzan al servicio que sostiene
todo esto**. En `unrestricted`, «para el servicio jarvis» se ejecutaría sin tarjeta y tumbaría el
stack entero. No es una hipótesis sobre el modelo: es lo que la configuración permite.

Otras dos que se miraron y **no** aplican, porque el dato las descarta: `docker_stop` no alcanza a
los contenedores de Jarvis —la allowlist es `{go2rtc, jarvis}` y la comprobación es pertenencia
exacta, no subcadena—, y `write_text_file` sólo escribe bajo `MCP_WRITE_ROOTS`
(`/opt/jarvis`, `/srv/jarvis`), donde el despliegue no vive. Las dos lo decían en su propio resumen
y nadie lo había leído.

**Queda sin resolver a propósito**, y el motivo es que la herramienta que hay no sirve:
`JARVIS_MCP_DENY` no distingue modos, así que denegar `stop_service` lo bloquearía también **con
tarjeta**, que es una operación legítima. Lo que haría falta es una lista distinta —«esto nunca va
sin firma, aunque el modo lo permita»— y el problema real es que la unidad sobre la que sabemos
razonar es la **herramienta** y el peligro está en el **argumento**: `restart_service nginx` es
rutina y `restart_service jarvis` es apagarse a uno mismo. Mientras el sobre no nombre capacidades
con sus argumentos, cualquier gate aquí es más grueso que el problema.

Se deja escrito en vez de resuelto porque quitarle a alguien una capacidad que acaba de conceder es
una decisión suya, no del que la implementa.

### 4. La capacidad sin etiquetar sigue pidiendo tarjeta, y es protección latente

`effectsOf` es fail-closed: una capacidad sin etiquetas en un servidor con escrituras se trata como
si tuviera efectos. `unrestricted` **no** levanta eso. Se relaja lo conocido, nunca lo desconocido.

Hay que escribir aquí que esto es **protección latente**, con esa palabra, porque medido contra el
MCP de esta casa el 2026-09-05: de las 112 herramientas que expone el servidor, 15 llevan etiqueta
de efecto, 97 de lectura y **ninguna se queda sin etiquetar**. O sea que esta regla no se va a ver
funcionar nunca con el catálogo actual, y dentro de un año alguien la va a querer quitar por «no
hace nada». Existe para el día que se enchufe un servidor que no etiquete, que es precisamente el
día en que nadie estará mirando.

### 5. El valor por defecto se quita, no se cambia

`autonomy` pasa a ser **obligatorio** en `CoreToolboxDeps`. No se cambia `?? 'auto'` por
`?? 'manual'`: se elimina el default, para que el compilador obligue a cada punto de construcción a
declarar postura. Eso cierra de paso la asimetría de los planes, que ganan `plans.autonomy`.

El motivo es de forma, no de gusto: el fallo original no fue elegir mal el default, fue que **no
había que elegir**. Un tipo que no admite ausencia convierte esa clase de omisión en un error de
compilación. Es la misma lección que otros dos fallos de la misma noche —comprobar si hay entrada
en vez de si hay dato, y un campo documentado de una manera e implementado de otra—: lo que no
obliga a decidir, se decide solo y mal.

### 6. `unrestricted` necesita un guardarraíl fuera de la interfaz

`JARVIS_ALLOW_UNRESTRICTED`, por defecto apagado, con tres efectos: la ruta rechaza el modo, la
interfaz no ofrece el segmento porque `ChatCapabilities` no lo lista, y si el flag se apaga con
conversaciones ya puestas en ese modo, el toolbox **degrada a `auto`** al leer el modo efectivo.

Una decisión que amplía lo que una máquina hace sola no puede vivir sólo detrás de un botón de la
pantalla.

## Consecuencias

- El asistente en `auto` deja de poder escribir en una máquina sin tarjeta. Es un cambio de
  conducta, y en una casa donde hoy nadie usa `auto` sale gratis; el día que se hubiera usado,
  habría salido caro.
- Los planes dejan de ser un carril sin autonomía. Un motor de trabajo sostenido hereda la escalera
  en vez de heredar un default.
- Aparece una tarjeta donde antes no había ninguna, en el caso concreto de `auto` + perfil `auto`.
  Quien tenía la promesa del contrato en la cabeza no notará el cambio; quien se había acostumbrado
  a lo que hacía el código, sí.
- El texto de la interfaz y el contrato se enmiendan **en el mismo commit** que el código. La
  promesa y lo que se cumple no pueden volver a separarse, que es de donde salió todo esto.

## Lo que se rechazó

**Firmar permisos por área del catálogo MCP.** La idea era que una tarjeta dijera «puede usar
capacidades de las áreas *disco* y *servicios*». Medido contra las 108 capacidades reales, no
aguanta: cinco de las once áreas mezclan lectura con destrucción —firmar `servicios` es firmar
`stop_service`, firmar `ficheros` es firmar `write_text_file`—, y hay herramientas cuyo área no
corresponde a lo que una persona esperaría, porque el área es *la primera etiqueta que casa* en una
lista ordenada a mano: `journal_query` está en `servicios`, así que una tarjeta para reiniciar un
servicio estaría firmando consultas arbitrarias al journal, autenticación incluida.

Y para un digest firmado hay algo peor: **los miembros de un área crecen después de firmar**. El
MCP de esta casa creció cuatro herramientas en una tarde, y `otras` es un cajón de sastre. Firmar un
área es firmar lo que aparezca mañana, lo que rompe la propiedad que hace que una aprobación valga.

Se firman **nombres**. Y no sale más largo: las capacidades con efecto que llegan al asistente son
once, mientras que sus cinco áreas contienen otras cuarenta y pico de lectura. El área se queda como
etiqueta descriptiva en la tarjeta —para que se lea «disco y servicios» y no doce nombres—; la
etiqueta explica y el digest manda.

**Cambiar el default a `'manual'`.** Habría tapado el síntoma dejando el hueco: el siguiente sitio
que construya un toolbox volvería a no decir nada y volvería a heredar una postura que nadie eligió.
