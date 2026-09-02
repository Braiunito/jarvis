/**
 * El stream de eventos de un run.
 *
 * `EventSource` reconecta solo y manda `Last-Event-ID`, que es exactamente el contrato del
 * servidor. El navegador deduplica por `(runId, seq)` como defensa: el servidor no debe producir
 * duplicados, pero una interfaz que los mostrara sería peor que una que los ignora.
 */
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { RunEvent } from '@jarvis/contracts';

export interface RunStreamState {
  events: RunEvent[];
  connected: boolean;
  ended: boolean;
  error: string | null;
}

export function useRunStream(runId: string | null): RunStreamState {
  const [state, setState] = useState<RunStreamState>({ events: [], connected: false, ended: false, error: null });
  const seen = useRef<Set<number>>(new Set());
  const client = useQueryClient();

  useEffect(() => {
    seen.current = new Set();
    setState({ events: [], connected: false, ended: false, error: null });
    if (!runId) return undefined;

    const source = new EventSource(`/events/runs/${runId}`);

    source.onopen = () => setState((previous) => ({ ...previous, connected: true, error: null }));

    source.addEventListener('run.event', (message) => {
      const event = JSON.parse((message as MessageEvent<string>).data) as RunEvent;
      if (seen.current.has(event.seq)) return;
      seen.current.add(event.seq);
      setState((previous) => ({ ...previous, events: [...previous.events, event] }));
      // Un cambio de estado se ve en el stream antes que en ninguna consulta: refrescarlo aquí
      // es lo que evita que el resto de la pantalla siga diciendo «en cola».
      if (event.type === 'run.status') {
        void client.invalidateQueries({ queryKey: ['run', runId] });
        void client.invalidateQueries({ queryKey: ['runs'] });
        void client.invalidateQueries({ queryKey: ['workspace'] });
      }
    });

    source.addEventListener('run.ended', () => {
      setState((previous) => ({ ...previous, ended: true, connected: false }));
      void client.invalidateQueries({ queryKey: ['run', runId] });
      void client.invalidateQueries({ queryKey: ['runs'] });
      void client.invalidateQueries({ queryKey: ['workspace'] });
      source.close();
    });

    source.onerror = () => {
      // Un error aquí casi siempre es una reconexión en curso: EventSource lo reintenta solo con
      // el último id, así que no se pinta como fallo salvo que el run ya hubiera terminado.
      setState((previous) => previous.ended ? previous : { ...previous, connected: false });
    };

    return () => source.close();
  }, [runId, client]);

  return state;
}
