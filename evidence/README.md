# Evidencia de los gates

Qué se ejecutó, con qué resultado y dónde mirarlo. No hay capturas ni logs con secretos: sólo
comandos reproducibles y lo que devolvieron.

El entorno de estas pruebas es una máquina de desarrollo con el `ssh` del testkit, que **ejecuta
de verdad en local**: tmux real, spool real, ficheros reales. Los agentes son dobles; el resto no.
Lo que no se puede probar aquí es lo que exige el bastión y sus hosts (fases M6 y M7).

| Gate | Qué exigía | Evidencia |
|---|---|---|
| M0 | contratos congelados y suite offline | [M0.md](M0.md) |
| M1 | límite de confianza, imágenes y compose | [M1.md](M1.md) |
| M2 | flota y sesiones sin escribir nada | [M2.md](M2.md) |
| M3 | trabajo directo durable | [M3.md](M3.md) |
| M4 | Assistant, terminal y diagnóstico | [M4.md](M4.md) |
| M5 | importación y copia de seguridad | [M5.md](M5.md) |
