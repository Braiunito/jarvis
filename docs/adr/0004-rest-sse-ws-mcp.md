# ADR-004 · Un transporte por necesidad; MCP es adaptador de modelo, no API de UI

Fecha: 2026-09-02 · Estado: aceptado

## Decisión

| Necesidad | Transporte | Regla |
|---|---|---|
| queries y comandos | REST JSON | mutaciones repetibles llevan `Idempotency-Key` |
| eventos de run/plan | SSE | `id: <seq>`, `Last-Event-ID`, replay desde SQLite |
| terminal | WebSocket | sólo TTY; resize/input son frames propios |
| adjuntos | HTTP binario en streaming | cuota reservada antes del stream |
| core ↔ aiSessions | HTTP interno | token interno, timeout, estado de circuito visible |

REST y las tools del Assistant llaman **al mismo caso de uso**. MCP no contiene lógica: es un
adaptador opcional para modelos externos. El navegador nunca habla MCP.

SSE es proyección del event log, nunca su fuente: desconectar un listener no altera el run.

## Consecuencias

- Un bug de dominio se arregla en un sitio y vale para las dos entradas.
- Los errores llevan `code`/`scope`/`retryable`/`requestId`; la UI nunca discrimina por `message`.
