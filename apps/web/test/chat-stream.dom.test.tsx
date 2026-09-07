/**
 * El hilo en directo, cuando el directo se corta y tarda en volver.
 *
 * Lo que se prueba aquí es lo que sólo aparece **dejando pasar el tiempo**: una pestaña abierta
 * mientras el portátil se duerme. `EventSource` reintenta solo, así que un corte de un segundo no
 * se ve en ningún sitio y no hay nada que probar; a la sexta se deja de intentar, y eso sí es un
 * estado del que hay que poder salir.
 *
 * Necesita DOM porque lo que se comprueba es el ciclo de vida del efecto —cuándo se abre un
 * `EventSource` y cuándo se cierra—, y eso no existe fuera de un componente montado.
 */
import { StrictMode, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStream, type ChatStreamState } from '../src/api/chat-stream.js';

/** Un `EventSource` de mentira que deja disparar sus eventos a mano y se apunta cuántos se abren. */
class FakeEventSource {
  static abiertos: FakeEventSource[] = [];
  static readonly CLOSED = 2;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  cerrado = false;
  readonly oyentes = new Map<string, (event: MessageEvent<string>) => void>();

  constructor(readonly url: string) { FakeEventSource.abiertos.push(this); }

  addEventListener(tipo: string, fn: (event: MessageEvent<string>) => void): void {
    this.oyentes.set(tipo, fn);
  }

  close(): void { this.cerrado = true; this.readyState = FakeEventSource.CLOSED; }

  /** Lo que haría el servidor: un `chat.message` con su `seq`. */
  manda(seq: number, text: string): void {
    const fn = this.oyentes.get('chat.message');
    if (!fn) throw new Error('nadie escucha chat.message');
    const message = {
      id: `m${seq}`, conversationId: 'c1', seq, role: 'assistant', text,
      toolName: null, toolInput: null, toolOk: null, source: 'local', modelId: null,
      approvalId: null, runIds: [], refs: [], createdAt: new Date().toISOString(),
    };
    act(() => { fn(new MessageEvent('chat.message', { data: JSON.stringify(message) })); });
  }
}

/*
 * Sin esto React avisa —«not configured to support act»— y `act` deja de garantizar que los efectos
 * hayan corrido cuando vuelve. Las afirmaciones seguían saliendo bien, que es justo lo peligroso:
 * una prueba que pasa sin que nadie le asegure el orden pasa también cuando no debería.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let ultimo: ChatStreamState | null = null;

function Sonda({ id }: { id: string }): JSX.Element {
  ultimo = useChatStream(id);
  return <p>{ultimo.messages.length} mensajes</p>;
}

const render = (id: string): void => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <StrictMode>
        <QueryClientProvider client={client}><Sonda id={id} /></QueryClientProvider>
      </StrictMode>,
    );
  });
};

/** Los que siguen abiertos: en `StrictMode` React monta el efecto dos veces y cierra el primero. */
const vivos = (): FakeEventSource[] => FakeEventSource.abiertos.filter((s) => !s.cerrado);

beforeEach(() => {
  FakeEventSource.abiertos = [];
  ultimo = null;
  vi.stubGlobal('EventSource', FakeEventSource);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('un corte largo', () => {
  it('cinco fallos no son noticia; a la sexta se dice que no va a volver solo', () => {
    render('c1');
    const source = vivos()[0]!;

    for (let i = 0; i < 5; i += 1) act(() => source.onerror?.());
    expect(ultimo?.lost, 'una reconexión en curso no se pinta como avería').toBe(false);
    expect(source.cerrado).toBe(false);

    act(() => source.onerror?.());
    expect(ultimo?.lost).toBe(true);
    expect(source.cerrado, 'darse por vencido incluye dejar de pedirlo al servidor').toBe(true);
  });

  it('reconectar abre otro de verdad, y no repite lo que ya se leyó', () => {
    render('c1');
    const primero = vivos()[0]!;
    primero.manda(1, 'lo de antes del corte');
    expect(ultimo?.messages).toHaveLength(1);

    for (let i = 0; i < 6; i += 1) act(() => primero.onerror?.());
    expect(ultimo?.lost).toBe(true);

    const antes = FakeEventSource.abiertos.length;
    act(() => { ultimo?.retry(); });
    expect(FakeEventSource.abiertos.length, 'reconectar tiene que abrir uno nuevo').toBeGreaterThan(antes);
    expect(ultimo?.lost, 'y dejar de decir que no hay conexión').toBe(false);

    /*
     * Lo que ya se leyó se conserva, y el servidor repite desde el último id: la deduplicación por
     * `seq` es lo que impide que el hilo salga dos veces. Sin ella, reconectar duplicaría la
     * conversación entera en pantalla, que es peor que la avería que se está arreglando.
     */
    const segundo = vivos()[0]!;
    segundo.manda(1, 'lo de antes del corte');
    segundo.manda(2, 'lo de después');
    expect(ultimo?.messages.map((m) => m.seq)).toEqual([1, 2]);
  });

  it('cambiar de conversación cierra el anterior: una pestaña vieja no se queda escuchando', () => {
    render('c1');
    const primero = vivos()[0]!;
    render('c2');
    expect(primero.cerrado).toBe(true);
    expect(vivos()).toHaveLength(1);
  });
});
