/**
 * El plan vivo de una conversación, para que el hilo pueda decir que lo tiene.
 *
 * El caso: Braian aprobó un plan, el plan ató su primer paso como **una pregunta al usuario**, y
 * esa pregunta no se publicó en ningún sitio. Lo último que se leía era «Autorizado. El plan queda
 * en marcha», y dos minutos después él escribiendo «Autorice el plan». Estaba esperando algo que
 * nadie le enseñó, y el plan sigue ahí horas después.
 *
 * jarvis-f9 pone que el motor **narre** lo que hace. Esto es la otra mitad y no la sustituye: un
 * mensaje que no se emitió —o que se emitió antes de que alguien mirara— es invisible para siempre,
 * mientras que **el estado siempre es verdad**. Una conversación con un plan esperando respuesta lo
 * dice porque el plan lo dice, no porque alguien acertara a publicarlo.
 *
 * Lee la tabla del motor de planes desde el chat, que no es su sitio natural: la consulta debería
 * vivir en `PlanService`. Está aquí porque ese fichero lo está tocando otra sesión ahora mismo, y
 * un fichero nuevo no colisiona. Cuando quede libre, se muda.
 */
import type { Database as Db } from 'better-sqlite3';

export interface LivePlan {
  planId: string;
  status: string;
  objective: string;
  step: number;
  steps: number;
  /** Lo que el plan está esperando de la persona, si es que espera algo. */
  question: string | null;
}

/*
 * `draft` cuenta, y es lo que costó descubrir: un plan sin firmar **también** está esperando a la
 * persona, sólo que la tarjeta. Dejarlo fuera repetiría el fallo en otra forma — la conversación no
 * diría que hay algo pendiente justo cuando lo que falta es que alguien lo apruebe.
 */
const VIVOS = ['draft', 'ready', 'running', 'waiting_input', 'paused'];

/** Lo que la conversación tiene en marcha, o `null` si no tiene nada. */
export function livePlanOf(db: Db, conversationId: string): LivePlan | null {
  const marcadores = VIVOS.map(() => '?').join(',');
  const row = db.prepare(
    `SELECT p.id, p.status, p.objective, p.current_step,
            (SELECT count(*) FROM plan_steps s WHERE s.plan_id = p.id) AS steps,
            (SELECT s.title FROM plan_steps s
              WHERE s.plan_id = p.id AND s.status = 'waiting_input'
              ORDER BY s.ordinal LIMIT 1) AS question
     FROM plans p
     WHERE p.conversation_id = ? AND p.status IN (${marcadores})
     ORDER BY p.updated_at DESC LIMIT 1`,
  ).get(conversationId, ...VIVOS) as {
    id: string; status: string; objective: string; current_step: number;
    steps: number; question: string | null;
  } | undefined;

  if (!row) return null;
  return {
    planId: row.id,
    status: row.status,
    objective: row.objective,
    step: row.current_step,
    steps: row.steps,
    question: row.question ?? null,
  };
}
