/**
 * La cola durable, y lo que la hace segura.
 *
 * Lo que se prueba aquí no es que una cola encole —eso lo hace cualquiera— sino los dos
 * invariantes que justifican despertarla: que no puede haber dos trabajos vivos sobre el mismo
 * recurso, y que la marca de agua viaja con el encolado para que el que recupere pueda saber si
 * el turno llegó a escribir algo.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/platform/db.js';
import { backoffMs, JobRepository } from '../src/platform/jobs.js';

const NOW = '2026-09-06T10:00:00.000Z';
const LUEGO = '2026-09-06T10:00:30.000Z';

let jobs: JobRepository;
/** La misma base que usa el repositorio: hace falta para probar lo que impone el esquema. */
let db: ReturnType<typeof openDatabase>;

beforeEach(() => {
  // `openDatabase` abre; migrar es aparte y aquí hace falta, que es lo que da la tabla `jobs`.
  db = openDatabase({ path: ':memory:' });
  migrate(db);
  jobs = new JobRepository(db);
});

const encolar = (resourceId = 'c1', watermarkSeq: number | null = 4) => jobs.enqueue({
  kind: 'chat.turn', resourceType: 'conversation', resourceId, watermarkSeq, at: NOW,
});

describe('JOBS · un trabajo vivo por recurso', () => {
  it('pedir dos veces lo mismo devuelve el que ya estaba, no uno nuevo', () => {
    const primero = encolar();
    const segundo = encolar();

    // Pedir dos veces mientras lo primero sigue pendiente no es un error: es impaciencia, y la
    // respuesta correcta es «ya está pedido».
    expect(segundo.id).toBe(primero.id);
    expect(jobs.counts().ready).toBe(1);
  });

  it('y si alguien se salta el repositorio, lo impide la base', () => {
    encolar();
    /*
     * El invariante es del esquema, no del código que lo consulta.
     *
     * `enqueue()` mira antes si hay uno vivo, así que la prueba de arriba pasaría igual sin
     * índice: comprobaría la consulta, no la garantía. Esto escribe directamente en la tabla, que
     * es lo que haría una ruta futura que no supiera de esta regla.
     */
    const aDedo = (): void => {
      db.prepare(`
        INSERT INTO jobs (id, kind, resource_type, resource_id, status, available_at,
                          attempts, max_attempts, created_at, updated_at)
        VALUES ('j-a-dedo', 'chat.turn', 'conversation', 'c1', 'ready', ?, 0, 5, ?, ?)
      `).run(NOW, NOW, NOW);
    };
    expect(aDedo).toThrow(/UNIQUE/i);
  });

  it('pero si el hilo ha avanzado, la marca de agua se mueve con él', () => {
    /*
     * R-08: un segundo mensaje mientras el asistente piensa.
     *
     * No hay trabajo nuevo —el invariante lo impide y está bien así— pero el que hay tiene que
     * cubrir lo que se acaba de pedir. Si la marca se quedara en el punto del primer mensaje,
     * `reconcile()` compararía con un `seq` que el primer turno ya subió al escribir, concluiría
     * que ese trabajo escribió y lo abandonaría: la segunda pregunta no se contesta nunca.
     *
     * Mi prueba de arriba daba por buena esa situación porque sólo miraba que no hubiera dos
     * trabajos. Lo comprobaba, y no comprobaba lo que el trabajo prometía cubrir.
     */
    const primero = encolar('c1', 0);
    const segundo = encolar('c1', 3);

    expect(segundo.id).toBe(primero.id);
    expect(segundo.watermarkSeq).toBe(3);
  });

  it('y sólo hacia delante: dos mensajes rápidos no la hacen retroceder', () => {
    encolar('c1', 5);
    expect(encolar('c1', 2).watermarkSeq).toBe(5);
  });

  it('dos conversaciones distintas sí tienen cada una el suyo', () => {
    expect(encolar('c1').id).not.toBe(encolar('c2').id);
    expect(jobs.counts().ready).toBe(2);
  });

  it('cuando el anterior termina, se puede volver a encolar', () => {
    const primero = encolar();
    jobs.finish(primero.id, NOW);

    const segundo = encolar();
    expect(segundo.id).not.toBe(primero.id);
    // Y el viejo sigue ahí: los terminados son el historial de lo que pasó, no basura.
    expect(jobs.counts().done).toBe(1);
    expect(jobs.counts().ready).toBe(1);
  });
});

describe('JOBS · coger, terminar y reintentar', () => {
  it('coger uno lo marca en marcha y cuenta el intento', () => {
    const encolado = encolar();
    const cogido = jobs.claim('chat.turn', NOW);

    expect(cogido?.id).toBe(encolado.id);
    expect(cogido?.status).toBe('running');
    // El intento se cuenta al cogerlo y no al fallar: si el proceso muere a mitad, ese intento
    // ocurrió aunque nadie llegara a escribir que salió mal.
    expect(cogido?.attempts).toBe(1);
  });

  it('no se coge lo que todavía no toca', () => {
    const encolado = encolar();
    jobs.retry(encolado.id, 'se cayó', NOW, '2026-09-06T10:05:00.000Z');

    expect(jobs.claim('chat.turn', LUEGO)).toBeNull();
    expect(jobs.claim('chat.turn', '2026-09-06T10:05:00.000Z')?.id).toBe(encolado.id);
  });

  it('no se coge lo de otro tipo de trabajo', () => {
    encolar();
    expect(jobs.claim('otra.cosa', NOW)).toBeNull();
  });

  it('cuando se agotan los intentos deja de reencolarse', () => {
    const encolado = jobs.enqueue({
      kind: 'chat.turn', resourceType: 'conversation', resourceId: 'c1', at: NOW, maxAttempts: 2,
    });

    jobs.claim('chat.turn', NOW);
    expect(jobs.retry(encolado.id, 'una', NOW, NOW).status).toBe('ready');
    jobs.claim('chat.turn', NOW);
    const rendido = jobs.retry(encolado.id, 'y dos', NOW, NOW);

    expect(rendido.status).toBe('failed');
    expect(rendido.lastError).toContain('y dos');
    // Y como ya no está vivo, el recurso queda libre para volver a pedir.
    expect(encolar().id).not.toBe(encolado.id);
  });

  it('lo que no se debe rehacer se abandona, sin gastar intentos ni esperar', () => {
    const encolado = encolar();
    jobs.claim('chat.turn', NOW);
    jobs.abandon(encolado.id, 'el turno ya había escrito', NOW);

    expect(jobs.require(encolado.id).status).toBe('failed');
    expect(jobs.require(encolado.id).lastError).toContain('ya había escrito');
  });
});

describe('JOBS · la marca de agua y la recuperación', () => {
  it('el punto desde el que se encoló viaja con el trabajo', () => {
    const encolado = encolar('c1', 7);
    expect(encolado.watermarkSeq).toBe(7);
    // Y sobrevive a cogerlo, que es cuando hace falta leerla.
    expect(jobs.claim('chat.turn', NOW)?.watermarkSeq).toBe(7);
  });

  it('un trabajo sin hilo detrás no la necesita', () => {
    expect(encolar('c1', null).watermarkSeq).toBeNull();
  });

  it('los que quedaron en marcha se pueden recuperar al arrancar', () => {
    encolar('c1');
    encolar('c2');
    jobs.claim('chat.turn', NOW);

    // Uno cogido y otro esperando: sólo el primero es un huérfano de un proceso que murió.
    const huerfanos = jobs.orphans('chat.turn');
    expect(huerfanos).toHaveLength(1);
    expect(huerfanos[0]?.resourceId).toBe('c1');
  });
});

describe('JOBS · cuánto se espera antes de reintentar', () => {
  it('crece con cada intento', () => {
    expect(backoffMs(0)).toBe(2_000);
    expect(backoffMs(1)).toBe(4_000);
    expect(backoffMs(3)).toBe(16_000);
  });

  it('y tiene techo, porque una conversación que se reanuda media hora después ya no sirve', () => {
    expect(backoffMs(10)).toBe(300_000);
    expect(backoffMs(100)).toBe(300_000);
  });
});
