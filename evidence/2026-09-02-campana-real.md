# Campaña real · 2026-09-02

Primera ejecución del stack completo fuera del laboratorio: contra **zeus** (192.168.1.100),
**goro2** y **vultr**, con las CLIs y las cuentas de verdad. Hasta hoy todo se había probado
contra el `ssh` y el índice falsos del testkit.

## Cómo se montó

| Pieza | Cómo corrió |
|---|---|
| índice | `aisessions serve --port 8766` sobre un índice escaneado por SSH (`scan --host zeus --host vultr`) |
| core | `apps/core/dist/main.js` con `JARVIS_HOSTS=zeus,goro2,vultr`, bastión `zeus`, ssh propio |
| gateway | puerto 8081, escotilla de contraseña sobre HTTP (LAN) |
| consola | el build de `apps/web` servido por el gateway |

El `ssh` que usó el core es un envoltorio con su propia `ssh_config` (alias, claves y
`accept-new`), fuera del repositorio porque nombra claves.

## Qué se comprobó, y con qué resultado

| Prueba | Resultado |
|---|---|
| Capacidades por máquina | zeus: claude 2.1.258 + codex 0.152 + tmux 3.5a · vultr: claude 2.1.252 + opencode 1.18.26 + tmux 3.3a · goro2: inalcanzable (sin clave) |
| Índice de sesiones | 18 sesiones reales en zeus, 7 en vultr, con título, ruta y frescura |
| Trabajo durable · Claude en zeus | ✅ `JARVIS-REAL-OK`; y `hostname`+`uptime` devolvió `zeus \| up 5 days, 11:19` |
| Trabajo durable · Codex en zeus | ✅ tras arreglar el resumen vacío (HZ-10) |
| Estrategia nativa en el tercer servidor | ✅ elegida sola (`strategy: B`) para vultr |
| Cancelación | ✅ `running → cancelling → cancelled` en 4 s, sin procesos sueltos |
| Terminal viva | ✅ tmux creada en zeus; Claude pide confirmar la carpeta, como debe |
| Cuenta y cuota | ✅ cuenta real, plan pro, sesión 100% y semana 95% disponibles, con hora de reinicio |
| Host caído | ✅ goro2 sale `HOST_UNREACHABLE` con su motivo y el resto de la consola sigue usable |
| Gateway sin core | ✅ `UPSTREAM_UNAVAILABLE` con `retryable`, no un 500 opaco |
| Consola de escritorio | ✅ portada, explorador, workspace, Run Center y salud con datos reales |
| Consola en móvil (390×844) | ✅ barra inferior, contadores y tarjetas legibles |
| Progreso en vivo | ✅ el trabajo pasa a «Terminado» sin recargar |

## Lo que se rompió, y ya está corregido

1. **El spool por defecto hacía imposible lanzar cualquier trabajo** (HZ-09). `$HOME/...` no lo
   expande nadie y `spoolLayout` exige ruta absoluta: 500 en cada `POST /api/runs`. Ahora la sonda
   trae el home de cada máquina y el spool se resuelve por host.
2. **Codex terminaba sin resultado** (HZ-10): su CLI 0.152 ya no repite el texto en el evento
   final.
3. **Eventos nuevos de Claude Code como «sin traducir»** (HZ-11): `system/thinking_tokens` y
   `rate_limit_event`.
4. **Errores con color de terminal dentro** (HZ-12): `opencode` los escribe con ANSI.
5. **El bastión contado dos veces en la frescura** (HZ-13): el índice llama `local` a su propia
   máquina.

## Lo que queda

- **goro2** sólo acepta contraseña, y el core exige clave (`BatchMode=yes`, que es lo correcto).
  Hace falta instalar una clave pública allí: es una decisión del operador, no del agente.
- **claude en vultr** tiene la sesión OAuth caducada: `Failed to authenticate: OAuth session
  expired`. Se ve bien reportado en la consola, pero hay que reautenticar en esa máquina.
- TEC-09 (aprovechar la cuota que ya viene en cada run), TEC-10 (empezar una sesión nueva) y
  TEC-11 (una sesión sin `cwd` no se puede reanudar) quedan anotados en el backlog.
