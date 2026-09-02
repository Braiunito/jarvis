# ADR-001 · El gateway y el core son procesos distintos porque el privilegio es distinto

Fecha: 2026-09-02 · Estado: aceptado

## Contexto

El gateway es el proceso expuesto: termina TLS por detrás de Caddy, sirve la SPA, corre las
ceremonias WebAuthn y guarda las cookies. El core necesita la clave SSH de la flota, la allowlist
de hosts y la capacidad de ejecutar agentes en máquinas reales.

Fusionarlos ahorraría un proxy y unas rutas. También pondría la clave que abre todos los
servidores dentro del proceso que atiende peticiones anónimas de internet.

## Decisión

Dos procesos y dos imágenes.

- El gateway **no** monta `secrets/ssh`, no conoce hosts y no puede ejecutar nada remoto.
- El core **no** publica puerto al host y sólo acepta tráfico de la red interna que llegue con
  una identidad interna firmada (`X-Jarvis-Identity`, HMAC sobre `user|requestId|exp`).
- La cookie de sesión se elimina antes de reenviar: el core nunca ve un token de usuario y por
  tanto no puede reproducirlo.
- El secreto de la identidad interna es distinto del secreto de sesión web.

## Consecuencias

- Reiniciar o migrar el core no invalida sesiones web ni toca TLS.
- Un compromiso del gateway da acceso a la API del core como el usuario autenticado, no a la
  clave SSH ni a la ejecución directa.
- Coste: un salto extra de red interna y un contrato de identidad que mantener.
- Verificación: `apps/core` rechaza cualquier request sin firma válida; hay test dorado
  (`EDGE-PROXY-01`) que lo comprueba.
