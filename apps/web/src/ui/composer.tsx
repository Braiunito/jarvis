/**
 * Escribir, en toda la casa.
 *
 * Hay dos sitios donde se le escribe a una máquina —el hilo del asistente y el borrador de un
 * workspace— y hasta ahora cada uno tenía su forma: uno con el botón dentro de la barra y el otro
 * con el envío a diez centímetros del textarea, el clip de adjuntos sólo en uno, y el Enter
 * haciendo cosas distintas. Escribir es el mismo gesto en los dos, así que la barra es la misma.
 *
 * Lo que **no** se comparte es lo que hay alrededor, y es a propósito. El compositor del workspace
 * no es un chat: lo que se escribe ahí es un borrador que se guarda con versión y que al enviarse
 * lanza un trabajo que puede durar horas en una máquina concreta con un permiso concreto. Darle
 * forma de conversación prometería un ida y vuelta que no existe y, peor, escondería el perfil de
 * permiso, que es el control más caro del producto. Por eso esto es una **barra**, no un chat: pone
 * el textarea, el clip y el botón, y deja huecos para lo que cada sitio tiene que enseñar.
 */
import type { JSX, ReactNode } from 'react';
import { useRef } from 'react';
import { ACTION_ICON, Glyph } from './icons.jsx';

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  /** Lo que lee un lector de pantalla al llegar al campo. */
  label: string;
  submitLabel: string;
  submitting?: boolean;
  /** Además de estar vacío: el workspace no deja enviar mientras sube un fichero. */
  disabled?: boolean;
  /**
   * Enter envía.
   *
   * En el chat sí, que es lo que espera quien viene de cualquier mensajería. En el borrador de un
   * workspace **no**: ahí se escribe una tarea de varias líneas y un Enter accidental lanzaría
   * trabajo en una máquina. La diferencia no es de estilo.
   */
  submitOnEnter?: boolean;
  /** Si se pasa, aparece el clip. Sin esto no hay adjuntos y el hueco no se dibuja. */
  onFiles?: (files: File[]) => void;
  uploading?: boolean;
  /** Encima de la barra: en el workspace, el permiso y el destino. Nunca se esconden. */
  before?: ReactNode;
  /** Debajo: el estado del borrador, los adjuntos preparados, un error. */
  after?: ReactNode;
  className?: string;
  rows?: number;
}

export function Composer({
  value, onChange, onSubmit, placeholder, label, submitLabel,
  submitting = false, disabled = false, submitOnEnter = false,
  onFiles, uploading = false, before, after, className = '', rows = 2,
}: ComposerProps): JSX.Element {
  const field = useRef<HTMLTextAreaElement | null>(null);
  const blocked = disabled || submitting || !value.trim();

  return (
    <div className={`composer ${className}`}>
      {before}

      <div className="composer-bar">
        {onFiles ? (
          /*
           * El clip es una etiqueta con un input escondido, no un botón que abre otra cosa: es la
           * forma que el navegador ya sabe hacer accesible y con teclado.
           */
          <label className="composer-clip" title={uploading ? 'Subiendo…' : 'Adjuntar ficheros'}>
            <Glyph icon={ACTION_ICON.attach} size={17} className={uploading ? 'spin' : undefined} />
            <span className="visually-hidden">Adjuntar ficheros</span>
            <input
              type="file"
              multiple
              className="visually-hidden"
              disabled={uploading}
              onChange={(event) => {
                const chosen = [...(event.target.files ?? [])];
                event.target.value = '';
                if (chosen.length) onFiles(chosen);
              }}
            />
          </label>
        ) : null}

        <textarea
          ref={field}
          className="composer-field"
          value={value}
          rows={rows}
          placeholder={placeholder}
          aria-label={label}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (!submitOnEnter) return;
            // Enter envía; Shift+Enter hace párrafo. Es lo que espera quien viene de un chat.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              if (!blocked) onSubmit();
            }
          }}
        />

        <button
          type="button"
          className="btn primary composer-send"
          disabled={blocked}
          aria-label={submitLabel}
          onClick={() => onSubmit()}
        >
          <Glyph icon={ACTION_ICON.send} />
          <span className="composer-word">{submitting ? 'Enviando…' : submitLabel}</span>
        </button>
      </div>

      {after}
    </div>
  );
}
