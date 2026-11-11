/**
 * La pantalla de alertas, montada.
 *
 * Lo que sólo se ve pintando: que cada alerta dice importancia, origen y máquina con palabras y no
 * sólo con color; que los filtros llegan a la petición; que «marcar todo leído» pide eso y no otra
 * cosa; y que un enlace que no es de fiar —lo escribe cualquiera con la clave— no se convierte en
 * un enlace.
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Alert, AlertList, PushStatus } from '@jarvis/contracts';
import { AlertsScreen, alertTarget } from '../src/screens/alerts.jsx';

const ALERTS: Alert[] = [
  {
    id: 'alr_1',
    createdAt: '2026-11-10T20:00:00.000Z',
    importance: 'critical',
    title: 'goro2 no responde',
    body: 'Tres sondeos seguidos sin respuesta.',
    link: '/health',
    origin: { kind: 'jarvis', host: 'zeus', app: 'salud' },
    readAt: null,
    pushedTo: 2,
  },
  {
    id: 'alr_2',
    createdAt: '2026-11-10T19:00:00.000Z',
    importance: 'normal',
    title: 'Refactor terminado',
    body: null,
    link: 'javascript:alert(1)',
    origin: { kind: 'api', host: 'braian', app: 'claude-code' },
    readAt: '2026-11-10T19:30:00.000Z',
    pushedTo: 0,
  },
];

const LIST: AlertList = { alerts: ALERTS, unread: 1, unreadTop: 'critical', hosts: ['braian', 'zeus'] };
const PUSH: PushStatus = { publicKey: 'BOr-fake-key', devices: [] };

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ url: string; method: string; body: unknown }>;

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.startsWith('/api/alerts/push')) return json(PUSH);
    if (url.startsWith('/api/alerts/read')) return json({ updated: 1 });
    if (url.startsWith('/api/alerts')) return json(LIST);
    return json({ error: { code: 'NOT_FOUND', message: url, retryable: false, requestId: 'x' } }, 404);
  }));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const render = async (): Promise<void> => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<StrictMode><QueryClientProvider client={client}><AlertsScreen /></QueryClientProvider></StrictMode>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};

const button = (name: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll('button')].find((element) => element.textContent?.trim() === name);
  if (!found) throw new Error(`no hay botón «${name}»`);
  return found;
};

describe('Alertas', () => {
  it('cada alerta dice importancia, origen y máquina con palabras, y marca las no leídas', async () => {
    await render();

    const rows = [...host.querySelectorAll('.alert-row')];
    expect(rows).toHaveLength(2);
    const [critical, normal] = rows as [HTMLElement, HTMLElement];
    expect(critical.classList.contains('unread')).toBe(true);
    expect(critical.textContent).toContain('Crítica');
    expect(critical.textContent).toContain('Jarvis');
    expect(critical.textContent).toContain('zeus');
    expect(critical.textContent).toContain('salud');
    // Leer «sin leer» no depende de ver el borde de color.
    expect(critical.querySelector('.visually-hidden')?.textContent).toContain('Sin leer');
    expect(normal.classList.contains('unread')).toBe(false);
    expect(normal.textContent).toContain('API');
    expect(normal.textContent).toContain('braian');
    expect(normal.textContent).toContain('claude-code');
  });

  it('un enlace que no es de esta consola ni http(s) no se pinta como enlace', async () => {
    await render();

    const [critical, normal] = [...host.querySelectorAll('.alert-row')] as [HTMLElement, HTMLElement];
    expect(critical.querySelector('a[href="/health"]')).not.toBeNull();
    expect(normal.querySelector('a')).toBeNull();
    expect(host.innerHTML).not.toContain('javascript:');
  });

  it('los filtros viajan en la petición', async () => {
    await render();

    await act(async () => { button('Alta').click(); });
    await act(async () => { button('Crítica').click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const last = calls.filter((call) => call.url.startsWith('/api/alerts?')).at(-1)!;
    const params = new URL(last.url, 'http://x').searchParams;
    // Ordenadas de menos a más, sea cual sea el orden en que se pulsaron.
    expect(params.get('importance')).toBe('high,critical');
    expect(params.get('limit')).toBe('50');
  });

  it('«Marcar todo leído» pide todas, sin listarlas', async () => {
    await render();

    await act(async () => { button('Marcar todo leído').click(); });

    const read = calls.find((call) => call.url === '/api/alerts/read');
    expect(read).toMatchObject({ method: 'POST', body: { all: true } });
  });

  it('sin contexto seguro dice por qué no puede sonar, en vez de ofrecer un botón que fallará', async () => {
    await render();

    expect(host.textContent).toContain('Este dispositivo no puede recibir notificaciones');
    expect([...host.querySelectorAll('button')].some((element) => element.textContent?.trim() === 'Activar')).toBe(false);
  });
});

describe('alertTarget', () => {
  it('acepta rutas de la consola y http(s), y nada más', () => {
    expect(alertTarget('/runs/run_1')).toEqual({ internal: '/runs/run_1' });
    expect(alertTarget('https://github.com/x')).toEqual({ external: 'https://github.com/x' });
    expect(alertTarget('javascript:alert(1)')).toBeNull();
    expect(alertTarget('data:text/html,hola')).toBeNull();
    // Dos barras es otro dominio con el protocolo de esta página, no una ruta.
    expect(alertTarget('//evil.example/x')).toBeNull();
    expect(alertTarget(null)).toBeNull();
  });
});
