# ADR-003 · El proceso del agente vive en el host, no en la conexión SSH del core

Fecha: 2026-09-02 · Estado: aceptado

## Contexto

Hoy un run es un `spawn('ssh')` dentro del bridge: si el proceso muere, se reinicia el contenedor
o se corta la red, la ejecución muere con él y su salida se pierde. Un asistente de bastión que se
usa desde el móvil no puede tener esa propiedad.

## Decisión

Cada run se ejecuta dentro de una sesión tmux determinista `jarvis-run-<runId>` en el
**execution host**, escribiendo a un spool:

```
<root>/runs/<runId>/
├── meta.json          metadata saneada, escrita antes de ejecutar
├── events.ndjson      salida del adapter, una línea por registro
├── stderr.log
└── status.json        publicado con .tmp + rename (atómico)
```

Permisos: directorios `0700`, ficheros `0600`, id opaco validado, ningún prompt ni nombre de
fichero de usuario entra en un path.

El core:

- arranca de forma **idempotente**: si la tmux ya existe o hay `status.json` terminal, no lanza
  una segunda ejecución;
- sigue `events.ndjson` por cursor de bytes (`remote_cursor_bytes`) y confirma eventos con `seq`
  durable en la misma transacción que el cursor;
- reconcilia al arrancar según la tabla de `05-data-runs-and-operations.md` §7;
- **nunca reejecuta** ante duda: prefiere `failed/RUNNER_LOST` con evidencia a duplicar un efecto.

El wrapper remoto es un script POSIX pequeño, sin dependencias, instalado por el propio core
(`mkdir` + `cat > wrapper.sh`) en cada preparación.

## Consecuencias

- `docker restart core` durante un run real no pierde ni duplica la ejecución.
- El coste es un contrato de ficheros que hay que versionar (`RUNNER-SPOOL-01`) y un sweeper de
  spools viejos.
- Requiere `tmux` en el execution host; si falta, el run falla explícitamente en vez de degradar
  a un modo no recuperable.
