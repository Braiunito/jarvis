/**
 * N01: un cliente que no lee no puede llevarse por delante el core.
 *
 * El corte por consumidor lento existía y estaba bien pensado: si el socket acumula, se suelta. Lo
 * que no estaba bien es **cómo** se avisaba — el aviso volvía a entrar por la misma función que
 * comprueba el umbral, con el buffer todavía lleno, así que la comprobación daba verdadero otra
 * vez y nunca se alcanzaba el cierre. Eso no acaba en una conexión rota: acaba en
 * `RangeError: Maximum call stack size exceeded` dentro de un callback del bus de eventos, o sea
 * tumbando el proceso que sirve a todos los demás.
 *
 * Por eso esta prueba no mira el mensaje de aviso: cuenta escrituras, cierres y desuscripciones.
 */
import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { streamRunEvents } from '../src/runs/sse.js';
import type { RunService } from '../src/runs/service.js';

const NOW = '2026-09-02T12:00:00.000Z';

/** Una respuesta cuyo socket nunca vacía: `writableLength` se queda por encima del tope. */
function fakeReply({ pending, throwOnWrite = false }: { pending: number; throwOnWrite?: boolean }) {
  const writes: string[] = [];
  let ended = 0;
  const raw = {
    writeHead: vi.fn(),
    flushHeaders: vi.fn(),
    write: (chunk: string) => {
      if (throwOnWrite) throw new Error('socket hung up');
      writes.push(chunk);
      return true;
    },
    end: () => { ended += 1; },
    on: vi.fn(),
    get writableLength() { return pending; },
  };
  return { reply: { raw } as unknown as FastifyReply, writes, ended: () => ended, raw };
}

function fakeRequest() {
  return { headers: {}, query: {}, raw: { on: vi.fn() } } as unknown as FastifyRequest;
}

/** Un run con un evento pendiente y estado no terminal: el caso normal de un stream vivo. */
function fakeRuns(): { runs: RunService; notify: () => void; unsubscribed: () => number } {
  let listener: (() => void) | null = null;
  let unsubscribed = 0;
  const runs = {
    require: () => ({ id: 'r1', status: 'running' }),
    find: () => ({ id: 'r1', status: 'running' }),
    events: () => [{ seq: 0, runId: 'r1', type: 'agent.text', at: NOW, payload: { text: 'hola' } }],
    bus: {
      subscribe: (_runId: string, fn: () => void) => {
        listener = fn;
        return () => { unsubscribed += 1; };
      },
    },
  } as unknown as RunService;
  return { runs, notify: () => listener?.(), unsubscribed: () => unsubscribed };
}

describe('N01 · el consumidor lento se suelta, y sólo él', () => {
  it('un socket saturado se corta una vez, sin recursión y sin excepción', () => {
    const { reply, writes, ended } = fakeReply({ pending: 9 * 1024 * 1024 });
    const { runs, unsubscribed } = fakeRuns();

    // Antes esto no volvía: recurría hasta agotar la pila.
    expect(() => streamRunEvents(fakeRequest(), reply, runs, 'r1')).not.toThrow();

    // Un evento y su aviso. Ni una sola escritura más: es lo que prueba que no hubo reentrada.
    expect(writes.filter((chunk) => chunk.includes('jarvis.dropped'))).toHaveLength(1);
    expect(writes).toHaveLength(2);
    expect(ended()).toBe(1);
    expect(unsubscribed()).toBe(1);
  });

  it('una notificación posterior no vuelve a escribir en un stream ya cortado', () => {
    const { reply, writes, ended } = fakeReply({ pending: 9 * 1024 * 1024 });
    const { runs, notify } = fakeRuns();
    streamRunEvents(fakeRequest(), reply, runs, 'r1');
    const antes = writes.length;

    notify();
    notify();

    expect(writes).toHaveLength(antes);
    // Y no se cierra dos veces: `close` es idempotente y el contador lo demuestra.
    expect(ended()).toBe(1);
  });

  it('un socket que revienta al escribir cierra en vez de propagar la excepción', () => {
    const { reply, ended } = fakeReply({ pending: 0, throwOnWrite: true });
    const { runs, unsubscribed } = fakeRuns();

    // Esto ocurre dentro de un callback del bus: una excepción aquí sube a donde nadie la espera.
    expect(() => streamRunEvents(fakeRequest(), reply, runs, 'r1')).not.toThrow();
    expect(ended()).toBe(1);
    expect(unsubscribed()).toBe(1);
  });

  it('un cliente que sí lee recibe sus eventos y sigue abierto', () => {
    const { reply, writes, ended } = fakeReply({ pending: 1024 });
    const { runs } = fakeRuns();
    streamRunEvents(fakeRequest(), reply, runs, 'r1');

    expect(writes.some((chunk) => chunk.includes('agent.text'))).toBe(true);
    expect(writes.some((chunk) => chunk.includes('jarvis.dropped'))).toBe(false);
    expect(ended()).toBe(0);
  });
});
