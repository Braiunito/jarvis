/**
 * El hilo de una conversación, en directo.
 *
 * Mismo contrato que el stream de un run —`id: <seq>`, `Last-Event-ID`, replay desde la base— y
 * por el mismo motivo: reconectar tiene que rellenar el hueco exacto, ni repetir ni saltarse nada.
 * `EventSource` reconecta solo y manda el último id que vio, así que aquí no hay que reintentar a
 * mano; lo único que se añade es la deduplicación por `seq`, como defensa.
 *
 * El estado de la conversación llega por un evento aparte (`chat.state`) y no como un mensaje:
 * «pensando» no es algo que nadie haya dicho, y meterlo en el hilo dejaría un rastro de burbujas
 * vacías en el histórico.
 */
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ChatArtifact, ChatMessage } from '@jarvis/contracts';

export interface ChatStreamState {
  messages: ChatMessage[];
  /**
   * Los cuerpos de los artifacts `inline` que venían pegados al mensaje.
   *
   * Llegan por aquí y no por una consulta aparte a propósito. El mensaje trae **punteros**, y si
   * el cuerpo hubiera que pedirlo, el turno que acabas de esperar treinta segundos pintaría el
   * bloque vacío hasta que algo disparara un refetch —y la consulta del hilo tiene
   * `refetchOnWindowFocus: false`, así que podría no dispararse nunca—. El caso de entrar a una
   * conversación ya escrita lo cubre la carga inicial; éste es el que se ve todos los días.
   */
  artifacts: ChatArtifact[];
  status: string | null;
  /**
   * Con cuánto esfuerzo está pensando ahora mismo.
   *
   * Nulo cuando no está pensando y cuando el esfuerzo no lo decide él. Llega por el estado y no
   * por el mensaje porque lo interesante es **verlo mientras pasa**: la pasada previa que lo elige
   * no deja rastro en el hilo, así que si no se ve aquí no se ve en ninguna parte.
   */
  effort: string | null;
  source: string | null;
  autonomy: string | null;
  title: string | null;
  connected: boolean;
}

const EMPTY: ChatStreamState = {
  messages: [], artifacts: [], status: null, effort: null, source: null, autonomy: null,
  title: null, connected: false,
};

export function useChatStream(conversationId: string | null): ChatStreamState {
  const [state, setState] = useState<ChatStreamState>(EMPTY);
  const seen = useRef<Set<number>>(new Set());
  const client = useQueryClient();

  useEffect(() => {
    seen.current = new Set();
    setState(EMPTY);
    if (!conversationId) return undefined;

    const source = new EventSource(`/events/chat/${conversationId}`);
    source.onopen = () => setState((previous) => ({ ...previous, connected: true }));

    source.addEventListener('chat.message', (event) => {
      /*
       * El frame es aditivo: `data` sigue siendo el `ChatMessage` de siempre y sólo aparece una
       * clave `artifacts` cuando el turno produjo alguno `inline`.
       */
      const payload = JSON.parse((event as MessageEvent<string>).data) as
        ChatMessage & { artifacts?: ChatArtifact[] };
      const { artifacts = [], ...message } = payload;
      if (seen.current.has(message.seq)) return;
      seen.current.add(message.seq);
      setState((previous) => ({
        ...previous,
        messages: [...previous.messages, message],
        ...(artifacts.length ? { artifacts: [...previous.artifacts, ...artifacts] } : {}),
      }));
      /*
       * Un mensaje puede traer una aprobación o un trabajo recién lanzado, y esos viven en otras
       * consultas. Refrescarlas aquí es lo que evita que la tarjeta de permiso tarde en aparecer
       * o que el contador de trabajos siga diciendo lo de antes.
       */
      if (message.approvalId) {
        void client.invalidateQueries({ queryKey: ['conversation', conversationId] });
      }
      if (message.runIds.length) {
        void client.invalidateQueries({ queryKey: ['runs'] });
      }
    });

    source.addEventListener('chat.state', (event) => {
      const next = JSON.parse((event as MessageEvent<string>).data) as {
        status: string; source: string; autonomy: string; title: string; effort?: string | null;
      };
      setState((previous) => ({ ...previous, ...next }));
      // El estado también cambia la lista de la izquierda: el título y quién está pensando.
      void client.invalidateQueries({ queryKey: ['conversations'] });
    });

    source.onerror = () => {
      // Casi siempre es una reconexión en curso, que `EventSource` ya está haciendo con el último
      // id. Pintarlo como fallo asustaría por algo que se arregla solo en un segundo.
      setState((previous) => ({ ...previous, connected: false }));
    };

    return () => source.close();
  }, [conversationId, client]);

  return state;
}
