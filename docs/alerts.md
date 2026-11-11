# Alertas y notificaciones

Lo que Jarvis —o cualquier script, cron o Claude con la clave— quiere que sepas aunque no estés
mirando la consola. Aparecen en la campana de la cabecera, al lado del escudo, y en la pantalla
**Alertas** (`/alerts`); y según su importancia suenan como notificación en los dispositivos que las
tengan activadas (Android, escritorio, e iPhone con la app añadida a la pantalla de inicio).

## Los dos ejes: importancia y origen

| Importancia | Qué hace | Para qué |
|---|---|---|
| `low` | sólo se apunta en la bandeja; nunca suena | que conste: un trabajo cancelado, un host que vuelve |
| `normal` | suena | algo terminó y conviene saberlo |
| `high` | suena con urgencia alta | algo falló y hay que mirar |
| `critical` | suena y se queda en pantalla hasta quitarla | algo está roto ahora |

Cada dispositivo elige además su **mínimo** (por defecto `normal`): un teléfono puede quedarse sólo
con `high` y `critical` mientras el escritorio recibe todo.

El origen son tres datos:

- **tipo** — `api` si llegó por `POST /api/alerts` (con la clave o con sesión), `jarvis` si la creó
  el propio core. Quien llama por la API **no puede** declararse `jarvis`.
- **máquina** — la que la mandó: `braian` para el puesto de desarrollo, `zeus` para el bastión,
  `goro2`… Por la API la declara quien llama (`host`); si no la dice, queda la IP que vio el gateway.
- **remitente** (`app`) — quién dentro de esa máquina: `claude-code`, `backup`, `runs/claude`, `salud`…

## Lo que cuenta Jarvis por su cuenta

- **Cada trabajo que termina**, con la máquina donde corrió y `runs/<agente>` como remitente:
  terminado → `normal`, fallido o pasado de tiempo → `high`, cancelado → `low`. Tocarla lleva al trabajo.
  Se apaga con `JARVIS_ALERTS_RUNS=false`.
- **Cambios de salud**, mirando cada `JARVIS_ALERTS_HEALTH_WATCH_MS` (5 min; `0` lo apaga): un host
  que deja de responder, el índice de sesiones caído, cancelaciones sin confirmar → `high`; la base del
  core → `critical`; y cuando vuelven, `low`. Un cambio tiene que verse **dos veces seguidas** antes de
  avisar, y la primera vuelta tras arrancar sólo aprende: un host apagado desde hace una semana no
  dispara nada al desplegar.
- **Cada arranque del core**, en `low`: sirve para confirmar un despliegue desde el teléfono.

## La API

```
POST /api/alerts
Authorization: Bearer <clave>
Content-Type: application/json

{
  "title": "Backup terminado",          // obligatorio, ≤ 200
  "body": "3,2 GB en 4 min",            // opcional, ≤ 4000
  "importance": "normal",               // low | normal | high | critical (por defecto normal)
  "host": "braian",                     // la máquina de origen
  "app": "backup",                      // el remitente
  "link": "/runs/r123"                  // ruta de la consola o URL http(s)
}
```

Responde `201` con la alerta guardada, incluido `pushedTo`: a cuántos dispositivos llegó. Errores:
`400` si el cuerpo no cumple (campos de más incluidos), `401` clave mala, `403` la clave usada para
otra cosa que crear, `429` más de 30 por minuto (`JARVIS_ALERTS_API_PER_MINUTE`) o demasiados
intentos con clave mala desde la misma IP.

**La clave sólo abre esa puerta.** No lee la bandeja, no marca nada, no toca runs ni terminales: el
gateway la comprueba sólo en `POST /api/alerts` y reenvía al core como el usuario de servicio
`alerts-api`. Que se filtre es ruido en el teléfono, no un acceso a la flota. Una clave mala es `401`
aunque la petición traiga cookie o venga de la LAN con el modo de pruebas puesto.

El resto de rutas (`GET /api/alerts`, `POST /api/alerts/read`, `DELETE /api/alerts/:id`,
`/api/alerts/push/*`) son de la consola y piden sesión. El contrato está en
[`packages/contracts/src/alerts.ts`](../packages/contracts/src/alerts.ts).

## Desde la terminal: `jarvis-alert`

[`bin/jarvis-alert`](../bin/jarvis-alert) es un cliente de una línea (bash + curl, con `jq` o
`python3` para el JSON):

```bash
jarvis-alert "Despliegue terminado"
jarvis-alert -i high -a backup -l /health "Backup falló" "disco lleno en /var"
make test 2>&1 | tail -20 | jarvis-alert -i high "Las pruebas fallan" -
```

Lee `JARVIS_ALERTS_URL`, `JARVIS_ALERTS_KEY` y `JARVIS_ALERTS_HOST` del entorno o de
`~/.config/jarvis/alerts.env` (modo 600). Dentro de Claude Code el remitente por defecto es
`claude-code`. Nunca espera más de 20 s: un aviso no puede colgar la tarea que avisa.

Para instalarlo en otra máquina: copiar el script a `~/.local/bin/` y crear el `alerts.env`. En el
propio bastión la URL puede ser `http://127.0.0.1:8080` (el gateway escucha ahí en modo `host-tls`).

## Cómo llega al teléfono

El core firma cada envío con VAPID y cifra el mensaje con `aes128gcm` (RFC 8291/8292), escrito con
`node:crypto` sin dependencias y probado contra el vector del propio RFC
([`apps/core/test/webpush.test.ts`](../apps/core/test/webpush.test.ts)). El par VAPID lo genera el core
la primera vez y lo guarda en su base (`push_vapid`); **cambiarlo obliga a reactivar cada
dispositivo**, por eso sólo se fija por entorno (`JARVIS_PUSH_VAPID_*`) si hay que conservarlo al
cambiar de base. `JARVIS_PUSH_SUBJECT` tiene que ser un `mailto:` o un `https:` reales: Apple rechaza
el envío si no.

Un dispositivo que el servicio de push da por perdido (404/410) se borra solo; uno que falla guarda
el último error, que se ve en la pantalla de Alertas, y se olvida a los 20 fallos seguidos.

La consola es una PWA mínima: manifiesto, iconos y un service worker (`/sw.js`) que sólo hace
notificaciones —no cachea nada: sin el servidor, Jarvis no tiene nada que enseñar—. En iOS las
notificaciones sólo existen con la app **añadida a la pantalla de inicio** (Compartir → Añadir a
pantalla de inicio) y abierta desde ahí.

## Qué se guarda

Una sola bandeja para toda la casa, en la base del core (migración 20: `alerts`,
`push_subscriptions`, `push_vapid`). Se quedan 30 días (`JARVIS_ALERTS_RETENTION_DAYS`) y como mucho
2000 (`JARVIS_ALERTS_MAX_STORED`); lo viejo se borra al entrar lo nuevo.

**Volver atrás**: el código anterior a la migración 20 se niega a arrancar con una base que ya la
tiene. La vuelta atrás es restaurar la copia de `bin/jarvis backup`, como con la 19.
