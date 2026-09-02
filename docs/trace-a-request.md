# Seguir una petición

Un clic en «Enviar», desde el navegador hasta el proceso en la máquina. Sirve para orientarse
cuando algo falla y no se sabe por dónde empezar a mirar.

## 1 · El navegador

`apps/web/src/screens/workspace.tsx` → `useCreateRun` → `POST /api/runs` con
`{ workspaceId, prompt, permissionProfile, idempotencyKey }`.

La clave de idempotencia se calcula del envío, no del render: un doble toque en el móvil manda la
misma y crea un solo run. El borrador **no** se limpia hasta que el servidor contesta.

## 2 · Caddy

Sólo termina TLS y reenvía. Para `/events/*` desactiva el búfer: si no, el stream de eventos se
queda acumulado por el camino y la interfaz parece congelada.

## 3 · El gateway

`apps/gateway/src/app.ts` intercepta las rutas del core **antes** que Fastify, en el servidor HTTP
crudo (`serverFactory`). Es la única forma de reenviar el cuerpo tal cual; en cuanto el framework
lo mira, el proxy se queda esperando bytes que ya nadie va a mandar.

Comprueba la cookie, resuelve la cuenta —una sesión sobrevive a un `jarvis-users disable`, así que
se revisa en cada petición—, **elimina la cookie** y añade `X-Jarvis-Identity` firmada.

## 4 · El core

`onRequest` verifica la firma o responde 401. Después:

`apps/core/src/runs/routes.ts` → `RunService.create`:

1. resuelve el destino (`resolveTarget`) y lo congela como snapshot;
2. escribe el run y reclama los adjuntos **en la misma transacción**;
3. registra el evento `run.target` y la entrada de auditoría —con el destino y el permiso, nunca
   con el prompt—;
4. devuelve `202` con el `runId`.

## 5 · El supervisor

`apps/core/src/runs/supervisor.ts`, cada 700 ms:

- `queued` → `RunService.prepare` → un único viaje SSH que crea el spool, escribe `meta.json` y
  `wrapper.sh` en base64 y arranca `tmux new-session`. Si la tmux ya existe, no lanza una segunda.
- `running` → poll: tamaño del spool, `status.json`, cola de `stderr` y el trozo nuevo desde
  `remote_cursor_bytes`. Se normaliza con el adapter y se confirma **evento + cursor + estado** en
  una transacción.

## 6 · El host

`wrapper.sh` corre dentro de tmux, escribe `events.ndjson`, y publica `status.json` con
`.tmp` + `mv`. Distingue cancelado de fallido por la presencia del marcador `cancel`, porque un
agente interrumpido sale con código distinto de cero y eso no es un error.

## 7 · La vuelta

`GET /events/runs/:id` con `Last-Event-ID` lee el event log de SQLite y manda estrictamente lo que
va después. Desconectarse no toca el run; reconectar no duplica nada.

## Dónde mirar cuando falla

| Se atasca en | Mirar |
|---|---|
| el 202 no llega | logs del gateway: ¿llegó la petición al core?, ¿había firma? |
| el run se queda en `queued` | `prepare` falla: ¿hay tmux en ese host?, ¿responde el ssh? |
| no llegan eventos | `events.ndjson` en el spool: ¿el agente escribió algo? |
| el run acaba `failed` sin explicación | `stderr.log` del spool; el core ya lo adjunta como evento |
| el estado no avanza en la interfaz | ¿el SSE está conectado?, ¿el navegador reconectó? |
