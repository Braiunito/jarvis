/**
 * El markdown del asistente, acotado a mano.
 *
 * No es un renderizador de CommonMark y no quiere serlo. El texto lo escribe **nuestro** modelo
 * con **nuestro** prompt, así que el subconjunto es un acuerdo entre las dos puntas y no un
 * estándar que haya que soportar entero.
 *
 * La razón de escribirlo en vez de traer una librería no es el tamaño —cabía— sino que **nunca
 * produce cadenas de HTML**. Devuelve nodos de React, así que no hay `dangerouslySetInnerHTML` en
 * ninguna parte y no hay nada que sanitizar: la clase de fallo entera deja de existir en lugar de
 * quedar sujeta a una configuración que alguien afloja dentro de tres meses para «que se vea el
 * HTML del informe». Y el texto que se pinta aquí salió de un modelo que acaba de leer el
 * transcript de una máquina, o sea contenido no confiable por construcción, no por accidente.
 *
 * El fichero va partido en dos a propósito: `parseMarkdown` es una función pura de cadena a
 * descriptores, sin React, y por eso se puede probar en `node` sin DOM ni una sola dependencia
 * nueva —que es donde viven los casos que de verdad importan: los esquemas de enlace, el tope de
 * tamaño, la tabla mal cerrada—. El componente de abajo sólo traduce esos descriptores a nodos.
 */
import type { JSX, ReactNode } from 'react';
import { Link } from './bits.jsx';

/**
 * Lo que no entra, y por qué.
 *
 * · **HTML crudo** — sale como texto literal. Es la mitad del motivo de que esto exista.
 * · **Imágenes** — una `<img src>` remota es una baliza: filtra la IP de quien lee y el hecho de
 *   que lo ha leído, y la pone el mismo modelo que puede haber leído algo hostil. Se pinta como
 *   enlace, que dice a dónde va antes de ir.
 * · **Notas al pie y casillas** — no las produce el prompt.
 * · **Anidamiento de listas** — un nivel. Una respuesta de chat que necesita tres no es una
 *   respuesta, es un documento, y para eso están los artifacts.
 */

/** Lo máximo que se formatea. Por encima es un volcado, y un volcado se lee mejor en crudo. */
export const MAX_MARKDOWN_BYTES = 40 * 1024;

/** Los esquemas que puede llevar un enlace. Todo lo demás se pinta como texto y no navega. */
const SAFE_SCHEMES = ['http:', 'https:', 'mailto:'];

export type Span =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; spans: Span[] }
  | { kind: 'em'; spans: Span[] }
  /** `internal` distingue una ruta de la casa de una URL de fuera: la primera navega sin recargar. */
  | { kind: 'link'; href: string; internal: boolean; spans: Span[] }
  | { kind: 'break' };

export type Block =
  | { kind: 'paragraph'; spans: Span[] }
  /** 1, 2 o 3 tal como se escribió; el componente decide en qué `h` aterriza. */
  | { kind: 'heading'; level: 1 | 2 | 3; spans: Span[] }
  | { kind: 'code'; lang: string | null; text: string }
  | { kind: 'list'; ordered: boolean; items: Span[][] }
  | { kind: 'quote'; spans: Span[] }
  | { kind: 'rule' }
  | { kind: 'table'; head: Span[][]; rows: Span[][][] }
  /** La salida de emergencia: texto tal cual, sin formatear. */
  | { kind: 'raw'; text: string };

// ---- enlaces ----------------------------------------------------------------

/**
 * Si un destino se puede pulsar, y de qué manera.
 *
 * Las rutas internas se reconocen por empezar con una sola barra, y van por el `Link` de la casa
 * en vez de por un `<a href>`: un ancla cruda recarga la aplicación entera y mata el `EventSource`
 * del chat, o sea que pulsar un enlace de un mensaje te costaría el stream de la conversación.
 * `//host` no es una ruta interna aunque lo parezca —es un esquema relativo— y por eso se descarta
 * aparte.
 */
export function classifyHref(raw: string): { href: string; internal: boolean } | null {
  const href = raw.trim();
  if (!href) return null;
  if (href.startsWith('//')) return null;
  if (href.startsWith('/')) return { href, internal: true };
  try {
    // Base cualquiera: sólo se usa para leer el esquema de una URL absoluta.
    const parsed = new URL(href, 'https://jarvis.invalid');
    if (!SAFE_SCHEMES.includes(parsed.protocol)) return null;
    // Una relativa sin esquema habría resuelto contra la base: eso no es un destino, es un texto.
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return null;
    return { href, internal: false };
  } catch {
    return null;
  }
}

// ---- lo de dentro de una línea ----------------------------------------------

/**
 * El código en línea se resuelve **antes** que nada.
 *
 * Dentro de unas comillas invertidas no hay negrita ni enlaces: `**esto**` es literalmente eso, y
 * es justo lo que alguien escribe cuando está explicando la sintaxis. Resolverlo primero es lo que
 * evita que el ejemplo se convierta en el ejemplo aplicado.
 */
const INLINE_CODE = /`([^`]+)`/;
const LINK = /\[([^\]]*)\]\(([^)\s]+)\)/;
const STRONG = /\*\*([^*]+)\*\*/;
const EM = /\*([^*]+)\*/;

export function parseSpans(source: string): Span[] {
  const spans: Span[] = [];
  let rest = source;

  const pushText = (text: string): void => {
    if (!text) return;
    // El salto duro es un `\n` dentro del párrafo: el modelo lo usa y se respeta.
    const pieces = text.split('\n');
    pieces.forEach((piece, index) => {
      if (index > 0) spans.push({ kind: 'break' });
      if (piece) spans.push({ kind: 'text', text: piece });
    });
  };

  while (rest) {
    const code = INLINE_CODE.exec(rest);
    const link = LINK.exec(rest);
    const strong = STRONG.exec(rest);
    const em = EM.exec(rest);

    const candidates = [
      code ? { at: code.index, match: code, kind: 'code' as const } : null,
      link ? { at: link.index, match: link, kind: 'link' as const } : null,
      strong ? { at: strong.index, match: strong, kind: 'strong' as const } : null,
      em ? { at: em.index, match: em, kind: 'em' as const } : null,
    ].filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);

    if (!candidates.length) {
      pushText(rest);
      break;
    }

    // El que empieza antes gana; a igualdad, el más específico, que es el orden de la lista.
    const winner = candidates.reduce((best, candidate) => (candidate.at < best.at ? candidate : best));
    pushText(rest.slice(0, winner.at));
    const [whole, first, second] = winner.match;

    if (winner.kind === 'code') {
      spans.push({ kind: 'code', text: first ?? '' });
    } else if (winner.kind === 'link') {
      const target = classifyHref(second ?? '');
      const label = first ?? '';
      if (target) {
        spans.push({ kind: 'link', href: target.href, internal: target.internal, spans: parseSpans(label) });
      } else {
        // Un destino que no se puede pulsar no desaparece: se enseña lo que decía, entero.
        pushText(`${label} (${second ?? ''})`);
      }
    } else if (winner.kind === 'strong') {
      spans.push({ kind: 'strong', spans: parseSpans(first ?? '') });
    } else {
      spans.push({ kind: 'em', spans: parseSpans(first ?? '') });
    }

    rest = rest.slice(winner.at + whole.length);
  }

  return spans;
}

// ---- los bloques ------------------------------------------------------------

const HEADING = /^(#{1,3})\s+(.*)$/;
const BULLET = /^[-*]\s+(.*)$/;
const ORDERED = /^\d+[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const RULE = /^(-{3,}|\*{3,}|_{3,})$/;
const FENCE = /^```\s*([A-Za-z0-9+#._-]*)\s*$/;

/** Una fila de tabla: `| a | b |`. Se acepta sin las barras de los extremos. */
const cells = (line: string): string[] =>
  line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim());

const isSeparator = (line: string): boolean =>
  /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

/**
 * De texto a bloques.
 *
 * Pura y sin React a propósito: es donde están todos los casos raros, y aquí se pueden probar sin
 * DOM. Nunca lanza — un markdown mal cerrado no puede dejar una respuesta sin pintar, así que lo
 * que no encaja acaba siendo un párrafo.
 */
export function parseMarkdown(source: string): Block[] {
  if (!source) return [];
  /*
   * El tope se mide en bytes y no en caracteres porque lo que se quiere acotar es el trabajo, y
   * una respuesta llena de acentos o de CJK pesa el doble de lo que mide.
   */
  if (new TextEncoder().encode(source).length > MAX_MARKDOWN_BYTES) {
    return [{ kind: 'raw', text: source }];
  }

  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  /** Lo que se va acumulando de un párrafo, para cerrarlo cuando cambie la clase de línea. */
  let paragraph: string[] = [];
  const flush = (): void => {
    if (!paragraph.length) return;
    blocks.push({ kind: 'paragraph', spans: parseSpans(paragraph.join('\n')) });
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();

    if (!trimmed) {
      flush();
      index += 1;
      continue;
    }

    const fence = FENCE.exec(trimmed);
    if (fence) {
      flush();
      const lang = fence[1] ? fence[1] : null;
      const body: string[] = [];
      index += 1;
      // Una valla sin cerrar llega hasta el final: es un modelo que se quedó a medias, no un error
      // de quien lee, y perder el contenido sería lo peor que se puede hacer con él.
      while (index < lines.length && !FENCE.test((lines[index] ?? '').trim())) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      index += 1;
      blocks.push({ kind: 'code', lang, text: body.join('\n') });
      continue;
    }

    if (RULE.test(trimmed)) {
      flush();
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }

    const heading = HEADING.exec(trimmed);
    if (heading) {
      flush();
      blocks.push({
        kind: 'heading',
        level: (heading[1]?.length ?? 1) as 1 | 2 | 3,
        spans: parseSpans(heading[2] ?? ''),
      });
      index += 1;
      continue;
    }

    // Tabla: una fila de cabecera seguida de la línea de guiones. Sin la segunda no es una tabla.
    if (trimmed.includes('|') && isSeparator(lines[index + 1]?.trim() ?? '')) {
      flush();
      const head = cells(trimmed).map((cell) => parseSpans(cell));
      index += 2;
      const rows: Span[][][] = [];
      while (index < lines.length && (lines[index] ?? '').includes('|') && (lines[index] ?? '').trim()) {
        rows.push(cells((lines[index] ?? '').trim()).map((cell) => parseSpans(cell)));
        index += 1;
      }
      blocks.push({ kind: 'table', head, rows });
      continue;
    }

    const bullet = BULLET.exec(trimmed);
    const ordered = ORDERED.exec(trimmed);
    if (bullet || ordered) {
      flush();
      const isOrdered = Boolean(ordered);
      const items: Span[][] = [];
      while (index < lines.length) {
        const current = (lines[index] ?? '').trim();
        const match = isOrdered ? ORDERED.exec(current) : BULLET.exec(current);
        if (!match) break;
        items.push(parseSpans(match[1] ?? ''));
        index += 1;
      }
      blocks.push({ kind: 'list', ordered: isOrdered, items });
      continue;
    }

    const quote = QUOTE.exec(trimmed);
    if (quote) {
      flush();
      const body: string[] = [];
      while (index < lines.length) {
        const match = QUOTE.exec((lines[index] ?? '').trim());
        if (!match) break;
        body.push(match[1] ?? '');
        index += 1;
      }
      blocks.push({ kind: 'quote', spans: parseSpans(body.join('\n')) });
      continue;
    }

    paragraph.push(line);
    index += 1;
  }

  flush();
  return blocks;
}

// ---- de descriptores a nodos ------------------------------------------------

/**
 * El texto va siempre en su propio `<span class="md-text">`.
 *
 * No es decoración: ahí vive el `overflow-wrap: anywhere` que impide que una línea de log sin
 * espacios reviente el ancho de la burbuja. Si el texto quedara suelto dentro de un `<p>`, la
 * regla se aplicaría al contenedor y no al nodo que desborda, y el fallo vuelve — con el agravante
 * de que sólo se ve con contenido de verdad, o sea nunca en una captura de pruebas.
 */
function Spans({ spans }: { spans: Span[] }): ReactNode {
  return spans.map((span, index) => {
    const key = index;
    switch (span.kind) {
      case 'text':
        return <span key={key} className="md-text">{span.text}</span>;
      case 'code':
        return <code key={key} className="md-code">{span.text}</code>;
      case 'strong':
        return <strong key={key}><Spans spans={span.spans} /></strong>;
      case 'em':
        return <em key={key}><Spans spans={span.spans} /></em>;
      case 'break':
        return <br key={key} />;
      case 'link':
        return span.internal
          ? <Link key={key} to={span.href} className="md-link"><Spans spans={span.spans} /></Link>
          : (
            // `noreferrer` además de `noopener`: el destino no tiene por qué saber de qué
            // conversación salió, y el enlace lo escribió un modelo, no una persona.
            <a key={key} className="md-link" href={span.href} target="_blank" rel="noopener noreferrer">
              <Spans spans={span.spans} />
            </a>
          );
    }
  });
}

/**
 * El encabezado, empezando en `h3`.
 *
 * Los niveles de esta pantalla son `h1` para el título de página y `h2` para el del hilo, así que
 * `h3` es el siguiente sin saltarse ninguno. Empezar en `h4` —que era la idea inicial— habría
 * creado el salto que se quería evitar, porque las tarjetas de aprobación con su `h3` se pintan
 * **después** de los mensajes. Y no lo cazaría nadie: la suite de accesibilidad filtra por
 * etiquetas WCAG y `heading-order` de axe está marcada como buena práctica, no como WCAG.
 */
function Heading({ level, spans }: { level: 1 | 2 | 3; spans: Span[] }): JSX.Element {
  const Tag = (['h3', 'h4', 'h5'] as const)[level - 1] ?? 'h5';
  return <Tag className="md-heading"><Spans spans={spans} /></Tag>;
}

function BlockView({ block }: { block: Block }): JSX.Element {
  switch (block.kind) {
    case 'paragraph':
      return <p className="md-p"><Spans spans={block.spans} /></p>;
    case 'heading':
      return <Heading level={block.level} spans={block.spans} />;
    case 'code':
      return (
        // La valla quiere lo contrario que el texto: scroll horizontal, nunca partir por cualquier
        // sitio. Romper un identificador a mitad hace el código ilegible, que es justo lo que no
        // se le puede hacer a lo único que alguien va a copiar y pegar.
        <pre className="md-pre" {...(block.lang ? { 'data-lang': block.lang } : {})}>
          <code>{block.text}</code>
        </pre>
      );
    case 'list':
      return block.ordered
        ? <ol className="md-list">{block.items.map((item, index) => <li key={index}><Spans spans={item} /></li>)}</ol>
        : <ul className="md-list">{block.items.map((item, index) => <li key={index}><Spans spans={item} /></li>)}</ul>;
    case 'quote':
      return <blockquote className="md-quote"><Spans spans={block.spans} /></blockquote>;
    case 'rule':
      return <hr className="md-rule" />;
    case 'table':
      return (
        // Con su propio contenedor desplazable: una tabla ancha dentro de una burbuja que en móvil
        // ocupa el 100 % sacaría barra horizontal a la página entera.
        <div className="md-table-wrap">
          {/*
            * Tabla propia y no la `.table` del producto: aquella se convierte en tarjetas apiladas
            * por debajo de 900 px y **esconde la cabecera**, que funciona en la lista de trabajos
            * —cada celda se reconoce sola— y no aquí, donde las columnas las nombra el modelo y sin
            * cabecera no significan nada.
            */}
          <table className="md-table">
            <thead>
              <tr>{block.head.map((cell, index) => <th key={index}><Spans spans={cell} /></th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => <td key={cellIndex}><Spans spans={cell} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'raw':
      return <pre className="md-pre md-raw"><code>{block.text}</code></pre>;
  }
}

/**
 * El markdown de una respuesta.
 *
 * Sólo se usa con `role === 'assistant'`. Lo que escribió la persona se pinta literal —nadie
 * quiere que su propio mensaje cambie de forma al enviarlo— y lo de `role === 'tool'` sigue en
 * `<pre>`, porque es un volcado y no un texto.
 */
export function Markdown({ source }: { source: string }): JSX.Element {
  const blocks = parseMarkdown(source);
  return <div className="md">{blocks.map((block, index) => <BlockView key={index} block={block} />)}</div>;
}
