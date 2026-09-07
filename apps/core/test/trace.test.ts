/**
 * La traza de una conversación, con las formas de fallo que trae producción y no las que uno
 * imaginaría.
 *
 * El caso que la motivó: `c94zth2lpnktkrqx8`, dieciocho minutos, 34 herramientas y **12 fallos**.
 * Doce fallos repartidos en dos formas distintas, y ése es el detalle que hace o rompe esto: el
 * core contesta `{ok:false, error:{code,message}}` y el MCP contesta `{ok:false, content:"Error
 * calling tool …"}`. Una traza que mire sólo `error.code` deja fuera justo los de la máquina de al
 * lado —allowlist y permisos—, que ahí eran la mitad.
 */
import { describe, expect, it } from 'vitest';
import { traceOf } from '../src/chat/trace.js';

let seq = 0;
const at = (segundos: number): string => new Date(Date.UTC(2026, 8, 7, 10, 30, segundos)).toISOString();

const user = (text: string, s: number) => ({ role: 'user', seq: (seq += 1), createdAt: at(s), text });
const tool = (name: string, ok: boolean, text: string, s: number) =>
  ({ role: 'tool', seq: (seq += 1), createdAt: at(s), text, toolName: name, toolOk: ok });
const answer = (text: string, s: number, modelId = 'gpt-5-nano+gpt-5') =>
  ({ role: 'assistant', seq: (seq += 1), createdAt: at(s), text, modelId });

describe('TRAZA · lo que hizo el asistente y por qué falló', () => {
  it('agrupa por turnos y cuenta lo que tardó cada uno', () => {
    seq = 0;
    const trace = traceOf([
      user('hola', 0),
      tool('get_health', true, '{"ok":true}', 3),
      answer('buenas', 10),
      user('mira el disco', 20),
      tool('zeus.disk_usage', true, '{"ok":true}', 25),
      answer('887G libres', 40),
    ] as never);

    expect(trace.turns).toHaveLength(2);
    expect(trace.turns[0]?.ms).toBe(10_000);
    expect(trace.turns[1]?.ms).toBe(20_000);
    // El hueco entre herramientas es lo que de verdad se nota esperando, así que se guarda por
    // llamada y no sólo el total del turno.
    expect(trace.turns[1]?.tools[0]?.ms).toBe(5_000);
    expect(trace.turns[0]?.model).toBe('gpt-5-nano+gpt-5');
    expect(trace.totals).toMatchObject({ turns: 2, tools: 2, failed: 0, ms: 30_000 });
  });

  it('lee el fallo del core y el del MCP, que no viven en el mismo sitio', () => {
    seq = 0;
    const trace = traceOf([
      user('reinicia nginx', 0),
      tool('request_capability', false,
        '{"ok":false,"error":{"code":"NOT_FOUND","message":"no existe la capacidad server.status"}}', 2),
      tool('zeus.service_logs', false,
        JSON.stringify({ ok: false, name: 'zeus.service_logs',
          content: "Error calling tool 'service_logs': service not in MCP_SERVICE_ALLOWLIST: nginx.service" }), 5),
      answer('no he podido', 9),
    ] as never);

    const [delCore, delMcp] = trace.turns[0]!.tools;
    expect(delCore).toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
    expect(delCore?.error).toContain('server.status');
    /*
     * El del MCP no trae código y su frase está en `content`. Se le pone `DEL_SERVIDOR` en el
     * recuento para que no se mezcle con los del core: son problemas distintos —uno es el modelo
     * inventando, el otro es la casa diciendo que no— y arreglarlos es distinto.
     */
    expect(delMcp).toMatchObject({ ok: false, errorCode: null });
    expect(delMcp?.error).toContain('MCP_SERVICE_ALLOWLIST');
    expect(trace.totals.byError).toEqual({ NOT_FOUND: 1, DEL_SERVIDOR: 1 });
    expect(trace.totals.byError['DEL_SERVIDOR']).toBe(1);
  });

  it('cinco capacidades inventadas se ven como un problema, no como cinco', () => {
    seq = 0;
    const inventadas = ['server.status', 'server.hello', 'server.capabilities'];
    const trace = traceOf([
      user('qué puedes hacer', 0),
      ...inventadas.map((nombre, i) => tool('request_capability', false,
        `{"ok":false,"error":{"code":"NOT_FOUND","message":"no existe la capacidad ${nombre}"}}`, 2 + i)),
      answer('pues…', 10),
    ] as never);

    // Es el resumen que convierte dieciocho minutos de hilo en una frase: la misma herramienta,
    // el mismo código, tres veces. No son tres fallos que investigar, es uno.
    expect(trace.totals.byTool).toEqual({ request_capability: 3 });
    expect(trace.totals.byError).toEqual({ NOT_FOUND: 3 });
    expect(trace.turns[0]?.failed).toBe(3);
  });

  it('un turno sin pregunta delante no se pierde: se le abre uno propio', () => {
    seq = 0;
    const trace = traceOf([
      tool('get_health', true, '{"ok":true}', 1),
      answer('el servidor se reinició mientras pensaba', 2),
    ] as never);

    // Pasa de verdad: un turno reanudado tras un reinicio, o un evento del sistema. Descartarlo
    // haría que la traza no explicara justo las conversaciones que peor acabaron.
    expect(trace.turns).toHaveLength(1);
    expect(trace.turns[0]?.ask).toContain('sin pregunta');
    expect(trace.totals.tools).toBe(1);
  });

  it('dos respuestas seguidas son un turno, no dos: nada de filas vacías', () => {
    seq = 0;
    const trace = traceOf([
      user('arréglalo', 0),
      tool('get_health', true, '{"ok":true}', 1),
      answer('te propongo un plan', 5),
      answer('aprobado, sigo', 6),
      answer('hecho', 7),
    ] as never);

    /*
     * Salió en el primer uso contra una conversación real: cuatro turnos de 0 s y 0 herramientas,
     * que eran mensajes del asistente seguidos. Inventaban idas y venidas que no hubo y ensuciaban
     * justo el recuento por el que se mira una traza.
     */
    expect(trace.turns).toHaveLength(1);
    expect(trace.turns[0]?.answer).toContain('hecho');
    expect(trace.totals.turns).toBe(1);
  });

  it('un cuerpo que no es JSON no rompe la traza', () => {
    seq = 0;
    const trace = traceOf([
      user('algo', 0),
      tool('lo_que_sea', false, 'esto no es json', 1),
      answer('ya', 2),
    ] as never);

    expect(trace.turns[0]?.tools[0]).toMatchObject({ ok: false, errorCode: null, error: null });
    expect(trace.totals.byError).toEqual({ DEL_SERVIDOR: 1 });
  });
});
