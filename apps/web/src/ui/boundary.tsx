/**
 * Lo que impide que un dato malo se lleve la pantalla por delante.
 *
 * En React, un hijo que no se puede pintar —un objeto donde se esperaba texto— no falla en su sitio:
 * lanza, y el árbol entero se desmonta desde arriba. Aquí eso significa que **una celda de tabla con
 * la forma equivocada deja al usuario sin hilo, sin compositor y sin poder escribir**, con la pantalla
 * en blanco y sin decir por qué.
 *
 * Y el dato viene de donde viene: el cuerpo de un artifact lo escribe un modelo. Validarlo en el core
 * es lo correcto y se hace, pero eso protege de lo que se ha previsto; esto protege de lo que no.
 *
 * Por eso hay dos anillos y no uno. El de dentro rodea cada pieza —una burbuja, un artifact— y cae
 * sólo esa pieza: el resto de la conversación se sigue leyendo y se puede seguir escribiendo. El de
 * fuera rodea la pantalla y es la última red, para que un fallo en un sitio que nadie previó deje al
 * menos un mensaje y no un rectángulo vacío.
 */
import type { ErrorInfo, ReactNode } from 'react';
import { Component } from 'react';
import { ACTION_ICON, Glyph } from './icons.jsx';

interface Props {
  children: ReactNode;
  /** Qué se estaba pintando, para que el aviso diga qué falta y no «algo». */
  what: string;
  /** El contenido en crudo, si lo hay: lo que no se pudo pintar sigue siendo la respuesta. */
  raw?: string;
}

interface State { error: Error | null }

export class Boundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  /*
   * Se registra en consola a propósito.
   *
   * Un fallo que se traga sin dejar rastro es un fallo que nadie arregla: la tarjeta dice a la
   * persona que eso no se pudo pintar, y la consola dice a quien mire por qué.
   */
  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[jarvis] no se pudo pintar ${this.props.what}`, error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="boundary">
        <p className="boundary-head">
          <Glyph icon={ACTION_ICON.error} size={14} />
          <span>
            Esto no se pudo mostrar ({this.props.what}). El resto de la conversación sigue
            funcionando.
          </span>
        </p>
        {/*
          * El contenido en crudo, cuando lo hay.
          *
          * Que la interfaz no sepa dibujarlo no lo convierte en basura: sigue siendo lo que el
          * asistente encontró, y en crudo se lee.
          */}
        {this.props.raw ? (
          <pre className="md-pre md-raw"><code>{this.props.raw}</code></pre>
        ) : null}
        <p className="tiny faint" style={{ margin: 0 }}>{error.message}</p>
      </div>
    );
  }
}
