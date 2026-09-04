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

## Conectar el MCP de sistema de Zeus (pendiente, no integrado)

En Zeus corre un servidor MCP con 108 herramientas de diagnóstico —estado del
host, servicios, Docker, red, disco, la iGPU y el sistema de cámaras— en
**http://192.168.1.100:8765/mcp** (Streamable HTTP). Vive fuera de este repo, en
`/home/zeus/mcp-sistema`, con su propio README.

**Hoy Jarvis no lo consume, y es una decisión, no un olvido.** Este stack no
tiene cliente MCP: [ADR-004](adr/0004-rest-sse-ws-mcp.md) define MCP como
*adaptador para modelos externos* —Jarvis lo expone, no lo llama— y el toolbox
del Assistant exige que una herramienta llame a un caso de uso del core, nunca a
una API HTTP. Enchufarlo "a lo rápido" desde una tool rompería las dos reglas.

Las dos formas legítimas de hacerlo, si algún día hace falta:

1. **Un modelo que hable MCP por su cuenta.** Es el caso que ADR-004 contempla:
   el runtime del modelo (la app Jan, LM Studio, un wrapper del `llama-server`)
   se conecta al puerto 8765 por configuración. Cero cambios en este repo. Es la
   vía prevista para Jan-v1-4B cuando pase de los benchmarks a estar servido.
2. **Un caso de uso en el core.** Un `SystemService` que hable MCP y unas pocas
   tools en `assistant/toolbox.ts` que lo llamen, igual que las demás. Respeta
   ADR-004 y la regla del toolbox, pero es una capacidad nueva del core: pide
   contracts, tests y su propio ADR.

Mientras tanto el servidor está corriendo y endurecido (`systemctl status
mcp-sistema` en Zeus): sirve para diagnosticar la máquina a mano aunque ningún
modelo lo use todavía.
