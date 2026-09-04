# Campaña real · 2026-09-04 · el asistente pasa a pensar en casa

Segunda salida del laboratorio, y la primera que cambia **quién piensa**. Hasta hoy el Assistant
razonaba en una API de pago; desde hoy razona en un `llama-server` del propio bastión y la nube es
el sitio al que se escala con permiso (ADR-009).

Lo que se prueba aquí no es que el modelo sea listo —eso no se prueba— sino que la cadena entera
funciona contra la infraestructura de verdad, y a qué velocidad.

## Cómo quedó montado

| Pieza | Cómo corre |
|---|---|
| modelo local | `llama-server` con `bartowski/Qwen_Qwen3-1.7B-GGUF:Q4_K_M`, ctx 16384, KV `q8_0`, `nice 5`, `CPUWeight=30` |
| su acceso | `0.0.0.0:8181` con `Authorization: Bearer`; la clave en `/home/zeus/llama-api.key` (600) |
| su arranque | unidad `llama-server.service`, `Restart=always`, sobrevive a reinicios |
| MCP de sistema | `Zeus System MCP 4.0.2` en `192.168.1.100:8765/mcp`, 108 herramientas |
| el core | contenedor `jarvis-next-core-1`, modo host-tls, commits `ef50771` y `5dda2a2` |

El modelo escucha en la LAN y no en loopback por un motivo que cuesta media hora descubrir: el
core vive en un contenedor y ahí `localhost` es el contenedor. Se abre a la red **y se le exige un
bearer**, que es lo que evita que abrirlo sea abrirlo a cualquiera.

## Qué se comprobó, y con qué resultado

| Prueba | Resultado |
|---|---|
| El core alcanza al modelo local | ✅ 200 desde dentro del contenedor; 401 sin el bearer |
| El core alcanza el MCP | ✅ handshake completo, 200 |
| Catálogo servido | ✅ **104 capacidades** de las 108 (cuatro denegadas de fábrica) |
| Clasificación por áreas | ✅ sistema 25 · red 15 · servicios 14 · docker 13 · procesos 8 · ficheros 8 · disco 7 · cámaras 6 |
| Migración 11 en producción | ✅ `conversations` y `chat_messages` creadas y vacías, `plans` intacta |
| Conversación de punta a punta | ✅ buscó, encontró, ejecutó contra el MCP real y respondió con datos ciertos |
| Primer turno real (20:15) | ✅ 87 s · prompt eval 434 tokens · eval 317 tokens · `conversations: 1` |
| Copia de seguridad y ensayo de restauración | ✅ las dos mitades, `integrity_check ok`, esquema 11, restaurada y verificada |
| Suite tras el cambio | ✅ 404 pruebas + 60 e2e, typecheck y lint limpios |

## Lo que se midió, que es lo que explica el diseño

**El catálogo no cabe, y no se arregla con más contexto.** Medido con el `/tokenize` del propio
`llama-server`:

| Qué | Tokens |
|---|---|
| catálogo completo, formato OpenAI | **8294** |
| el mismo compacto (sin espacios) | 6473 |
| índice de nombre + primera línea | 2824 |
| sólo los 108 nombres | 491 |

**Y lo decisivo no es el sitio, es el reloj.** Coste de ofrecerle más herramientas a la vez:

| Herramientas ofrecidas | Tokens | ¿Acierta? | Tiempo en elegir |
|---|---|---|---|
| 5 | ~500 | sí | 10,6 s |
| 10 | ~760 | sí | 26,0 s |
| 20 | ~1260 | sí | 36,2 s |
| 40 | ~2525 | sí | **187,0 s** |

No degrada en línea recta: de 10 a 40 la espera se multiplica por siete. El límite **no es la
precisión** —con 40 sigue eligiendo bien— sino que deja de ser una conversación. De ahí que el
router ofrezca lotes de ocho o diez.

**Dentro de un turno, el tiempo no se va donde parece.** De 32 s de media: 11,6 s en elegir la
herramienta, **1,1 s en ejecutarla** y 22,7 s en redactar, porque ese último turno lleva el
resultado entero en el contexto. El MCP no es el problema.

**El caché de prefijo funciona; lo caro es el prompt nuevo.** En un turno de cuatro vueltas,
`cache_n` fue 1850 → 1851 → 2749 → 3187: sólo se paga lo que se añade. Pero con la máquina
trabajando, procesar prompt cuesta **5-7 tokens/s** (36-52 en reposo), así que cada observación de
300 tokens son 30-60 s de espera. Por eso las observaciones se recortan a 1200 caracteres.

**Resultado de aplicar todo lo anterior: de 453 s a 108 s** en la misma pregunta y la misma
máquina, con la respuesta correcta.

> **Al comparar cualquier medida, hacerlo con carga parecida.** La misma tanda dio 32,4 s y 46,6 s
> en dos ejecuciones seguidas sin tocar nada. `CPUWeight=30` hace que el modelo ceda ante las
> cámaras, que para esta casa es lo correcto: la latencia del asistente depende de si el detector
> está ocupado. Una sola medida engaña.

## Lo que se rompió, y ya está corregido

1. **`llama-server` devolvía 500 al reenviarle un `tool_call` truncado.** El modelo contesta
   `arguments: "{"` cuando se queda sin sitio, y echar eso de vuelta al historial —que es lo que
   hay que hacer para continuar— tumbaba el turno entero por un carácter. Se sanea a `{}`
   conservando el id, porque a cada `tool_call` le corresponde su `tool_result`.
   *Es intermitente y por eso despista*: sólo rompe si el corte cae **dentro** de `arguments`, y
   esa ventana medía cinco tokens (falla en 46, 48 y 50; funciona en 44 y en 56).
2. **El tope de resultado de herramienta eran 60.000 caracteres**, heredado de una API con 200k de
   contexto. Aquí son unos 15.000 tokens: el contexto entero por una sola observación. Ahora es
   configurable y el modelo local usa 4000.
3. **El memo del turno distinguía `system_health_snapshot` de `zeus.system_health_snapshot`**, así
   que repetía la consulta más cara del catálogo: 200 s tirados en una conversación real.
4. **El modelo se inventaba argumentos por analogía.** En el primer turno de producción le pasó
   `seconds: 60` a `system_health_snapshot` y `top: 10` a `disk_usage`, copiando los parámetros de
   sus vecinas del lote. Los argumentos se ajustan al esquema antes de salir, y se dice cuáles se
   quitaron.
5. **Las sugerencias ante un nombre inventado salían contaminadas por el servidor.** Al pedir
   `zeus.processes` se buscaba «zeus processes», y «zeus» casa con `zeus_playbook` tan fuerte como
   «processes» con `list_processes`: se le ofrecía el manual del servidor. Ahora se busca por el
   nombre sin cualificar.
6. **El modelo escribía el aspecto de una llamada en vez de hacerla** —`<finish>`, `summary:`,
   bloques `<think>`— y eso llegaba tal cual a la pantalla. Se limpia y queda la frase.
7. **La copia de seguridad salió a medias** al desplegar: sólo el volumen del core, sin
   `jarvis-auth` —usuarios, passkeys y claves de sesión, que es la mitad que no se reconstruye—.
   No es un defecto del código: `bin/jarvis backup` ya hacía las dos mitades y falla si sale
   incompleta. Fue no usar el comando que había.

## Lo que queda

- **El redactor de 1,7B se equivoca al contar lo que ha leído** (IA-02 en el backlog). Los datos
  que trae son correctos y comprobables; la frase que los envuelve no siempre: dijo «el 68 % de la
  memoria está en uso» con un dato que decía 38 %. **La cadena es fiable; el redactor no siempre.**
  Mientras tanto, la interfaz enseña la consulta desplegable: el número real está a un clic de la
  frase que lo cuenta.
- **Verificar en el log del MCP** que tras `5dda2a2` desaparecen los `WARNING Invalid arguments`.
  Se comprueba desde el otro lado del cable, que es mejor sitio que el nuestro.
- El banco de pruebas de `~/harness-ia/` (fuera de este repositorio) tiene los números de
  referencia **anteriores** a la integración. Correrlo ahora y comparar dice si enchufarlo añadió
  espera o se comió aciertos.
