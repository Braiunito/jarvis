# ADR-002 · SQLite en un nodo, con umbrales explícitos para PostgreSQL

Fecha: 2026-09-02 · Estado: aceptado

## Contexto

El despliegue es un bastión con un core. Los datos operativos son metadata pequeña y un event log.
Las operaciones lentas son SSH, CLIs y modelos, nunca la base.

## Decisión

SQLite en volumen local del core, con `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`
y `busy_timeout=5000`. Driver `better-sqlite3` con SQLite embebido **>= 3.51.3** (bug de reset WAL
corregido ahí); el arranque verifica la versión y falla si es menor. SQL explícito, sin ORM.
Migraciones SQL numeradas con checksum en `schema_migrations`.

Prohibido: montar el fichero sobre NFS/SMB, abrirlo desde el gateway o desde un sidecar, y
mantener una transacción abierta mientras se espera a SSH o a un modelo.

## Umbrales para migrar a PostgreSQL

Se evalúa el cambio si alguno se sostiene:

1. hace falta más de un core activo por disponibilidad;
2. la contención de escritura afecta al p95 de comandos;
3. la cola queda limitada por capacidad del nodo más de 15 minutos seguidos;
4. workers en hosts distintos deben consumir los mismos jobs;
5. la política de backup/HA ya no cabe en un nodo.

## Consecuencias

- Cero servicios extra y transacciones fuertes desde el día uno.
- La capa de repositorio se diseña para que el cambio sea de persistencia, no de casos de uso.
