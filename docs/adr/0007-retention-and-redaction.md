# ADR-007 · Retención y redacción

Fecha: 2026-09-02 · Estado: aceptado

## Retención inicial

| Recurso | Política |
|---|---|
| run activo | sin compactar |
| run terminado < 7 días | eventos completos, con límite por evento |
| 7–30 días | compactar payload pesado (tool/output): se conserva `seq`, tipo, digest y resumen |
| > 30 días | run + eventos estructurales; export opcional |
| attachment `staged` | TTL 6 h |
| attachment `claimed` | hasta estado terminal del run + limpieza |
| usage | TTL 5 min, last-known-good indefinido con `stale: true` |
| audit | no se borra automáticamente durante M0–M6 |

Budgets iniciales (M0-10): evento ≤ 256 KiB tras truncado; salida de tool ≤ 32 KiB por evento;
texto acumulado por run ≤ 2 MiB; attachment ≤ 20 MiB; cuota de contexto ≤ 50 MiB; concurrencia de
runs 4; arranque del core < 2 s con base vacía; bundle inicial del front < 400 KiB gzip.

Nada se trunca en silencio: todo payload recortado lleva bandera y tamaño original.

## Redacción

Nunca se registran ni se telemetrizan: prompts completos, salida completa del agente, cookies,
tokens, API keys, material TOTP/passkey, contenido de adjuntos ni paths privados que no hagan
falta para diagnosticar.

`copiar diagnóstico` produce un documento con: versiones, health por salto, ids de request/run,
códigos de error y target efectivo. Nunca texto del usuario ni del agente.

Las métricas operativas se agregan localmente. No hay telemetría externa.
