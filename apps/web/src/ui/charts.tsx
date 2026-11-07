/**
 * El medidor: cuántos de cuántos, en una barra.
 *
 * Aquí vivían también un histograma y un anillo de reparto para la portada de cifras. La portada
 * se quitó y con ella los dos; el medidor queda porque la cuota de las cuentas se lee mejor como
 * barra que como número suelto. Va siempre acompañado del número que representa.
 */
import type { JSX } from 'react';

/** Una barra de proporción: cuántos de cuántos, sin hacer contar al lector. */
export function Meter({ value, max, tone = 'accent' }: {
  value: number;
  max: number;
  tone?: 'accent' | 'ok' | 'warn' | 'danger';
}): JSX.Element {
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className={`meter ${tone === 'accent' ? '' : tone}`} role="img"
      aria-label={`${value} de ${max}`}>
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}
