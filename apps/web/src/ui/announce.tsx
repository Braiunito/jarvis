/**
 * Anunciar transiciones, no tokens.
 *
 * Una consola que emite texto en vivo es hostil con un lector de pantalla: si la región de la
 * respuesta del agente fuera `aria-live`, se leería cada trozo que llega y no se entendería nada.
 * Lo que sí hay que anunciar son los **cambios de estado** —el trabajo terminó, el plan pide
 * permiso, la terminal se desconectó—, que son pocos y son justo lo que se estaba esperando.
 *
 * Hay una sola región para toda la aplicación: varias compitiendo se pisan y el lector se queda
 * con la última. `polite` porque nada de esto interrumpe lo que estés haciendo.
 */
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';

const EVENT = 'jarvis:announce';

export function announce(message: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: message }));
}

/**
 * Anuncia cuando el valor cambia, no cuando se pinta.
 *
 * El primer render no dice nada: llegar a una pantalla con un trabajo ya terminado no es una
 * novedad, y anunciarlo entrena a la gente a ignorar los avisos.
 */
export function useAnnounceOnChange<T>(value: T, describe: (value: T) => string | null): void {
  const previous = useRef<T | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (!started.current) {
      started.current = true;
      previous.current = value;
      return;
    }
    if (previous.current === value) return;
    previous.current = value;
    const message = describe(value);
    if (message) announce(message);
    // `describe` se recrea en cada render a propósito: lo que dispara esto es el valor.
  }, [value]);
}

export function Announcer(): JSX.Element {
  const [message, setMessage] = useState('');

  useEffect(() => {
    const onAnnounce = (event: Event): void => {
      const text = (event as CustomEvent<string>).detail;
      // Repetir el mismo texto no se anuncia: hay que cambiarlo para que el lector lo lea otra vez.
      setMessage((previous) => (previous === text ? `${text} ` : text));
    };
    window.addEventListener(EVENT, onAnnounce);
    return () => window.removeEventListener(EVENT, onAnnounce);
  }, []);

  return <p className="visually-hidden" role="status" aria-live="polite">{message}</p>;
}
