# ADR-005 · Identidad: `SessionRef` la posee el CLI remoto, el workspace lo posee el core

Fecha: 2026-09-02 · Estado: aceptado

## Decisión

```
SessionRef = { host, provider, sessionId }
Workspace  = workspaceId -> exactamente una SessionRef (MVP)
Run        = runId -> workspaceId + snapshot del target efectivo
Target     = { workHost, executionHost, strategy, cwd }
```

- El alias `local` que devuelve el índice se normaliza al alias del bastión **en el límite de
  entrada** y nunca se persiste.
- `UNIQUE(session_host, provider, session_id)` en `workspaces`: abrir dos veces la misma sesión
  devuelve el mismo workspace (idempotente).
- Un workspace conserva identidad aunque el índice esté stale o la sesión no aparezca en la
  página actual de resultados. Buscar **nunca** cambia el workspace activo.
- Jarvis no persiste rowids ni paths internos del índice: sólo `SessionRef`.
- El target de un run es un **snapshot**: se guarda lo que el usuario vio antes de Send y es lo
  que la auditoría afirma. No se recalcula al mostrar historial.

## Consecuencias

- Dos selecciones rápidas terminan en un único workspace coherente (regresión histórica).
- Si el MVP necesitara varias sesiones por workspace, se añade una tabla de vínculo sin cambiar
  la identidad existente.
