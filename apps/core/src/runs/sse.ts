/**
 * SSE: la proyección del event log hacia el navegador.
 *
 * `Last-Event-ID` significa «el último seq que ya procesé», así que el servidor manda estrictamente
 * lo que va después. Reconectar no toca el run, y desconectar sólo quita la suscripción: el
 * proceso sigue en el host y sus eventos ya están confirmados en SQLite.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { isTerminalStatus } from '@jarvis/contracts';
import type { RunService } from './service.js';

const KEEPALIVE_MS = 15_000;
/** Un listener lento no puede hacer crecer la memoria sin límite: se le corta antes. */
const MAX_PENDING_BYTES = 8 * 1024 * 1024;

export function streamRunEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  runs: RunService,
  runId: string,
): void {
  const run = runs.require(runId);

  const header = request.headers['last-event-id'];
  const fromQuery = (request.query as { lastEventId?: string } | undefined)?.lastEventId;
  const raw = header ?? fromQuery;
  const lastSeq = Number.parseInt(String(raw ?? '-1'), 10);
  let cursor = Number.isFinite(lastSeq) ? lastSeq : -1;

  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  reply.raw.flushHeaders?.();

  let closed = false;
  const write = (chunk: string): void => {
    if (closed) return;
    reply.raw.write(chunk);
    // `writableLength` es lo que el socket todavía no ha podido enviar: si crece, el cliente no
    // está leyendo y lo correcto es soltarlo, no acumular su historia en memoria.
    if (reply.raw.writableLength > MAX_PENDING_BYTES) {
      write(`event: jarvis.dropped\ndata: {"reason":"slow consumer"}\n\n`);
      close();
    }
  };

  const flush = (): void => {
    if (closed) return;
    const events = runs.events(runId, cursor);
    for (const event of events) {
      cursor = event.seq;
      write(`id: ${event.seq}\nevent: run.event\ndata: ${JSON.stringify(event)}\n\n`);
    }
    const current = runs.find(runId);
    if (current && isTerminalStatus(current.status)) {
      write(`event: run.ended\ndata: ${JSON.stringify({ runId, status: current.status, lastSeq: cursor })}\n\n`);
      close();
    }
  };

  const unsubscribe = runs.bus.subscribe(runId, () => flush());
  // Comentario de keepalive, no un evento falso: un cliente no debe recibir datos que no ocurrieron.
  const keepalive = setInterval(() => write(': keepalive\n\n'), KEEPALIVE_MS);
  keepalive.unref?.();

  function close(): void {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    unsubscribe();
    reply.raw.end();
  }

  request.raw.on('close', close);
  reply.raw.on('error', close);

  // El replay inicial va después de registrar el listener: así un evento que llegue justo ahora
  // no se pierde entre medias.
  flush();
  if (!closed && isTerminalStatus(run.status)) {
    // Ya estaba terminado antes de suscribirse: `flush` ya mandó el cierre.
  }
}
