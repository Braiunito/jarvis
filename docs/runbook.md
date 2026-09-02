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
esperando confirmación de cancelación y el último barrido. Que un host esté caído deja ese check
en rojo y todo lo demás en pie: la aplicación no se declara «offline» por un servidor.

## Diagnosticar

| Síntoma | Dónde mirar primero |
|---|---|
| no se puede entrar | ¿hay TLS? sin contexto seguro no hay passkeys; `bin/jarvis logs gateway` |
| «unauthenticated» dentro de la app | la sesión caducó o la cuenta se deshabilitó; `jarvis-users list` |
| un host aparece inalcanzable | Salud da la causa real de ssh, no la primera línea de su ruido |
| un run se queda en `cancelling` | no se pudo confirmar que el proceso remoto parase; Salud lo señala |
| un run acaba en `RUNNER_LOST` | ni tmux ni `status.json` en el host: mirar el spool a mano |
| el índice está viejo | `bin/jarvis logs aisessions-sync`; la app sigue sirviendo el último dato bueno |

El spool de un run vive en el host de ejecución:

```
<JARVIS_SPOOL_ROOT>/<runId>/
├── meta.json        destino y permiso con los que se lanzó
├── events.ndjson    lo que emitió el agente
├── stderr.log       lo que explica un fallo que no llegó a producir eventos
└── status.json      estado publicado con rename atómico
```

## Respaldar

```bash
node scripts/backup.mjs --core-db=/var/lib/jarvis-core/core.db \
                        --auth-dir=/var/lib/jarvis \
                        --out=/var/backups/jarvis/$(date +%F-%H%M)
```

Se copia la base con `VACUUM INTO` —consistente aunque haya escrituras— y el almacén de
autenticación entero: `users.json`, `session.key`, `internal.key`, la lista de revocación y el
registro de auditoría. Nada de eso se regenera: perder `session.key` echa a todo el mundo y perder
`users.json` se lleva las passkeys.

No se respalda el índice de aiSessions (es una caché que se rehace) ni los adjuntos (efímeros por
diseño).

## Restaurar

```bash
node scripts/restore.mjs --from=/var/backups/jarvis/2026-09-02-0300 \
                         --core-db=/srv/staging/core/core.db \
                         --auth-dir=/srv/staging/gateway
```

Verifica los checksums del manifiesto y pasa `integrity_check` antes de dar nada por bueno. Se
niega a escribir sobre un destino con datos salvo `--force`.

**Un backup que nunca se ha restaurado es una hipótesis.** El ensayo forma parte del despliegue,
no de la lista de buenas intenciones.

## Actualizar

```bash
git pull --ff-only          # sin merges automáticos en producción
bin/jarvis up
bin/jarvis smoke
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
