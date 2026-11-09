/**
 * Buscar sesiones por trozos de palabra.
 *
 * Quien busca teclea el principio de lo que recuerda —«vul» por vultr, «migra» por migraciones—
 * y espera verlo aparecer letra a letra. El índice no hace eso por sí solo, por dos razones:
 *
 *   · su FTS5 compara palabras enteras: `vul` sólo encuentra el token `vul`, no `vultr`;
 *   · y la máquina no está en el texto indexado (título, carpeta, proveedor y conversación), así
 *     que ni la palabra entera la encontraba.
 *
 * Por eso la búsqueda va por dos caminos que se suman: la conversación se busca en el índice con
 * cada término como prefijo (`"vul"*`), y los datos de la ficha —máquina, título, el nombre que se
 * le puso aquí, carpeta, modelo, id— se comparan como subcadena sobre la lista entera, que es
 * pequeña (decenas de sesiones, no miles) y ya se pide para la portada.
 *
 * Mayúsculas y tildes no cuentan, igual que en el índice (`remove_diacritics`).
 */
import type { SessionSummary } from '@jarvis/contracts';

/** Sin tildes ni mayúsculas: «Migración» y «migracion» son la misma búsqueda. */
export const fold = (text: string): string =>
  text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();

/** Los términos de una búsqueda, ya plegados. Vacío si no hay nada que buscar. */
export function searchTerms(q: string | undefined): string[] {
  return fold(q ?? '').split(/\s+/).filter(Boolean);
}

/**
 * La consulta FTS5 equivalente: cada término como prefijo, y todos obligatorios.
 *
 * Cada término va entre comillas para que su puntuación no se lea como sintaxis —`jarvis-next`
 * sería «jarvis menos next»—, con las comillas internas dobladas que es como FTS5 las escapa. Lo
 * que dentro de las comillas no es letra ni cifra lo parte el tokenizador igual que partió el
 * texto, así que `jarvis-next` busca la frase «jarvis next…».
 */
export function prefixQuery(terms: string[]): string {
  return terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(' ');
}

/** Todos los términos aparecen en algún dato de la ficha, cada uno donde sea. */
export function matchesCard(session: SessionSummary, terms: string[]): boolean {
  if (!terms.length) return true;
  const card = fold([
    session.ref.host,
    session.ref.provider,
    session.ref.sessionId,
    session.title,
    session.workspaceTitle,
    session.cwd,
    session.model,
  ].filter(Boolean).join('\n'));
  return terms.every((term) => card.includes(term));
}
