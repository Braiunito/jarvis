# Estado de la migración

La misión y su plan completo están en [`migration-mission/`](../../../LiteChat/migration-mission/)
del repositorio anterior. Esto es dónde estamos.

| Fase | Qué era | Estado |
|---|---|---|
| M0 · congelar contratos | fixtures y pruebas doradas de lo que se promete conservar | **hecho** — `npm run test:contracts` |
| M1 · repo, Docker y límite de confianza | gateway portado, imágenes, compose, borde | **hecho** — imágenes construidas y probadas |
| M2 · flota y sesiones (sólo lectura) | índice, workspaces, borradores, consola | **hecho** |
| M3 · trabajo directo durable | RunService, spool remoto, reconciliación, SSE, adjuntos | **hecho** — probado matando el core a mitad |
| M4 · Assistant, terminal y diagnóstico | planes, aprobaciones, tmux por WebSocket, salud | **hecho** |
| M5 · importación y compatibilidad | `litechat-export-v1`, backup y restore | **hecho** — restore ensayado |
| M6 · sombra, canario y corte | comparar contra el stack viejo y conmutar tráfico | **pendiente** — necesita el bastión real |
| M7 · archivar LiteChat | retirar el stack anterior tras la ventana de observación | **pendiente** |

M6 y M7 no se pueden completar en una máquina de desarrollo: requieren el bastión, sus hosts y una
ventana de observación con tráfico real. Todo lo anterior sí, y por eso está hecho y probado aquí.

## Lo que falta para el corte

1. Construir la imagen de aiSessions desde su repositorio y apuntar `JARVIS_AISESSIONS_IMAGE`.
2. Copiar el volumen de autenticación del despliegue actual y comprobar que una passkey real entra
   sin re-enrolar (el formato es el mismo, pero eso hay que verlo, no suponerlo).
3. Exportar desde el LiteChat en producción con el fragmento de
   [`import.md`](./import.md) e importarlo.
4. Sombra en sólo lectura: comparar hosts, capacidades, sesiones y destinos contra el stack viejo.
5. Canario por capacidad —trabajo directo primero, Assistant después—, no por porcentaje.
6. Conmutar Caddy, correr el smoke y observar siete días.

## Evidencia

En [`evidence/`](../../evidence/): qué se ejecutó, con qué resultado y en qué commit.
