# Jarvis

Consola de trabajo con agentes de código repartidos entre varias máquinas.

No es un chat con muchos proveedores. Su objeto no es el mensaje: es **trabajo con identidad,
destino, permisos, duración y evidencia**. Encontrar el contexto correcto, mandar trabajo al
agente correcto en la máquina correcta, supervisarlo desde donde sea y recuperarlo sin ambigüedad
cuando algo se corta.

## La idea en una frase

> El servidor posee sesiones, runs, planes, eventos y borradores; el navegador muestra una consola
> reemplazable; SSH, tmux y los CLIs siguen siendo los adaptadores hacia las máquinas reales.

## Cómo está montado

```
navegador ─► caddy ─► gateway ─► core ─┬─► SQLite (runs, workspaces, planes, eventos)
                      (auth,      (dominio,   ├─► aiSessions (índice, sólo lectura)
                       sin SSH)    con SSH)   └─► hosts: tmux + spool + CLIs
```

- **gateway** — el borde autenticado. Passkeys, sesión web, sirve la SPA y proxya al core con una
  identidad interna firmada. No tiene clave SSH, y eso es el diseño, no un descuido ([ADR-001]).
- **core** — el dominio. Es quien tiene la clave de la flota y quien decide en qué máquina corre
  cada cosa. No publica puerto al host.
- **web** — React sin stores globales: el servidor manda, TanStack Query cachea y la URL guarda
  qué se está mirando.

El asistente piensa en una IA **local** del bastión y sale a la nube sólo con permiso explícito
([ADR-009]); por el mismo camino consulta el MCP de sistema de la máquina.

Un run no vive en la conexión SSH del core: vive en una sesión tmux del host de ejecución que
escribe a un spool. Por eso `docker restart core` no interrumpe el trabajo ([ADR-003]).

## Empezar

```bash
npm install
npm run build:apps          # compila todo y construye la SPA

# El stack entero contra hosts falsos, en esta máquina: tmux y spool de verdad, sin bastión.
npm run dev:user -- add braian
npm run dev:user -- set-password braian <una contraseña larga>
npm run dev:local           # http://localhost:8080
```

El `ssh` de desarrollo es [`packages/testkit/bin/fake-ssh.mjs`](packages/testkit/bin/fake-ssh.mjs):
monta un HOME y un PATH por host y **ejecuta de verdad** en local. Los agentes son falsos pero el
tmux, el spool y los ficheros son reales, que es lo que permite probar recuperación sin inventarse
un doble de todo.

## Pruebas

```bash
npm run test            # 397 pruebas: contratos, unidad e integración
npm run test:contracts  # sólo los contratos dorados, sin servicios externos
npm run test:e2e        # los cinco flujos críticos, escritorio y móvil
npm run check           # typecheck + lint + test
```

Los tests de integración levantan el core contra tmux real y matan procesos a propósito: la
durabilidad se prueba rompiendo cosas, no describiéndolas.

## Desplegar

```bash
cp deploy/.env.example deploy/.env    # y rellenarlo
JARVIS_MODE=lan bin/jarvis up         # ver el aviso de abajo
bin/jarvis smoke
```

> ⚠️ **`JARVIS_MODE=lan` no es opcional en esta instalación, y olvidarlo tira el
> servicio.** Sin esa variable, `bin/jarvis up` levanta el compose completo: Caddy
> toma los puertos 80 y 443, fuerza redirección a HTTPS con un certificado
> autofirmado para `localhost`, y **el gateway deja de publicar el 8080** — que es
> por donde se entra de verdad (`JARVIS_ORIGINS` apunta a `:8080`). Desde fuera
> queda un 308 hacia un HTTPS que no responde: parece que Jarvis se ha caído,
> cuando por dentro gateway y core siguen sanos y el `smoke` da 200.
>
> Pasó el 04/09/2026 al desplegar a mano. `deploy/jarvis.service` sí lleva
> `Environment=JARVIS_MODE=lan`; quien despliegue sin systemd tiene que ponerla.
>
> Cómo se comprueba que quedó bien: `curl -o /dev/null -w '%{http_code}'
> http://<host>:8080/` devuelve 200, y `ss -tln` no muestra nada escuchando en 443.

Sin TLS no hay passkeys: el navegador no expone WebAuthn fuera de un contexto seguro. Mientras no
haya certificado se usa `JARVIS_MODE=lan` con la escotilla de contraseña o un túnel SSH. Esa
escotilla se revisa **en cada despliegue** ([docs/security.md](docs/security.md)).

## Documentación

| Documento | Qué contesta |
|---|---|
| [docs/architecture.md](docs/architecture.md) | qué hace cada pieza y dónde vive la verdad de cada dato |
| [docs/console.md](docs/console.md) | qué promete la interfaz y con qué reglas está hecha |
| [docs/security.md](docs/security.md) | qué se protege, cómo, y qué está deliberadamente abierto |
| [docs/runbook.md](docs/runbook.md) | levantar, mirar, diagnosticar, respaldar y volver atrás |
| [docs/trace-a-request.md](docs/trace-a-request.md) | seguir una petición desde el clic hasta el host |
| [docs/contracts/registry.md](docs/contracts/registry.md) | los contratos congelados y sus fixtures |
| [docs/adr/](docs/adr/) | las decisiones y por qué se tomaron |
| [docs/migration/](docs/migration/) | el estado de la migración desde LiteChat y su evidencia |
| [docs/audits/](docs/audits/) | las auditorías del código, con la evidencia de cada hallazgo |
| [backlog.md](backlog.md) | lo siguiente, y quién lleva qué de las auditorías |

[ADR-001]: docs/adr/0001-gateway-core-privilege-boundary.md
[ADR-003]: docs/adr/0003-remote-runner-tmux-spool.md
[ADR-009]: docs/adr/0009-local-brain-and-mcp-client.md
