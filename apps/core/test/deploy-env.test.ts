/**
 * Que lo que se le pide a un operador llegue de verdad al contenedor.
 *
 * Este repositorio se ha comido **cuatro ajustes** por el mismo camino: alguien añade una variable,
 * la documenta en `.env.example`, la escribe en el `.env` del bastión, y no llega porque Compose
 * sólo pasa lo que se le declara. El síntoma no es un error: es que el ajuste no hace nada. Ya
 * pasó con el tope de generación del asistente, con `JARVIS_VERBOSE`, y esta noche con
 * `JARVIS_ALLOW_UNRESTRICTED`, cuyo guardarraíl verifiqué en producción sin darme cuenta de que el
 * resultado habría sido idéntico con el flag encendido y sin cablear.
 *
 * Está documentado en el runbook con fecha y ha vuelto a pasar dos veces desde entonces, así que
 * el sitio donde escribirlo no era un documento: nadie lee el runbook cuando añade una línea a
 * `config.ts`. Esto sí se lee solo.
 *
 * Vive en las pruebas del core porque el fallo que evita es del core —lee una variable que nunca
 * llega— y porque tiene que correr en el proyecto rápido: una prueba que sólo salta en la suite
 * larga no llega a tiempo de evitar el commit.
 *
 * **Lo que no comprueba, y conviene saberlo:** una variable que el core lee y que no está en
 * `.env.example` no se mira. Es a propósito —hay decenas de perillas internas con buen valor por
 * defecto que nadie debería tener que declarar— pero significa que la protección empieza cuando
 * alguien documenta el ajuste. Documentarlo es lo primero que se hace y lo último que se olvida;
 * cablearlo era lo que se olvidaba.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DEPLOY = new URL('../../../deploy/', import.meta.url).pathname;

/** Los `KEY=` del ejemplo, que es lo que un operador copia a su `.env`. */
function documentedKeys(): string[] {
  const text = readFileSync(join(DEPLOY, '.env.example'), 'utf8');
  const keys = new Set<string>();
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    if (match?.[1]) keys.add(match[1]);
  }
  return [...keys].sort();
}

/**
 * Todos los ficheros de compose juntos, incluidos los overlays.
 *
 * Los overlays cuentan porque una variable puede existir sólo para un modo —`JARVIS_LAN_PORT` vive
 * en `compose.lan.yml` y en `compose.host-tls.yml`, no en el base— y exigirla en el principal
 * obligaría a declararla donde no significa nada.
 */
function composeText(): string {
  return readdirSync(DEPLOY)
    .filter((name) => name.startsWith('compose') && name.endsWith('.yml'))
    .map((name) => readFileSync(join(DEPLOY, name), 'utf8'))
    .join('\n');
}

describe('lo que se documenta en .env.example llega al contenedor', () => {
  it('cada variable documentada se interpola en algún fichero de compose', () => {
    const compose = composeText();
    /*
     * Se busca `${CLAVE`, que es la única forma en que Compose la usa.
     *
     * No se busca `CLAVE:` porque eso encuentra la clave del bloque `environment` aunque su valor
     * esté escrito a mano, que es precisamente el caso en que el `.env` no manda. Y no se busca la
     * clave a secas porque aparecería en cualquier comentario que la mencione — y un comentario
     * que la nombra es exactamente lo que hace creer que está cableada.
     */
    const missing = documentedKeys().filter((key) => !compose.includes(`\${${key}`));
    expect(missing, missing.length
      ? `estas variables se documentan en deploy/.env.example y ningún compose las usa, así que `
        + `ponerlas en el .env no hace nada:\n  ${missing.join('\n  ')}\n`
        + `Añádelas al bloque environment del servicio que las necesite, como `
        + `NOMBRE: \${NOMBRE:-valor por defecto}.`
      : '').toEqual([]);
  });

  it('el ejemplo no está vacío, para que la comprobación no pase por no mirar nada', () => {
    // Sin esto, renombrar el fichero dejaría la prueba en verde sin comprobar nada, que es la
    // forma en que una salvaguarda deja de existir sin que nadie se entere.
    expect(documentedKeys().length).toBeGreaterThan(10);
  });
});
