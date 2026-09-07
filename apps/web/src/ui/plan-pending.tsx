/**
 * Un plan que espera algo tuyo, dicho donde estás mirando.
 *
 * El caso que lo trae: Braian aprobó un plan, el plan ató su primer paso como **una pregunta a la
 * persona**, y esa pregunta no apareció en ninguna parte. Lo último que se leía era «Autorizado. El
 * plan queda en marcha»; dos minutos después él escribía «Autorice el plan», esperando algo que
 * nadie le había enseñado. Horas más tarde el plan seguía parado esperándole.
 *
 * Por eso esto no es una fila más del hilo: una pregunta pendiente se lee como una pregunta y trae
 * dónde contestarla. Va anclado al compositor —el mismo sitio que la tarjeta de permiso— porque es
 * la misma clase de cosa: el hilo no avanza hasta que la persona haga algo.
 *
 * Sale del **estado** del plan y no de un mensaje. Un mensaje que no se emitió es invisible para
 * siempre; el estado sigue siendo verdad aunque la narración se pierda un evento.
 */
import { useState, type JSX } from 'react';
import { Glyph, ACTION_ICON } from './icons.jsx';

export interface LivePlan {
  planId: string;
  status: string;
  objective: string;
  step: number;
  steps: number;
  /** Lo que el plan espera de ti, si espera algo. */
  question: string | null;
}

/** Los estados en los que el plan no avanza hasta que la persona haga algo. */
export const planEspera = (plan: LivePlan | null): boolean =>
  plan !== null && (plan.status === 'waiting_input' || plan.status === 'draft');

export function PlanPending({ plan, pending, error, onAnswer, onOpen }: {
  plan: LivePlan;
  pending: boolean;
  error: Error | null;
  onAnswer: (answer: string) => void;
  onOpen: () => void;
}): JSX.Element {
  const [answer, setAnswer] = useState('');
  const firma = plan.status === 'draft';

  return (
    <div className={`chat-plan-pending ${firma ? 'firma' : ''}`} role="status">
      <div className="row">
        <Glyph icon={ACTION_ICON.timer} size={16} />
        <strong>{firma ? 'Un plan espera tu firma' : 'El plan te está preguntando'}</strong>
        {/* Cuánto queda, que es lo que dice si esto va para largo. */}
        <span className="tiny faint">paso {plan.step + 1} de {plan.steps}</span>
      </div>

      <p className="chat-plan-question">{firma ? plan.objective : plan.question}</p>

      {firma ? (
        <button type="button" className="btn small" onClick={onOpen}>Ver el plan</button>
      ) : (
        <form
          className="chat-plan-answer"
          onSubmit={(event) => {
            event.preventDefault();
            const texto = answer.trim();
            if (texto) onAnswer(texto);
          }}
        >
          <input
            className="input"
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder="Tu respuesta para el plan"
            aria-label="Respuesta para el plan"
            disabled={pending}
          />
          <button type="submit" className="btn small primary" disabled={pending || !answer.trim()}>
            {pending ? 'Enviando…' : 'Responder'}
          </button>
        </form>
      )}

      {/*
        * Un fallo al contestar no puede quedarse callado: si la respuesta no llegó, el plan sigue
        * esperando y la persona creería que ya está.
        */}
      {error ? <p className="note danger tiny">{error.message}</p> : null}
    </div>
  );
}
