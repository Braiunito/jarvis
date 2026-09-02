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
npm run test            # 165 pruebas: contratos, unidad e integración
npm run test:contracts  # sólo los contratos dorados, sin servicios externos
npm run test:e2e        # los cinco flujos críticos, escritorio y móvil
npm run check           # typecheck + lint + test
```

Los tests de integración levantan el core contra tmux real y matan procesos a propósito: la
durabilidad se prueba rompiendo cosas, no describiéndolas.

## Desplegar

```bash
cp deploy/.env.example deploy/.env    # y rellenarlo
bin/jarvis up
bin/jarvis smoke
```

Sin TLS no hay passkeys: el navegador no expone WebAuthn fuera de un contexto seguro. Mientras no
haya certificado se usa `JARVIS_MODE=lan` con la escotilla de contraseña o un túnel SSH. Esa
escotilla se revisa **en cada despliegue** ([docs/security.md](docs/security.md)).

## Documentación

| Documento | Qué contesta |
|---|---|
| [docs/architecture.md](docs/architecture.md) | qué hace cada pieza y dónde vive la verdad de cada dato |
| [docs/security.md](docs/security.md) | qué se protege, cómo, y qué está deliberadamente abierto |
| [docs/runbook.md](docs/runbook.md) | levantar, mirar, diagnosticar, respaldar y volver atrás |
| [docs/trace-a-request.md](docs/trace-a-request.md) | seguir una petición desde el clic hasta el host |
| [docs/contracts/registry.md](docs/contracts/registry.md) | los contratos congelados y sus fixtures |
| [docs/adr/](docs/adr/) | las decisiones y por qué se tomaron |
| [docs/migration/](docs/migration/) | el estado de la migración desde LiteChat y su evidencia |
| [backlog.md](backlog.md) | lo siguiente, empezando por el bloque de UX |

[ADR-001]: docs/adr/0001-gateway-core-privilege-boundary.md
[ADR-003]: docs/adr/0003-remote-runner-tmux-spool.md
