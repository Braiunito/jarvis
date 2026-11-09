/**
 * El selector de modelo, montado.
 *
 * Lo que sólo se ve pintando: que cada agente ofrece lo suyo —un alias de Claude no le sirve a
 * Codex—, que lo elegido antes y que el catálogo no trae se sigue viendo en vez de saltar a
 * «Otro…», y que «Otro…» deja escribir y avisa de lo que no es un nombre de modelo.
 */
import type { JSX } from 'react';
import { act, StrictMode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelCatalog, Provider } from '@jarvis/contracts';
import { ModelPicker } from '../src/ui/model-picker.jsx';

const CATALOG: ModelCatalog = {
  models: [
    { provider: 'claude', id: 'opus', kind: 'alias', lastUsedAt: null },
    { provider: 'claude', id: 'sonnet', kind: 'alias', lastUsedAt: null },
    { provider: 'claude', id: 'haiku', kind: 'alias', lastUsedAt: null },
    { provider: 'codex', id: 'gpt-5.6-sol', kind: 'seen', lastUsedAt: '2026-11-07T10:00:00.000Z' },
    { provider: 'claude', id: 'claude-opus-5-5', kind: 'seen', lastUsedAt: '2026-11-06T10:00:00.000Z' },
  ],
};

let host: HTMLDivElement;
let root: Root;
let picked: string;

function Harness({ provider, initial }: { provider: Provider; initial: string }): JSX.Element {
  const [value, setValue] = useState(initial);
  picked = value;
  return <ModelPicker provider={provider} value={value} onChange={setValue} />;
}

const render = (provider: Provider, initial = ''): void => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['models'], CATALOG);
  act(() => {
    root.render(
      <StrictMode>
        <QueryClientProvider client={client}><Harness provider={provider} initial={initial} /></QueryClientProvider>
      </StrictMode>,
    );
  });
};

const select = (): HTMLSelectElement => host.querySelector('select[aria-label="Modelo"]') as HTMLSelectElement;
const labels = (): string[] => [...select().options].map((option) => option.textContent ?? '');

const choose = (value: string): void => {
  act(() => {
    const element = select();
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

const type = (text: string): void => {
  act(() => {
    const input = host.querySelector('input[aria-label="Nombre del modelo"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  picked = '';
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('el selector de modelo', () => {
  it('cada agente ofrece lo suyo, con el de la máquina primero', () => {
    render('claude');
    expect(labels()).toEqual([
      'Modelo por defecto', 'Opus, el más reciente', 'Sonnet, el más reciente', 'Haiku, el más reciente',
      'Opus 5.5', 'Otro…',
    ]);
    expect(select().value).toBe('');

    render('codex');
    expect(labels()).toEqual(['Modelo por defecto', 'gpt-5.6-sol', 'Otro…']);
  });

  it('elegir uno lo devuelve tal cual, que es lo que va a la CLI', () => {
    render('claude');
    choose('claude-opus-5-5');
    expect(picked).toBe('claude-opus-5-5');
  });

  it('lo elegido antes que el catálogo no trae se sigue viendo', () => {
    render('codex', 'gpt-5.7-terra');
    expect(select().value).toBe('gpt-5.7-terra');
    expect(labels()).toContain('gpt-5.7-terra');
    expect(host.querySelector('input')).toBeNull();
  });

  it('«Otro…» deja escribir, y lo que no es un nombre de modelo se marca', () => {
    render('opencode');
    choose('\u0000otro');
    const input = host.querySelector('input[aria-label="Nombre del modelo"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.placeholder).toBe('proveedor/modelo');

    type('anthropic/claude-sonnet-5');
    expect(picked).toBe('anthropic/claude-sonnet-5');
    expect(input.getAttribute('aria-invalid')).toBeNull();

    type('--yolo');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });
});
