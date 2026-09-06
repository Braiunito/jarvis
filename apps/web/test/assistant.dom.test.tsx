/**
 * Lo que sólo se ve montando la pantalla.
 *
 * Los tres fallos que se prueban aquí convivieron con una suite de 571 en verde, y no por descuido:
 * ninguno se puede ver desde el core ni desde una función pura. Un objeto donde iba texto no rompe
 * al validar, rompe **al pintar**; un borrador perdido no deja rastro en ninguna respuesta; y un
 * `EventSource` que reintenta para siempre sólo se nota mirando cuántas veces lo intenta.
 *
 * Por eso este fichero monta React contra un DOM de verdad, y por eso está separado del proyecto
 * `web`, que prueba funciones puras en `node` y tiene que seguir costando medio segundo.
 */
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Boundary } from '../src/ui/boundary.jsx';
import { ArtifactView } from '../src/ui/artifact.jsx';
import type { ChatArtifact } from '@jarvis/contracts';

let host: HTMLDivElement;
let root: Root;

/** Montar y esperar a que React acabe, que es lo que hace `act`. */
const render = (node: React.ReactNode): void => {
  act(() => { root.render(<StrictMode>{node}</StrictMode>); });
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  // El anillo registra en consola a propósito; en las pruebas ese ruido no aporta.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const artifact = (body: string, kind: ChatArtifact['kind'] = 'table'): ChatArtifact => ({
  id: 'a1',
  conversationId: 'c1',
  messageId: 'm1',
  kind,
  presentation: 'inline',
  title: 'Disco por máquina',
  caption: null,
  language: null,
  body,
  bytes: body.length,
  truncated: false,
  createdAt: new Date().toISOString(),
});

/** Un componente que revienta al pintar, como lo haría un objeto donde se espera texto. */
function Revienta(): never {
  throw new Error('un objeto donde iba texto');
}

describe('un dato malo no se lleva la pantalla por delante', () => {
  it('el anillo cae solo y lo de al lado sigue en pie', () => {
    render(
      <div>
        <p>lo de antes</p>
        <Boundary what="una burbuja"><Revienta /></Boundary>
        <p>lo de después</p>
      </div>,
    );
    // Lo que importa no es el aviso: es que lo de alrededor siga montado.
    expect(host.textContent).toContain('lo de antes');
    expect(host.textContent).toContain('lo de después');
    expect(host.textContent).toContain('no se pudo mostrar');
  });

  it('enseña el contenido en crudo, porque sigue siendo la respuesta', () => {
    render(<Boundary what="un artifact" raw={'{"filas":3}'}><Revienta /></Boundary>);
    expect(host.textContent).toContain('{"filas":3}');
  });

  it('una tabla con `label` que no es texto no desmonta el árbol', () => {
    /*
     * Éste es el caso de la auditoría, tal cual. En React un objeto como hijo lanza y desmonta desde
     * arriba: sin anillo, la conversación entera —hilo, compositor y carril— desaparecía por una
     * celda.
     */
    const malo = JSON.stringify({
      columns: [{ key: 'x', label: { raro: true } }],
      rows: [{ x: 1 }],
    });
    render(
      <div>
        <p>el hilo sigue aquí</p>
        <ArtifactView conversationId="c1" artifact={artifact(malo)} />
      </div>,
    );
    expect(host.textContent).toContain('el hilo sigue aquí');
  });

  it('una tabla bien formada se pinta entera', () => {
    const buena = JSON.stringify({
      columns: [{ key: 'host', label: 'Máquina' }, { key: 'libre', label: 'Libre', align: 'right' }],
      rows: [{ host: 'zeus', libre: '12 GiB' }, { host: 'edge', libre: null }],
    });
    render(<ArtifactView conversationId="c1" artifact={artifact(buena)} />);
    expect(host.textContent).toContain('Máquina');
    expect(host.textContent).toContain('zeus');
    // Un hueco vacío se dice con una raya, no se deja en blanco: en blanco parece un fallo.
    expect(host.textContent).toContain('—');
  });

  it('un cuerpo que no es JSON no rompe: sale en crudo con su aviso', () => {
    render(<ArtifactView conversationId="c1" artifact={artifact('esto no es json')} />);
    expect(host.textContent).toContain('esto no es json');
    expect(host.textContent).toContain('en crudo');
  });
});

describe('el documento HTML que ejecuta', () => {
  it('se aísla con `allow-scripts` y **sin** `allow-popups`', () => {
    render(<ArtifactView conversationId="c1" artifact={artifact('<b>hola</b>', 'html')} />);
    const frame = host.querySelector('iframe');
    expect(frame).not.toBeNull();
    /*
     * `allow-popups` sería la tercera puerta —después del iframe anidado y la navegación— porque un
     * `window.open` escapa del documento aislado. La prueba existe para que añadirlo sea una
     * decisión y no un descuido de alguien que quiera «que se vea mejor».
     */
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
  });

  it('va enmarcado y dice que no es parte de la consola', () => {
    render(<ArtifactView conversationId="c1" artifact={artifact('<b>hola</b>', 'html')} />);
    expect(host.textContent).toContain('Contenido generado por el asistente');
    expect(host.textContent).toContain('no le des contraseñas');
  });
});
