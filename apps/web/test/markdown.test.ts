/**
 * El parser de markdown del asistente.
 *
 * Se prueba la función pura y no lo renderizado: aquí están los casos que de verdad importan —los
 * esquemas de enlace, el tope de tamaño, lo que llega mal cerrado— y ninguno necesita un DOM. El
 * componente de encima sólo traduce descriptores a nodos.
 *
 * Lo que se afirma no es «soporta markdown», que sería una promesa que no queremos hacer, sino el
 * acuerdo exacto entre el prompt del modelo y lo que la burbuja sabe pintar.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_MARKDOWN_BYTES, classifyHref, parseMarkdown, parseSpans, type Block, type Span,
} from '../src/ui/markdown.jsx';

/** El texto plano de un árbol de spans, para afirmar sin escribir el árbol entero. */
const flat = (spans: Span[]): string => spans.map((span) => {
  switch (span.kind) {
    case 'text': return span.text;
    case 'code': return span.text;
    case 'break': return '\n';
    default: return flat(span.spans);
  }
}).join('');

const first = (blocks: Block[]): Block => {
  const block = blocks[0];
  if (!block) throw new Error('no se produjo ningún bloque');
  return block;
};

describe('destinos de enlace', () => {
  it('acepta los tres esquemas del acuerdo', () => {
    expect(classifyHref('https://ejemplo.test/a')).toEqual({ href: 'https://ejemplo.test/a', internal: false });
    expect(classifyHref('http://ejemplo.test')).toEqual({ href: 'http://ejemplo.test', internal: false });
    expect(classifyHref('mailto:alguien@ejemplo.test')).toEqual({ href: 'mailto:alguien@ejemplo.test', internal: false });
  });

  it('marca las rutas de la casa como internas, que es lo que las manda por Link', () => {
    expect(classifyHref('/runs/abc')).toEqual({ href: '/runs/abc', internal: true });
  });

  /*
   * El motivo de la lista blanca. `javascript:` es ejecución, y `data:`/`blob:` son un documento
   * entero escrito por quien redactó el mensaje —que aquí es un modelo que acaba de leer una
   * máquina—. Ninguno de los tres es un sitio al que llevar a nadie desde una respuesta.
   */
  it.each(['javascript:alert(1)', 'data:text/html,<script>', 'blob:https://x/y', 'file:///etc/passwd', 'vbscript:x'])(
    'rechaza %s',
    (href) => { expect(classifyHref(href)).toBeNull(); },
  );

  it('rechaza el esquema relativo, que parece una ruta interna y no lo es', () => {
    expect(classifyHref('//evil.test/x')).toBeNull();
  });

  it('rechaza lo que no lleva esquema, para que no resuelva contra una base inventada', () => {
    expect(classifyHref('ejemplo.test/a')).toBeNull();
    expect(classifyHref('   ')).toBeNull();
  });

  it('un enlace rechazado no desaparece: se lee lo que decía', () => {
    const spans = parseSpans('mira [aquí](javascript:alert(1))');
    expect(spans.some((span) => span.kind === 'link')).toBe(false);
    expect(flat(spans)).toContain('aquí');
    expect(flat(spans)).toContain('javascript:alert(1');
  });
});

describe('dentro de una línea', () => {
  it('el código en línea gana a todo lo demás', () => {
    const spans = parseSpans('usa `**esto**` tal cual');
    const code = spans.find((span) => span.kind === 'code');
    expect(code).toEqual({ kind: 'code', text: '**esto**' });
    expect(spans.some((span) => span.kind === 'strong')).toBe(false);
  });

  it('negrita y cursiva se distinguen', () => {
    expect(parseSpans('**fuerte**')[0]).toMatchObject({ kind: 'strong' });
    expect(parseSpans('*suave*')[0]).toMatchObject({ kind: 'em' });
  });

  it('un salto de línea dentro del párrafo es un salto duro', () => {
    const spans = parseSpans('una\notra');
    expect(spans.map((span) => span.kind)).toEqual(['text', 'break', 'text']);
  });

  it('el HTML crudo sale como texto y no como etiqueta', () => {
    const spans = parseSpans('<img src=x onerror=alert(1)>');
    expect(spans.every((span) => span.kind === 'text')).toBe(true);
    expect(flat(spans)).toBe('<img src=x onerror=alert(1)>');
  });

  it('una imagen se queda en enlace, que dice a dónde va antes de ir', () => {
    const spans = parseSpans('![alt](https://ejemplo.test/x.png)');
    const link = spans.find((span) => span.kind === 'link');
    expect(link).toMatchObject({ kind: 'link', href: 'https://ejemplo.test/x.png' });
    expect(flat(spans)).toContain('!');
  });
});

describe('bloques', () => {
  it('los encabezados empiezan en el nivel 1 del acuerdo, que el componente lleva a h3', () => {
    expect(first(parseMarkdown('# uno'))).toMatchObject({ kind: 'heading', level: 1 });
    expect(first(parseMarkdown('## dos'))).toMatchObject({ kind: 'heading', level: 2 });
    expect(first(parseMarkdown('### tres'))).toMatchObject({ kind: 'heading', level: 3 });
  });

  it('cuatro almohadillas no son un encabezado: quedan fuera del subconjunto', () => {
    expect(first(parseMarkdown('#### cuatro'))).toMatchObject({ kind: 'paragraph' });
  });

  it('la valla guarda su lenguaje y no toca su contenido', () => {
    const block = first(parseMarkdown('```ts\nconst a = **1**;\n```'));
    expect(block).toEqual({ kind: 'code', lang: 'ts', text: 'const a = **1**;' });
  });

  it('una valla sin cerrar no pierde lo que llevaba dentro', () => {
    const block = first(parseMarkdown('```\nprimera\nsegunda'));
    expect(block).toMatchObject({ kind: 'code', text: 'primera\nsegunda' });
  });

  it('listas con guion y numeradas, un nivel', () => {
    const lista = first(parseMarkdown('- uno\n- dos'));
    expect(lista).toMatchObject({ kind: 'list', ordered: false });
    expect((lista as { items: Span[][] }).items).toHaveLength(2);
    expect(first(parseMarkdown('1. uno\n2. dos'))).toMatchObject({ kind: 'list', ordered: true });
  });

  it('la cita junta sus líneas', () => {
    const block = first(parseMarkdown('> una\n> otra'));
    expect(block.kind).toBe('quote');
    expect(flat((block as { spans: Span[] }).spans)).toBe('una\notra');
  });

  it('la tabla necesita su línea de guiones para serlo', () => {
    const tabla = first(parseMarkdown('| a | b |\n|---|---|\n| 1 | 2 |'));
    expect(tabla).toMatchObject({ kind: 'table' });
    expect((tabla as { rows: Span[][][] }).rows).toHaveLength(1);
    // Sin la segunda línea es texto con barras, no una tabla a medias.
    expect(first(parseMarkdown('| a | b |'))).toMatchObject({ kind: 'paragraph' });
  });

  it('una tabla mal cerrada no rompe nada', () => {
    expect(() => parseMarkdown('| a | b |\n|---|---|\n| 1 |')).not.toThrow();
  });

  it('la regla horizontal se distingue de una lista', () => {
    expect(first(parseMarkdown('---'))).toEqual({ kind: 'rule' });
  });
});

describe('el tope de tamaño', () => {
  it('por debajo del tope se formatea', () => {
    expect(first(parseMarkdown('# hola'))).toMatchObject({ kind: 'heading' });
  });

  it('por encima cae a texto crudo entero, sin perder nada', () => {
    const enorme = `# hola\n${'a'.repeat(MAX_MARKDOWN_BYTES)}`;
    const blocks = parseMarkdown(enorme);
    expect(blocks).toHaveLength(1);
    expect(first(blocks)).toMatchObject({ kind: 'raw', text: enorme });
  });

  it('el tope se mide en bytes, no en caracteres', () => {
    // Cada carácter ocupa tres bytes: con un tercio del tope en caracteres ya se pasa.
    const acentos = '€'.repeat(Math.ceil(MAX_MARKDOWN_BYTES / 3) + 1);
    expect(acentos.length).toBeLessThan(MAX_MARKDOWN_BYTES);
    expect(first(parseMarkdown(acentos))).toMatchObject({ kind: 'raw' });
  });
});

describe('lo que nunca puede pasar', () => {
  it('ningún texto lo tumba', () => {
    const raros = [
      '', '\n\n\n', '```', '```\n```', '> ', '- ', '1.', '|', '|---|', '[', '](', '**', '`',
      '***todo***', '[a](b)(c)', '#'.repeat(20), '\r\n\r\n', '- uno\n\n- dos',
    ];
    for (const texto of raros) expect(() => parseMarkdown(texto)).not.toThrow();
  });
});
