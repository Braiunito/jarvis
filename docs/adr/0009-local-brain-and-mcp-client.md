# ADR-009 · El cerebro vive en casa; MCP también se consume, detrás de un caso de uso

Fecha: 2026-09-04 · Estado: aceptado, **con dos enmiendas del 2026-09-05** · Amplía a
[ADR-004](0004-rest-sse-ws-mcp.md)

> ## Enmienda · 2026-09-05 · el primer escalón deja de vivir en casa
>
> **Lo que cambia**: el modelo local se retira y su sitio lo ocupa `gpt-5-nano`. **Lo que no
> cambia**: absolutamente todo lo demás —dos escalones, escalada con permiso, aprobaciones,
> autonomía, cliente MCP, router—. Por eso esto es una enmienda y no un ADR nuevo: la estructura
> que decidió este documento resultó ser la buena; lo que falló fue el modelo que se puso dentro.
>
> **Por qué**: un Qwen3 de 1,7B tardaba entre dos y seis minutos por pregunta y se equivocaba al
> contar los números que acababa de leer (era el IA-02 del backlog). `gpt-5-nano` contesta lo mismo
> en **ocho segundos** por unas **dos diezmilésimas de dólar**, con 400.000 de contexto. La
> intuición de que un modelo local sería más barato era cierta en dinero y falsa en todo lo demás.
>
> **Lo que la enmienda enseña sobre el diseño**: que era el correcto. Cambiar de cerebro fueron
> cinco variables de entorno y ningún cambio en el motor de conversación, en las aprobaciones ni en
> el MCP. Un diseño que sobrevive a que su premisa central se caiga es lo que se quería.
>
> **Y una cosa que sí mejoró con el modelo nuevo**: el catálogo MCP se le da como **herramientas
> propias** en vez de detrás del router. La API sólo acepta los nombres que se le declararon, así
> que el modelo ya no puede inventarse una capacidad: esa clase de fallo desaparece en vez de
> gestionarse. El router sigue ahí y entra solo cuando el catálogo pasa de 128 funciones, que es
> donde la API contesta 400.
>
> Los nombres `local` y `cloud` se quedan en el código y en la base por compatibilidad, pero ya no
> significan dónde vive el modelo: significan **qué escalón es**. La interfaz dejó de decir «casa»
> y «nube» y dice el nombre del modelo, porque lo otro era mentira en cada mensaje.

> ## Enmienda · 2026-09-05 · encontrar algo no es poder tocarlo
>
> La primera conversación de trabajo de verdad —ocho preguntas, veinticinco consultas— dejó ver un
> agujero que ninguna prueba veía, porque no era un fallo: era una ausencia. El asistente encontraba
> las cosas y no podía hacer nada con ellas.
>
> | Lo que pasó | Por qué |
> |---|---|
> | «no me resumiste de qué trataba, sólo dónde está» | Nunca leyó el transcript: `get_session_context` sólo se ofrecía dentro de un workspace. Resumió el **título** y lo llamó contenido. |
> | «¿me lo abres?» → sólo lo describe | No existía la herramienta, y la oferta de terminal **ni se guardaba**: el getter que la recogía era código muerto. |
> | **doce de veinticinco consultas fueron repeticiones exactas** | El memo vivía dentro del router de capacidades y no cubría ninguna herramienta propia. |
>
> **Lo que cambia**: las herramientas de sesión aceptan cualquier sesión encontrada, no sólo la del
> workspace; el memo sube a `invoke()` y se comprueba **antes** del presupuesto, porque repetir una
> pregunta no debe costar una consulta; y un mensaje puede llevar **referencias** —`ChatRef`— que la
> pantalla pinta como botones.
>
> **Lo que no cambia, y es lo que se estaba decidiendo de verdad**: quién puede hacer qué. Abrir un
> workspace lo hace el asistente porque un workspace es una fila que dice «me interesa esta sesión»:
> no entra en ninguna máquina, no ejecuta nada, y abrirlo dos veces devuelve el mismo. Una terminal
> viva levanta una tmux en un servidor, así que se **ofrece** y la abre una persona. La frontera no
> es «leer contra escribir» ni «barato contra caro»: es si el gesto tiene efecto fuera de Jarvis.
>
> **Una repetición cortada no se escribe en el hilo.** Una fila de herramienta afirma «miré esto», y
> el memo la paró antes de mirar nada. Se cuenta aparte, en `toolbox.repeats`, que es lo único que
> distingue haber arreglado el bucle de haberlo escondido.
>
> Eso obliga a cambiar la cifra con la que se mide el arreglo: **consultas totales** —veinticinco en
> la conversación que falló—, y no consultas repetidas. Contar las repetidas en la base daría cero
> aunque el memo estuviera roto, porque la fila que las delataba ya no se escribe. Una métrica que
> sólo puede salir bien no mide nada.
>
> **El contexto crece donde es gratis y no donde tuerce.** Van en el prompt las sesiones ya
> encontradas en el hilo —reconstruidas de las referencias guardadas, que son datos tipados, no del
> eco recortado de las herramientas— y lo que hay abierto y corriendo, dos consultas a SQLite. **No
> va la salud**: lo que hay abierto son sustantivos, un salto en rojo es un problema, y poner un
> problema delante convierte un «Hola» en un diagnóstico. Ya se midió una vez, tres de tres.
>
> **El tope de 128 funciones dejó de ser folclore.** Con 108 capacidades enchufadas quedan tres
> huecos, y el repliegue al router es silencioso: cuatro herramientas nuevas en el MCP cambian el
> modo de todas las conversaciones sin que nadie toque Jarvis. Ahora la cuenta vive en una sola
> función y el modo se sirve en `/api/chat` (`capabilityMode`, `capabilityRoom`), porque una
> degradación que sólo se nota en la latencia no se nota.

## Contexto

El Assistant pensaba en una API de pago. Funcionaba, y cada turno costaba dinero: coordinar, poner
título, contestar «¿está bien el servidor?». En el bastión, mientras tanto, corría un
`llama-server` con Qwen3-1.7B sin que Jarvis lo mirara, y un servidor MCP con 108 herramientas de
diagnóstico del que el runbook decía, literalmente, que no se consumía **y que era una decisión**.

Esa decisión se apoyaba en ADR-004: MCP es un adaptador para modelos externos —Jarvis lo expone,
no lo llama— y una herramienta del toolbox llama a un caso de uso del core, nunca a una API HTTP.
Las dos reglas siguen siendo buenas. Lo que hacía falta era ver que **prohibían dos cosas
distintas** y sólo una merecía seguir prohibida.

## Decisión

### 1. El core puede ser cliente MCP, y sólo a través de un caso de uso

Se añade el vertical `mcp/`: un cliente de Streamable HTTP y un `McpService` que decide qué
existe, qué se ejecuta, con qué identidad, cuánto se devuelve y qué queda en la auditoría.

La regla del toolbox **no se relaja**: una herramienta sigue sin poder llamar a una API HTTP. Lo
que cambia es que ahora hay un caso de uso del core al que llamar, con su allowlist, su salud y su
registro. La diferencia entre esto y «el modelo tiene un puerto» es exactamente esa capa.

ADR-004 sigue vigente en lo suyo: el navegador nunca habla MCP y ninguna pantalla depende de que
un servidor MCP esté vivo.

### 2. Se piensa en casa; salir fuera se firma

`HybridModel` compone dos cerebros. El local trabaja. Cuando se queda corto **lo dice y espera**:
devuelve una decisión `escalate` que el core convierte en una aprobación con su digest y su
caducidad, igual que las que ya gobiernan los efectos sobre una máquina.

No se escala solo ni cuando el modelo local se cae. Un `llama-server` reiniciándose no es permiso
para gastar en la nube.

El permiso vale **para un turno**. En un plan se guarda el ordinal del paso autorizado
(`plans.escalate_for_step`), no un booleano: un `escalated = 1` se queda encendido para siempre y
convierte una autorización puntual en una suscripción.

### 3. El catálogo se navega, no se enseña

El catálogo completo del MCP de Zeus son **8294 tokens** medidos con el `/tokenize` del propio
`llama-server`. El modelo local arrancó con 4096 de contexto. No es que convenga resumir: es que
no cabe, y el índice que casi cabe —2824 tokens de nombres y primeras líneas— dejaría al modelo
sin sitio para pensar.

Por eso se le ofrecen tres herramientas en lugar de ciento y pico: `list_capabilities` (áreas, o
las de un área), `search_capabilities` (busca y devuelve con esquema) y `use_capability`
(ejecuta). Con un lote de arranque de cinco capacidades —581 tokens— el presupuesto sale a unos
1000, que entra incluso en 4096.

Medido contra el servidor de casa, el coste de enseñarle más herramientas no crece en línea recta:

| herramientas ofrecidas | tokens | acierta | tiempo en elegir |
|---|---|---|---|
| 5 | ~500 | sí | 10,6 s |
| 10 | ~760 | sí | 26,0 s |
| 20 | ~1260 | sí | 36,2 s |
| 40 | ~2525 | sí | 187,0 s |

El límite no es la precisión —con 40 sigue eligiendo bien— sino el reloj: de 10 a 40 la espera se
multiplica por siete. Por encima de una decena de herramientas ofrecidas a la vez, la conversación
deja de ser usable. De ahí que los lotes sean de ocho o diez.

Y dentro de un turno, el tiempo no se va donde parece. De 32 s de media: 11,6 s en elegir, **1,1 s
en ejecutar** y 22,7 s en redactar, porque ese último turno lleva el resultado entero en el
contexto. La palanca de la experiencia no es el modelo ni el prompt: es **acotar lo que se le
devuelve**, y por eso el tope por defecto son 1800 caracteres y no los 6000 que había al principio.

Corolario que se paga solo: **descripción corta para elegir, descripción completa para usar**. El
párrafo de `gpu_status` que explica cómo distinguir un transcode por VAAPI de uno por software es
ruinoso multiplicado por 108 y es lo más valioso del catálogo cuando ya se eligió esa herramienta.

### 4. Una conversación no es un plan

Se añade el vertical `chat/`. Comparte modelo, herramientas, aprobaciones y auditoría con los
planes, y se diferencia en dos cosas: puede no tener workspace —preguntar por el servidor no exige
haber abierto una sesión de agente— y sabe ejecutar una capacidad con efectos tras aprobarla,
que es algo que el motor de planes no sabe hacer porque sólo sabe lanzar runs.

Por eso en un plan el MCP es de **sólo lectura**. Ofrecer allí una aprobación que después nadie
puede cumplir sería una promesa rota con pasos de por medio.

### 5. La autonomía la elige quien escribe

`manual` pregunta antes de cualquier efecto, incluido lanzar un trabajo en perfil seguro; `auto`
suelta sólo eso. Lo que **no** se puede apagar desde la interfaz: escribir en una máquina, los
perfiles `auto` y `yolo`, parar trabajo que lanzó una persona, y salir a la nube.

Va en la conversación y no en la configuración del servidor porque la misma casa quiere un
asistente suelto para diagnosticar y otro atado para tocar producción, y quien sabe cuál toca es
quien está escribiendo.

### 6. Lo que no se sirve jamás

`reboot_server`, `poweroff_server`, `apt_install` y `apt_update_cache` se deniegan de fábrica y
las denegaciones del operador se **suman** a ésas, no las sustituyen. Ninguna aprobación las abre
desde una conversación: una tarjeta se lee en diez segundos y eso merece una terminal y una
persona mirando.

Un servidor es de sólo lectura salvo que se le nombre en `JARVIS_MCP_WRITE_SERVERS`. Y si una
herramienta no dice qué es, se trata como si escribiera: el MCP de Zeus etiqueta `reboot_server`
como `admin` y **no** como `write`, así que un clasificador que sólo mirase `write` daría por
inofensivo apagar el servidor.

## Lo que un modelo pequeño hace mal, y en qué capa se arregla

Salió del primer turno en producción, donde **cinco de ocho llamadas a herramienta fallaron**. No
son fallos aleatorios: cada uno tiene una forma reconocible y un sitio donde arreglarlo. El sitio
nunca es el prompt.

| Lo que hace | Ejemplo real | Dónde se arregla |
|---|---|---|
| Trunca lo que genera | `arguments: "{"` | se sanea a `{}` en el adaptador del modelo |
| Inventa argumentos por analogía | `seconds: 60` a una tool sin parámetros | se ajustan al `inputSchema` antes de llamar |
| Manda un valor fuera de rango | `cpu_sampled(seconds=60)`, tope 30 | el servidor acota y **devuelve el valor efectivo** |
| Se inventa el nombre de una capacidad | `zeus.processes` | se le contestan las tres que más se parecen |
| Escribe el aspecto de una llamada | `<finish>`, `summary:` como prosa | se limpia antes de enseñarlo |

Tres cosas que esta tabla enseña y que valen más que la tabla:

**El prompt no es una capa de defensa.** Al modelo ya se le decía `[sin parámetros]` en el catálogo
de las herramientas a las que luego les inventó argumentos. Lo tenía delante. Decírselo mejor no lo
arregla; quitarle la ocasión, sí. Cada vez que la respuesta a un fallo sea «se lo explicamos en el
system prompt», la respuesta es otra.

**Un tope existe para proteger la máquina, no para dar lecciones a quien llama.** Rechazar
`seconds=60` porque el máximo es 30 pierde la vuelta entera; acotar a 30 y **decir con qué se
midió** conserva la respuesta y no engaña. Vale para cualquier validación de esta frontera.

**Nada se altera en silencio.** Un argumento que se quita se reporta (`ignoredArgs`), un resultado
que se recorta dice cuánto ocupaba, un valor acotado devuelve el efectivo. La regla de ADR-007
—recortar diciéndolo— resulta que no era sólo sobre tamaño: un modelo al que se le cambia la
pregunta sin avisar concluye con seguridad sobre una consulta que no hizo.

## Consecuencias

- El coste por turno de lo habitual —diagnosticar, buscar, resumir— baja a cero. Lo que se paga
  es lo que alguien decidió pagar.
- El asistente sabe cosas que antes no podía saber: el estado del host, los contenedores, la
  iGPU, las cámaras. Sin salir de casa.
- Aparece una dependencia nueva y hay que verla cuando falle: cada servidor MCP es un salto en
  Salud, con su `stale` y su último error.
- Un catálogo viejo sigue sirviendo si se dice que es viejo; un servidor caído no vacía los demás.
- Hay dos prompts de sistema. El del modelo local es corto y en imperativo a propósito: los 450
  tokens de matices del otro, en un 1,7B, ocupan el sitio que necesita para razonar.
- Se guarda de qué cerebro salió **cada mensaje**, no cada conversación: un hilo puede empezar en
  casa, escalar un turno y volver.

## Lo que se rechazó

**Escalar automáticamente al fallar.** Es lo cómodo y convierte al asistente en un grifo abierto
que nadie ve correr hasta que llega el recibo. Además, el contexto de un turno lleva transcripts,
rutas y diffs: que eso cruce la puerta es una decisión, no un detalle de enrutado.

**Meter las 108 herramientas y subir el contexto hasta que quepan.** Se midió: a 16384 el catálogo
entra, ocupando la mitad del contexto. Comerse la mitad del contexto en un índice que el modelo
casi nunca necesita entero es pagar en cada turno por lo que se usa en uno de cada diez.

**Usar el MCP de aiSessions para buscar sesiones.** El core ya lo hace de forma nativa contra el
índice, por sus casos de uso, con auditoría y atado al workspace. Enchufarlo además por MCP sería
un segundo camino peor para lo mismo.

**Un `ApprovalService` común.** La tarjeta se ve igual venga de un plan o de una conversación,
pero lo que ocurre al firmarla no es lo mismo. Se comparte la tabla y el digest; el efecto lo
ejecuta quien sabe ejecutarlo, y la ruta `/api/approvals/:id` despacha por el dueño.
