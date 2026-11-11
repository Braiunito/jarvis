# Jarvis — notas para Claude

Lo general está en el [README](README.md) y en `docs/`. Aquí, lo que conviene tener delante al
trabajar en este repositorio.

## Alertas

Jarvis tiene una bandeja de alertas que llegan como notificación al teléfono del usuario
([docs/alerts.md](docs/alerts.md)). Dos formas de usarla:

- **Desde el código del core**: `services.alerts.notify({ title, body, importance, link, origin:
  { kind: 'jarvis', host, app } })`. No espera al envío push ni lanza: es para avisar de algo que
  pasa dentro de Jarvis sin estorbarlo. Ejemplos en `apps/core/src/alerts/watch.ts`.
- **Desde fuera** (scripts, crons, otros Claude): `POST /api/alerts` con `Authorization: Bearer
  <clave>`, o `bin/jarvis-alert "título" "cuerpo"`.

**La clave no está en este fichero porque el repositorio es público.** Está en `CLAUDE.local.md`
(ignorado por git), en `~/.claude/CLAUDE.md` y en `~/.config/jarvis/alerts.env` de esta máquina, y
en `deploy/.env` de zeus. Nunca escribirla en un fichero versionado, en un commit ni en un test.

## Desplegar

Producción vive en zeus como usuario `zeus`; el modo es `JARVIS_MODE=host-tls` y sin él se cae el
sitio. Copia con `bin/jarvis backup` antes de tocar nada. Desde la migración 20, volver al código
anterior exige restaurar esa copia.
