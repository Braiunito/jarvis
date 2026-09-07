/**
 * Que una conversación pueda decir que tiene un plan esperándote.
 *
 * El caso real: se aprobó un plan, el plan ató su primer paso como **una pregunta al usuario**, y
 * esa pregunta no se publicó en el hilo. Lo último que se leía era «Autorizado. El plan queda en
 * marcha»; dos minutos después la persona escribía «Autorice el plan», esperando algo que nadie le
 * enseñó. Horas después el plan seguía ahí.
 *
 * Esto es la mitad que **no depende de que nadie publique nada**: el estado del plan siempre es
 * verdad, mientras que un mensaje que no se emitió es invisible para siempre.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { migrate, openDatabase } from '../src/platform/db.js';
import { livePlanOf } from '../src/chat/live-plan.js';

const NOW = '2026-09-07T10:45:00.000Z';
let db: Database;

const plan = (id: string, conversationId: string | null, status: string): void => {
  db.prepare(`INSERT INTO plans
    (id, workspace_id, created_by, objective, status, current_step, created_at, updated_at,
     autonomy, conversation_id)
    VALUES (?, NULL, 'braian', 'averiguar por qué falla la web', ?, 0, ?, ?, 'manual', ?)`)
    .run(id, status, NOW, NOW, conversationId);
};

const step = (planId: string, ordinal: number, status: string, title: string): void => {
  db.prepare(`INSERT INTO plan_steps
    (id, plan_id, ordinal, kind, status, title, input_json, idempotency_key, attempt)
    VALUES (?, ?, ?, 'input', ?, ?, '{}', ?, 1)`)
    .run(`s${planId}${ordinal}`, planId, ordinal, status, title, `k${planId}${ordinal}`);
};

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  // La base de una prueba tiene que ser la de producción: abrir no es migrar, y sin migrar no
  // existe ni la tabla que se consulta.
  migrate(db);
});

describe('PLAN VIVO · una conversación dice lo que tiene esperando', () => {
  it('un plan que espera respuesta se ve, y se ve **qué** pregunta', () => {
    plan('p1', 'c1', 'waiting_input');
    step('p1', 0, 'waiting_input', '¿Qué permisos de escritura hay que habilitar?');
    step('p1', 1, 'draft', 'Revisar el nginx');

    const vivo = livePlanOf(db, 'c1');

    // La pregunta es lo que de verdad hacía falta: sin ella la persona ve «hay un plan» y sigue sin
    // saber que le toca contestar.
    expect(vivo).toMatchObject({ planId: 'p1', status: 'waiting_input', steps: 2 });
    expect(vivo?.question).toContain('permisos de escritura');
  });

  it('un borrador sin firmar también cuenta: también te está esperando', () => {
    plan('p2', 'c2', 'draft');
    step('p2', 0, 'draft', 'Mirar el disco');

    /*
     * Es la decisión que más costó ver. Un plan en `draft` espera **la tarjeta**, no una respuesta,
     * pero espera a la misma persona. Dejarlo fuera repetiría el fallo en otra forma: la
     * conversación no diría que hay algo pendiente justo cuando lo que falta es aprobarlo.
     */
    expect(livePlanOf(db, 'c2')?.status).toBe('draft');
    expect(livePlanOf(db, 'c2')?.question).toBeNull();
  });

  it('uno terminado no se enseña: ya no espera a nadie', () => {
    plan('p3', 'c3', 'completed');
    step('p3', 0, 'completed', 'Hecho');

    expect(livePlanOf(db, 'c3')).toBeNull();
  });

  it('el plan de otra conversación no se cuela en la tuya', () => {
    plan('p4', 'otra', 'waiting_input');
    step('p4', 0, 'waiting_input', '¿Sigo?');

    // Parece obvio y es justo lo que un `WHERE` olvidado convierte en enseñar la pregunta de otro.
    expect(livePlanOf(db, 'c4')).toBeNull();
    expect(livePlanOf(db, 'otra')?.planId).toBe('p4');
  });

  it('sin plan no hay nada que enseñar, y no es un error', () => {
    expect(livePlanOf(db, 'c-sin-plan')).toBeNull();
  });
});
