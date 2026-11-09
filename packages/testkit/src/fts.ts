/**
 * Lo que hace el FTS5 del índice de verdad con una consulta, en pequeño.
 *
 * Los índices falsos filtraban por subcadena del título, y eso es más generoso que el de verdad:
 * con ellos «vul» encontraba «vultr» y ninguna prueba podía ver que en producción no. Aquí se
 * copia la regla que importa —`unicode61 remove_diacritics 2`: se compara por palabras, sin
 * tildes ni mayúsculas, y una palabra suelta tiene que estar entera— y la sintaxis que manda el
 * core: `"x"*` es prefijo, y una frase entre comillas son palabras seguidas.
 *
 * El mismo código vive en `bin/fake-index.mjs`, que corre suelto y no puede importar esto.
 */
const words = (text: string): string[] =>
  text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

export function ftsMatch(query: string, columns: Array<string | null | undefined>): boolean {
  const doc = words(columns.filter(Boolean).join(' '));
  const terms = [...query.matchAll(/"((?:[^"]|"")*)"(\*?)|(\S+)/g)].map((match) => (
    match[3] !== undefined
      ? { phrase: words(match[3]), prefix: false }
      : { phrase: words((match[1] ?? '').replaceAll('""', '"')), prefix: match[2] === '*' }
  )).filter((term) => term.phrase.length);
  if (!terms.length) return false;
  return terms.every(({ phrase, prefix }) => doc.some((_, start) => phrase.every((word, offset) => {
    const token = doc[start + offset];
    if (token === undefined) return false;
    return prefix && offset === phrase.length - 1 ? token.startsWith(word) : token === word;
  })));
}
