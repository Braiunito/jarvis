# Registro de contratos (M0-01)

Estado: congelado para la migración · fuente legacy = repo `LiteChat` (services/bridge, services/gateway).

Cada contrato tiene un id estable. Un PR que cambia el comportamiento observable de uno de ellos
debe nombrarlo y actualizar su fixture. Los tests dorados viven en
`packages/legacy-contract-tests/` y corren **sin servicios externos** (`npm run test:contracts`).

| ID | Qué congela | Fuente legacy | Fixture | Destino nuevo |
|---|---|---|---|---|
| `SSH-QUOTE-01` | `shellQuote`/`shellJoin`: charset seguro, comillas simples, zsh (`=`, `~`) | `bridge/lib/ssh.js` | `fixtures/ssh/quoting.json` | `@jarvis/agent-adapters/ssh` |
| `SSH-SCRIPT-01` | `remoteScript`: PATH export, `cd`, env, `< /dev/null` | `bridge/lib/ssh.js` | `fixtures/ssh/scripts.json` | idem |
| `SSH-ALLOW-01` | allowlist obligatoria; nombre de host no puede parecer opción | `bridge/lib/ssh.js` | `fixtures/ssh/hosts.json` | idem |
| `SSH-ARGV-01` | argv de ssh: BatchMode, StrictHostKeyChecking, known_hosts escribible, `--` | `bridge/lib/ssh.js` | `fixtures/ssh/argv.json` | idem |
| `HOST-CAP-01` | probe `command -v` por binario, cacheo por host y TTL | `bridge/lib/hosts.js` | `fixtures/hosts/capabilities.json` | `@jarvis/agent-adapters/hosts` |
| `HOST-TARGET-01` | estrategia bastion/A/B y motivo; `local` → bastión | `bridge/lib/hosts.js` | `fixtures/hosts/targets.json` | idem |
| `HOST-PREAMBLE-01` | preámbulo obligatorio de estrategia A | `bridge/lib/hosts.js` | `fixtures/hosts/preamble.json` | idem |
| `HOST-SSHFAIL-01` | razón de fallo ssh ignora ruido benigno de stderr | `bridge/lib/hosts.js` | `fixtures/hosts/ssh-failure.json` | idem |
| `ADAPT-CLAUDE-01` | argv/env auto-mode y normalización stream-json | `bridge/lib/adapters/claude.js` | `fixtures/adapters/claude.*.json` | `@jarvis/agent-adapters/adapters` |
| `ADAPT-CODEX-01` | argv/env `codex exec resume` + sandbox por config, normalización | `bridge/lib/adapters/codex.js` | `fixtures/adapters/codex.*.json` | idem |
| `ADAPT-OPENCODE-01` | argv agente plan/build, normalización | `bridge/lib/adapters/opencode.js` | `fixtures/adapters/opencode.*.json` | idem |
| `ADAPT-PERM-01` | mapa `safe|auto|yolo` → modo por proveedor (nunca elevar implícito) | adapters | `fixtures/adapters/permissions.json` | idem |
| `INDEX-SESSION-01` | filas de aiSessions → `SessionRef`/`SessionSummary`, `local` normalizado | `bridge/lib/mcp.js`, aiSessions | `fixtures/index/sessions.json` | `core/sessions` |
| `INDEX-FRESH-01` | frescura por host y last-known-good ante fallo de sync | aiSessions | `fixtures/index/freshness.json` | idem |
| `RUN-STATE-01` | máquina de estados de run y transiciones inválidas | `bridge/lib/runs.js` (+ diseño 05) | `fixtures/runs/transitions.json` | `core/runs` |
| `RUN-EVENT-01` | `seq` monotónico, truncado marcado, tipos de evento | `bridge/lib/runs.js` | `fixtures/runs/events.json` | idem |
| `RUN-SSE-01` | `Last-Event-ID`, replay exacto, keepalive, fin de stream | `bridge/server.js` | `fixtures/runs/sse.json` | idem |
| `RUNNER-SPOOL-01` | layout `meta.json`/`events.ndjson`/`status.json` + publicación atómica | nuevo (ADR-003) | `fixtures/runner/spool.json` | `core/runs/runner` |
| `RUNNER-RECOVERY-01` | tabla de reconciliación al arrancar | nuevo (ADR-003) | `fixtures/runner/reconcile.json` | idem |
| `ATTACH-01` | path opaco, 0600, `.part`+rename, cuota, claim/release | `bridge/lib/attachments.js` | `fixtures/attachments/lifecycle.json` | `core/attachments` |
| `TERM-TMUX-01` | naming `jarvis-*`, `=name` vs `=name:`, sólo sesiones propias | `bridge/lib/tmux.js` | `fixtures/terminal/tmux.json` | `core/terminal` |
| `TERM-WS-01` | handshake RFC6455, framing, continuación, ping/pong, EPIPE no fatal | `bridge/lib/websocket.js` | `fixtures/terminal/websocket.json` | idem |
| `USAGE-01` | normalización cuenta/límites Claude/Codex + last-known-good `stale` | `bridge/lib/usage.js` | `fixtures/usage/*.json` | `core/usage` |
| `AUTH-STORE-01` | formato `users.json` v1 (userId opaco, credenciales JWK, totp, enrollment) | `gateway/lib/store.js` | `fixtures/auth/users.v1.json` | `gateway/auth` |
| `AUTH-WEBAUTHN-01` | verificación de registro/aserción: challenge, origin, rpIdHash, UP/UV, signCount | `gateway/lib/webauthn.js` | fake authenticator | idem |
| `AUTH-CHAIN-01` | cadena de pasos (`password+passkey+totp`), token `pending` con audiencia propia | `gateway/lib/auth.js` | `fixtures/auth/chain.json` | idem |
| `AUTH-SESSION-01` | cookie HttpOnly/SameSite/Secure, revocación por `jti`, cookie malformada no rompe | `gateway/lib/session.js` | `fixtures/auth/session.json` | idem |
| `AUTH-INSECURE-01` | hatch HTTP: sólo LAN, auditado como `login.success.insecure` | `gateway/lib/auth.js` | `fixtures/auth/insecure.json` | idem |
| `EDGE-PROXY-01` | cookie nunca viaja al core, identidad interna firmada, SSE sin buffering | `gateway/lib/proxy.js` | `fixtures/edge/proxy.json` | `gateway/proxy` |
| `EDGE-STATIC-01` | SPA fallback, 404 real para assets, cache-control por nombre | `gateway/lib/http.js` | `fixtures/edge/static.json` | idem |
| `ERR-01` | error público `{code,message,retryable,scope,requestId}` | nuevo (02) | `fixtures/errors/shape.json` | `@jarvis/contracts` |

## Owners

Un solo repositorio y un solo operador: el owner de todos los contratos es el mantenedor del
repo. Lo que la columna «owner» resolvería en un equipo grande aquí lo resuelve la regla de
revisión humana obligatoria del backlog (§7 de `07-execution-backlog.md`).

## Reglas

1. Un fixture se captura del sistema legacy o de una CLI real, se sanea y se versiona.
2. Un test dorado falla si el normalizador deja de entender un transcript capturado.
3. Cambiar un contrato exige: nuevo fixture, nota en `CHANGELOG.md` y mención del id en el PR.
4. Ningún test dorado abre red, SSH real ni Docker.
