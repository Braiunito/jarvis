/**
 * El plan que espera algo tuyo, y que se leía como si no esperara nada.
 *
 * El caso real: se aprobó un plan, su primer paso era **una pregunta a la persona**, y esa pregunta
 * no apareció en ninguna parte. Lo último que se leía era «Autorizado. El plan queda en marcha», y
 * dos minutos después la persona escribía «Autorice el plan» esperando algo que nadie le enseñó.
 *
 * Lo que se fija aquí es que la pregunta **se vea y se pueda contestar**: sin la segunda mitad, el
 * plan se queda parado igual y sólo cambia quién tiene la culpa.
 */
import { StrictMode, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanPending, planEspera, type LivePlan } from '../src/ui/plan-pending.jsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const render = (node: JSX.Element): void => {
  act(() => { root.render(<StrictMode>{node}</StrictMode>); });
};

const plan = (extra: Partial<LivePlan> = {}): LivePlan => ({
  planId: 'p1',
  status: 'waiting_input',
  objective: 'Arreglar el login de tickets',
  step: 0,
  steps: 7,
  question: '¿Qué permisos de escritura hay que habilitar en goro3?',
  ...extra,
});

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('cuándo el plan espera a la persona', () => {
  it('esperando respuesta y sin firmar, sí; en marcha, no', () => {
    expect(planEspera(plan())).toBe(true);
    expect(planEspera(plan({ status: 'draft' }))).toBe(true);
    expect(planEspera(plan({ status: 'running' }))).toBe(false);
    expect(planEspera(plan({ status: 'paused' }))).toBe(false);
    expect(planEspera(null)).toBe(false);
  });
});

describe('la pregunta del plan', () => {
  it('se lee entera, con el paso en el que va', () => {
    render(<PlanPending plan={plan()} pending={false} error={null} onAnswer={() => undefined} onOpen={() => undefined} />);
    expect(host.textContent).toContain('¿Qué permisos de escritura hay que habilitar en goro3?');
    // El paso se cuenta desde uno para quien mira: «paso 0 de 7» no es una posición, es un error.
    expect(host.textContent).toContain('paso 1 de 7');
  });

  it('se puede contestar, que es lo que desatasca el plan', () => {
    const contestado = vi.fn();
    render(<PlanPending plan={plan()} pending={false} error={null} onAnswer={contestado} onOpen={() => undefined} />);
    const campo = host.querySelector('input');
    const form = host.querySelector('form');
    if (!campo || !form) throw new Error('no hay dónde contestar');

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(campo, 'sólo lectura en /var/www');
      campo.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });

    expect(contestado).toHaveBeenCalledWith('sólo lectura en /var/www');
  });

  it('una respuesta en blanco no se manda: dejaría el plan igual y parecería contestado', () => {
    const contestado = vi.fn();
    render(<PlanPending plan={plan()} pending={false} error={null} onAnswer={contestado} onOpen={() => undefined} />);
    const form = host.querySelector('form');
    act(() => { form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(contestado).not.toHaveBeenCalled();
  });

  it('si la respuesta no llega, se dice: el plan sigue esperando y no se ve', () => {
    render(<PlanPending plan={plan()} pending={false} error={new Error('el plan ya no acepta respuesta')}
      onAnswer={() => undefined} onOpen={() => undefined} />);
    expect(host.textContent).toContain('el plan ya no acepta respuesta');
  });

  it('un plan sin firmar enseña su objetivo y la puerta, no un campo de texto', () => {
    render(<PlanPending plan={plan({ status: 'draft', question: null })} pending={false} error={null}
      onAnswer={() => undefined} onOpen={() => undefined} />);
    expect(host.textContent).toContain('Arreglar el login de tickets');
    expect(host.textContent).toContain('espera tu firma');
    expect(host.querySelector('input')).toBeNull();
  });
});
