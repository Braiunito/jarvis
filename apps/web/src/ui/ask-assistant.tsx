/**
 * Preguntarle al asistente desde donde está el problema.
 *
 * El asistente sabe mirar la casa entera, pero llegar a él exigía cambiar de sección y volver a
 * contarle por escrito lo que ya se estaba mirando: el salto en rojo, el trabajo que falló, la
 * sesión que se tiene abierta. Eso es copiar a mano un contexto que la pantalla ya tiene.
 *
 * Así que el acceso es siempre el mismo gesto —una conversación nueva, sembrada con la pregunta y
 * atada al workspace cuando lo hay— y vive aquí una sola vez. Cuatro pantallas lo usan y ninguna
 * decide por su cuenta cómo se crea una conversación.
 *
 * El `workspaceId` no es decoración: sin él la conversación es sobre la casa, no alcanza el
 * trabajo de esa sesión y la terminal que acabe ofreciendo arranca en el home en vez de en la
 * carpeta donde está el problema.
 */
import type { JSX, ReactNode } from 'react';
import { useCreateConversation } from '../api/queries.js';
import { navigate } from '../router.js';
import { ErrorNote } from './bits.jsx';
import { Glyph, NAV_ICON } from './icons.jsx';

export interface AskAssistantInput {
  /** Va como primer mensaje: al llegar a la conversación el asistente ya está pensando. */
  prompt: string;
  /** Con workspace la conversación alcanza esa sesión y sabe en qué carpeta vive. */
  workspaceId?: string | null;
}

export interface AskAssistant {
  ask: (input: AskAssistantInput) => void;
  pending: boolean;
  error: unknown;
}

/** Crear la conversación y llevarte a ella. Es todo lo que hace, y por eso lo hace igual en todas partes. */
export function useAskAssistant(): AskAssistant {
  const create = useCreateConversation();
  return {
    ask: ({ prompt, workspaceId }) => {
      // Doble pulsación no son dos conversaciones: la primera todavía está creándose.
      if (create.isPending) return;
      create.mutate(
        { message: prompt, ...(workspaceId ? { workspaceId } : {}) },
        { onSuccess: ({ conversation }) => navigate(`/assistant/${conversation.id}`) },
      );
    },
    pending: create.isPending,
    error: create.error,
  };
}

/**
 * El botón, para no repetir el mismo JSX en cuatro sitios.
 *
 * Lleva el error pegado debajo a propósito: si crear la conversación falla y el botón se queda
 * quieto, lo que parece es que la pantalla no responde.
 */
export function AskAssistantButton({ prompt, workspaceId, children, className = 'btn small', title }: {
  prompt: string;
  workspaceId?: string | null;
  children: ReactNode;
  className?: string;
  title?: string;
}): JSX.Element {
  const assistant = useAskAssistant();
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={assistant.pending}
        title={title ?? 'Abre una conversación con el asistente de casa, ya sembrada con esto'}
        onClick={() => assistant.ask({ prompt, workspaceId })}
      >
        <Glyph icon={NAV_ICON.assistant} />
        {assistant.pending ? 'Preguntando…' : children}
      </button>
      {assistant.error ? (
        <span style={{ flex: '1 1 100%' }}>
          <ErrorNote error={assistant.error} />
        </span>
      ) : null}
    </>
  );
}
