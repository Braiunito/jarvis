/**
 * La línea de eventos de un trabajo, montada.
 *
 * Dos cosas que sólo se ven pintando: que la respuesta del agente se lee una vez —Claude cierra el
 * turno con un resultado que repite su último mensaje— y que se lee entera, con su formato y con
 * enlaces que se pueden pulsar porque ya no van dentro de un botón.
 */
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunEvent } from '@jarvis/contracts';
import { EventTimeline } from '../src/ui/event-log.jsx';

let host: HTMLDivElement;
let root: Root;

const render = (node: React.ReactNode): void => {
  act(() => { root.render(<StrictMode>{node}</StrictMode>); });
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

let seq = 0;
const event = (type: string, payload: Record<string, unknown>): RunEvent => ({
  runId: 'r1',
  seq: seq++,
  at: new Date(Date.UTC(2026, 10, 7, 10, 0, seq)).toISOString(),
  type,
  payload,
} as unknown as RunEvent);

describe('la respuesta del agente', () => {
  it('se lee una vez aunque el resultado la repita', () => {
    const texto = 'Falta un `finally` en el handler de reintentos.';
    render(<EventTimeline events={[
      event('agent.started', { model: 'claude-opus-5' }),
      event('agent.text', { text: texto }),
      event('agent.result', { ok: true, text: texto, turns: 3 }),
    ]} />);

    const respuestas = [...host.querySelectorAll('.event-card.answer .event-body')]
      .filter((body) => body.textContent?.includes('handler de reintentos'));
    expect(respuestas).toHaveLength(1);
    // El resultado sigue ahí, en su línea: terminó y cuánto le costó.
    expect(host.textContent).toContain('terminado');
    expect(host.textContent).toContain('3 turnos');
  });

  it('un resultado distinto del último mensaje sí se enseña entero', () => {
    render(<EventTimeline events={[
      event('agent.text', { text: 'Miro el log.' }),
      event('agent.result', { ok: true, text: 'El pool no devuelve conexiones.' }),
    ]} />);
    expect(host.textContent).toContain('Miro el log.');
    expect(host.textContent).toContain('El pool no devuelve conexiones.');
  });

  it('no se corta, tiene formato y sus enlaces no van dentro de un botón', () => {
    const largo = `${'Una línea de explicación bastante larga. '.repeat(40)}[el PR](https://example.com/pr/1) **fin**`;
    render(<EventTimeline events={[event('agent.text', { text: largo })]} />);

    expect(host.textContent).toContain('fin');
    expect(host.textContent).not.toContain('…');
    const enlace = host.querySelector('a.md-link');
    expect(enlace?.getAttribute('href')).toBe('https://example.com/pr/1');
    expect(enlace?.closest('button')).toBeNull();
    expect(host.querySelector('strong')?.textContent).toBe('fin');
  });
});

describe('copiar una respuesta', () => {
  it('cada respuesta lleva su botón y copia el Markdown tal cual, no el texto pintado', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('isSecureContext', true);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const texto = 'Cambia `pool.max` a **40** y reinicia.';
    render(<EventTimeline events={[
      event('agent.started', { model: 'claude-opus-5' }),
      event('agent.text', { text: texto }),
      event('agent.result', { ok: true, text: texto, turns: 2 }),
    ]} />);

    // Uno solo: el resultado que repite el último mensaje no trae un segundo botón.
    const botones = host.querySelectorAll<HTMLButtonElement>('button[aria-label="Copiar la respuesta"]');
    expect(botones).toHaveLength(1);
    await act(async () => { botones[0]!.click(); });
    expect(writeText).toHaveBeenCalledWith(texto);
    expect(botones[0]!.getAttribute('title')).toBe('Copiado');

    vi.unstubAllGlobals();
  });

  it('los pasos de la máquina no se ofrecen para copiar: para eso está el crudo', () => {
    render(<EventTimeline events={[
      event('tool.started', { name: 'Bash', input: { command: 'ls' } }),
    ]} />);
    expect(host.querySelector('button[aria-label="Copiar la respuesta"]')).toBeNull();
  });
});
