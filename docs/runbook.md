# Runbook

Lo que hace falta para levantar esto, mirarlo cuando algo va mal y volver atrás sin perder nada.

## Levantar

```bash
cp deploy/.env.example deploy/.env     # rellenar: hosts, rp id, secreto interno
bin/jarvis up
bin/jarvis ps
bin/jarvis smoke
```

Con TLS todavía no disponible:

```bash
JARVIS_MODE=lan bin/jarvis up          # publica el gateway, sin Caddy
```

Recordar que en ese modo **no hay passkeys**: se entra por la escotilla de contraseña o por un
túnel SSH ([docs/security.md](security.md)).

## Crear la primera cuenta

```bash
bin/jarvis users add braian "Braian"
bin/jarvis users enroll braian          # imprime un código de un solo uso
# la persona abre /enroll, escribe el código y registra su huella
bin/jarvis users list
```

## Mirar

```bash
bin/jarvis logs core        # o gateway, caddy, aisessions
bin/jarvis ps               # estado y salud de cada servicio
curl -s localhost:8080/healthz
```

En la interfaz, **Salud** enseña el estado por salto: base, índice, cada host, los runs que están
esperando confirmación de cancelación y los dos barridos —`runnerSweep`, que limpia spools en las
máquinas, y `eventRetention`, que compacta el historial en la base—. Que un host esté caído deja
ese check en rojo y todo lo demás en pie: la aplicación no se declara «offline» por un servidor.

Un barrido en `unknown` no es un fallo: es que todavía no ha corrido ninguno desde el arranque.
Los dos hacen una pasada al levantar precisamente para que ese estado dure segundos y no horas.

## Diagnosticar

| Síntoma | Dónde mirar primero |
|---|---|
| no se puede entrar | ¿hay TLS? sin contexto seguro no hay passkeys; `bin/jarvis logs gateway` |
| «unauthenticated» dentro de la app | la sesión caducó o la cuenta se deshabilitó; `jarvis-users list` |
| un host aparece inalcanzable | Salud da la causa real de ssh, no la primera línea de su ruido |
| un run se queda en `cancelling` | no se pudo confirmar que el proceso remoto parase; Salud lo señala |
| un run acaba en `RUNNER_LOST` | ni tmux ni `status.json` en el host: mirar el spool a mano |
| el índice está viejo | `bin/jarvis logs aisessions-sync`; la app sigue sirviendo el último dato bueno |
| falta el detalle de un trabajo viejo | no es un fallo: pasados 7 días se compacta y a los 30 queda el esqueleto (ver **Qué se guarda**) |
| un ajuste del `.env` no hace nada | comprobar que llega: `docker exec jarvis-next-core-1 env \| grep JARVIS_`. Una variable que el compose no pasa se ignora sin avisar |

El spool de un run vive en el host de ejecución:

```
<JARVIS_SPOOL_ROOT>/<runId>/
├── meta.json        destino y permiso con los que se lanzó
├── events.ndjson    lo que emitió el agente
├── stderr.log       lo que explica un fallo que no llegó a producir eventos
└── status.json      estado publicado con rename atómico
```

## Qué se guarda, y hasta cuándo

El historial de un trabajo no se borra por viejo, pero **adelgaza solo** (ADR-007). Lo aplica un
barrido que corre al arrancar y cada seis horas, sobre la base local; no depende de que ninguna
máquina de la flota responda.

| Edad del trabajo terminado | Qué queda |
|---|---|
| menos de 7 días | todo |
| entre 7 y 30 días | la salida de herramienta y el volcado crudo se sustituyen por su huella `sha256`, su tamaño y un resumen de una línea. El texto y el razonamiento se dejan enteros |
| más de 30 días | sólo los eventos estructurales: estado, destino, arranque, resultado y error |

Lo que está en marcha no se toca nunca. Y el número de orden de un evento (`seq`) no se renumera
jamás: al borrar quedan huecos, a propósito, para que un enlace a un evento concreto nunca acabe
apuntando a otro.

Se ajusta con `JARVIS_EVENT_COMPACT_AFTER_DAYS`, `JARVIS_EVENT_DROP_AFTER_DAYS`,
`JARVIS_EVENT_SUMMARY_CHARS` y `JARVIS_RETENTION_INTERVAL_MS`.

> **Al desplegar esto por primera vez sobre una base con historia, la primera pasada borra de
> golpe lo que ya pasó de los 30 días.** Es la política acordada y es irreversible: conviene mirar
> qué hay antes (`SELECT COUNT(*) FROM runs WHERE finished_at < date('now','-30 days')`) y tener
> una copia, en vez de descubrirlo después.

## Respaldar

```bash
bin/jarvis backup                       # deja la copia en backups/<fecha>
bin/jarvis backup /var/backups/jarvis   # o donde se diga
```

Eso es todo, y se ejecuta **en el bastión, sin Node**. Hasta el 2026-09-02 aquí ponía una llamada
directa a `scripts/backup.mjs` con las rutas de los volúmenes, que no se podía ejecutar en el
único sitio donde hace falta: esas rutas viven dentro de Docker y el bastión no tiene Node. Ese
comando no funcionó nunca contra el stack desplegado.

**La copia sale de dos contenedores porque el estado vive en dos sitios.** La base la monta el
core y el almacén de autenticación lo monta el gateway, y ninguno ve la mitad del otro: eso es la
frontera de privilegio del ADR-001 y no se rompe para hacer una copia. Cada contenedor copia lo
suyo con su propio manifiesto —`manifest-core.json` y `manifest-auth.json`— y `docker cp` los trae
juntos al mismo directorio.

Se copia la base con `VACUUM INTO` —consistente aunque haya escrituras— y el almacén de
autenticación entero: `users.json`, `session.key`, la lista de revocación y el registro de
auditoría. Nada de eso se regenera: perder `session.key` echa a todo el mundo y perder
`users.json` se lleva las passkeys. Si la instalación guarda la identidad interna en fichero,
`internal.key` entra también; cuando va por `JARVIS_INTERNAL_SECRET` no existe y no se copia.

El comando **falla** si la copia sale sin `core.db` o sin `users.json`. Media copia no es un aviso:
es una copia que no sirve.

No se respalda el índice de aiSessions (es una caché que se rehace) ni los adjuntos (efímeros por
diseño).

> La copia lleva claves y hashes de contraseña. Nace con el directorio en `700` y los ficheros en
> `600`, y `backups/` está en `.gitignore` — vive dentro del repositorio del bastión, así que sin
> esa línea un `git add -A` distraído la publicaría.

## Restaurar

```bash
node scripts/restore.mjs --from=/var/backups/jarvis/2026-09-02-0300 \
                         --core-db=/srv/staging/core/core.db \
                         --auth-dir=/srv/staging/gateway
```

Verifica los checksums del manifiesto y pasa `integrity_check` antes de dar nada por bueno. Se
niega a escribir sobre un destino con datos salvo `--force`. Entiende tanto una copia con
`manifest.json` como una en dos mitades, y **avisa en voz alta si le llega media**: restaurar sólo
la base deja un stack en el que no puede entrar nadie, y sólo la autenticación deja a todo el
mundo mirando una base vacía.

En el bastión no hay Node, así que el ensayo se hace dentro del core, que sí lo tiene. Con la
mitad de la base basta: es la que puede estar corrupta sin que se note.

```bash
rm -rf /tmp/solo-core && mkdir /tmp/solo-core
cp <copia>/core.db <copia>/manifest-core.json /tmp/solo-core/
core=$(docker compose -f deploy/compose.yml ps -q core)
docker cp /tmp/solo-core "$core:/tmp/solo-core"
docker exec "$core" node /app/scripts/restore.mjs --from=/tmp/solo-core \
  --core-db=/tmp/prueba/core.db --auth-dir=/tmp/prueba
docker exec "$core" rm -rf /tmp/solo-core /tmp/prueba && rm -rf /tmp/solo-core
```

Tiene que decir `integrity_check ok` y contar lo que trae. El propio `bin/jarvis backup` imprime
estos pasos al terminar, con el id del contenedor ya sustituido.

**Un backup que nunca se ha restaurado es una hipótesis.** El ensayo forma parte del despliegue,
no de la lista de buenas intenciones.

## Actualizar

```bash
git fetch origin
git merge --ff-only origin/master   # sin merges automáticos en producción
git log --oneline -1                # que sea el commit que se espera
bin/jarvis up
bin/jarvis smoke
```

Dos avisos que costaron un rato cada uno:

- **`git pull` a secas falla** en el checkout del bastión con «Cannot fast-forward to multiple
  branches», y **`merge --ff-only` sin `fetch` delante miente**: compara contra el `origin/master`
  guardado, responde «Already up to date» y deja el árbol donde estaba. Con esa respuesta se puede
  reconstruir tan tranquilo una imagen sin el cambio que se venía a desplegar.
- **«Built» no dice que lo construido lleve el cambio.** Se comprueba mirando dentro del
  artefacto, no en la salida del build:

  ```bash
  docker exec jarvis-next-core-1 sh -lc "ls /app/scripts"
  ```

Nunca `git clean -xfd`, `git checkout .` ni `git reset --hard` en el checkout del servidor: `.env`
y `secrets/` están ignorados y git los trata como basura. Para limpiar, `git clean -nxd` primero y
leer la lista.

## Volver atrás

1. `bin/jarvis down` (los volúmenes se quedan).
2. Volver a la versión anterior: `git checkout <tag>` y `bin/jarvis up`.
3. Las tmux de los runs **no se matan**: siguen en los hosts y el core las redescubre al arrancar.
4. Restaurar la base sólo si la migración fue destructiva. El diseño evita que lo sea: las
   migraciones son aditivas mientras la ventana de rollback siga abierta.

## Qué hacer cuando un run se queda a medias

Reconciliar no es reejecutar. Ante la duda de si un comando con efectos ocurrió, el core falla con
evidencia antes que duplicarlo. Si hace falta rematarlo a mano:

```bash
ssh <host> 'tmux ls | grep jarvis-run'
ssh <host> 'cat <spool>/<runId>/status.json'
```

Y después, en la consola, **reintentar** —que crea un run nuevo enlazado al anterior— en vez de
tocar la base a mano.

## El asistente local y las capacidades de sistema

Desde ADR-009 el asistente piensa en el bastión y puede consultar la máquina. Son dos piezas
distintas y se encienden por separado; sin ninguna de las dos, Jarvis funciona como antes.

### El cerebro de casa

En Zeus corre un `llama-server` con Qwen3-1.7B como unidad `llama-server`:

```bash
systemctl status llama-server          # en Zeus
curl -s -H "authorization: Bearer $(cat /home/zeus/llama-api.key)" \
  http://127.0.0.1:8181/v1/models | jq '.data[0].meta.n_ctx'
```

Lo que hay que saber para operarlo:

- **La URL que va en el `.env` es la de la LAN, no `127.0.0.1`.** El core vive en un contenedor y
  ahí `localhost` es el contenedor. Por eso el servidor escucha en la red y exige
  `Authorization: Bearer`; la clave está en `/home/zeus/llama-api.key`, con permisos 600.
- **`JARVIS_LOCAL_MODEL_CONTEXT` tiene que coincidir con el `n_ctx` real.** Se consulta con el
  comando de arriba. Ponerlo por encima de lo que sirve el modelo no degrada las respuestas: las
  impide, porque el prompt se corta por la mitad.
- Genera a 7-10 tokens/s, así que un turno son diez o quince segundos. El plazo por defecto son
  180 s y no es exagerado.

Comprobar que el core llega:

```bash
docker exec jarvis-next-core-1 sh -c \
  'curl -s -o /dev/null -w "%{http_code}\n" -H "authorization: Bearer $JARVIS_LOCAL_MODEL_API_KEY" \
   "$JARVIS_LOCAL_MODEL_BASE_URL/v1/models"'   # 200; sin el bearer, 401
```

### El MCP de sistema

En Zeus corre un servidor MCP con 108 herramientas de diagnóstico —estado del host, servicios,
Docker, red, disco, la iGPU y el sistema de cámaras— en **http://192.168.1.100:8765/mcp**
(Streamable HTTP). Vive fuera de este repo, en `/home/zeus/mcp-sistema`, con su propio README.

Se declara en el `.env` y el core lo consulta a través de `McpService`:

```
JARVIS_MCP_SERVERS=zeus=http://192.168.1.100:8765/mcp
JARVIS_MCP_WRITE_SERVERS=            # vacío: nadie escribe
```

Tres cosas que conviene tener claras antes de tocarlo:

- **Un servidor es de sólo lectura salvo que se le nombre** en `JARVIS_MCP_WRITE_SERVERS`. Con él
  puesto, el asistente puede *pedir permiso* para reiniciar servicios y contenedores; seguirá
  pidiéndolo siempre, pero antes ni siquiera podía pedirlo.
- **Cuatro herramientas no se sirven jamás**: `reboot_server`, `poweroff_server`, `apt_install` y
  `apt_update_cache`. Lo que se ponga en `JARVIS_MCP_DENY` se **suma** a ésas.
- **El puerto 8765 no tiene autenticación**: cualquiera en la LAN puede consultarlo. Está anotado
  en el README del propio servidor y sigue siendo cierto.

Ver qué hay enchufado y cómo está:

```bash
curl -s localhost:8080/api/capabilities | jq '.servers'
curl -s localhost:8080/api/health | jq '.checks | with_entries(select(.key|startswith("mcp:")))'
```

Un servidor MCP caído sale como un salto roto más: deja el catálogo anterior en `stale` y no tumba
nada. El asistente sigue contestando lo que sepa sin mirar la máquina.

### Comprobar que está enchufado de verdad

El síntoma que más despista, porque no parece una avería: **el asistente contesta con normalidad y
la carga de `llama` no sube**. Eso no es que el modelo local falle; es que el core no lo está
usando y sigue pensando en la nube. Pasa cuando el `.env` no tiene las variables o cuando se
cambiaron sin recrear el contenedor —un ajuste que no llega es peor que uno que no existe—.

```bash
docker exec jarvis-next-core-1 printenv | grep -c JARVIS_LOCAL_MODEL_BASE_URL   # 1, no 0
curl -s localhost:8080/api/chat | jq '.capabilities'   # localAvailable y capabilityCount
```

Con `JARVIS_VERBOSE=true`, el core dice además dónde se va el tiempo de cada vuelta:

```
[jarvis] modelo local · 24253 ms · prompt 2069 (caché 1902) · generados 105
```

`caché` es lo que el servidor **no** tuvo que volver a leer. Si en la segunda vuelta de un turno
ese número es bajo, se está pagando el prompt entero cada vez y el problema está en el servidor de
inferencia, no en el modelo ni en Jarvis.

### Después de enchufarlo, medir

Enchufarlo cambia las condiciones —más herramientas ofrecidas, más contexto, una capa más— y eso
puede costar latencia o aciertos sin que se note en una prueba a mano. En Zeus hay un banco de
pruebas fuera de este repo, `~/harness-ia/`, que ejercita la misma cadena contra el MCP real con
ocho preguntas de casa; sus números de referencia están en su README y se tomaron **antes** de la
integración.

Correrlo con el core ya conectado y comparar contra esa referencia es lo que dice si la
integración añadió espera o se comió aciertos. Una advertencia al comparar: la misma tanda dio
32,4 s y 46,6 s en dos ejecuciones seguidas sin tocar nada, porque `llama` cede CPU a las cámaras
(`CPUWeight=30`). Comparar sólo con carga parecida, o dos veces cada configuración.

Los números del estreno —cuánto cuesta el catálogo, cuánto tarda según cuántas herramientas se le
ofrezcan, dónde se va el tiempo de un turno y qué se rompió el primer día— están en
[`evidence/2026-09-04-asistente-local.md`](../evidence/2026-09-04-asistente-local.md). Es el sitio
al que volver antes de tocar un ajuste: casi todos los valores por defecto de esta feature salen de
una medida que está ahí.
