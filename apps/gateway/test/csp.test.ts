/**
 * La CSP del documento de la aplicación, fijada.
 *
 * Se escribe una prueba porque hay una directiva que **es lo único que impide una fuga**, y no se
 * nota si desaparece. Un artifact HTML se pinta en un iframe con origen opaco, así que no puede
 * leer nada de la aplicación; lo que sí puede es navegarse a sí mismo a una URL de fuera y
 * anunciar así la IP de quien lo abrió y el hecho de que lo abrió. Eso no lo bloquea ninguna
 * directiva del propio iframe: la navegación de un contexto anidado se comprueba contra el
 * `frame-src` **del documento que lo embebe**, que es el que se escribe aquí.
 *
 * Aflojarlo sería un cambio razonable con un motivo razonable —«que se vea el mapa», «que se vea
 * el vídeo»— hecho por alguien que no sabe que ahí cuelga esto. La prueba no lo impide: hace que
 * haya que decidirlo.
 *
 * Se prueba `securityHeaders()` y no una petición de verdad porque el servidor de estáticos
 * contesta 503 sin bundle delante, y montar un directorio para leer una cabecera mediría el
 * montaje en vez de la cabecera.
 */
import type { FastifyReply } from 'fastify';
import { describe, expect, it } from 'vitest';
import { securityHeaders } from '../src/static.js';

/** Lo justo de una respuesta para recoger cabeceras: `securityHeaders` sólo llama a `header()`. */
function recorder(): { reply: FastifyReply; headers: Map<string, string> } {
  const headers = new Map<string, string>();
  const reply = {
    header(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, headers };
}

/** Las directivas por nombre, para afirmar sobre una sin depender del orden ni del espaciado. */
const directives = (header: string): Map<string, string> => new Map(
  header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [name, ...values] = part.split(/\s+/);
    return [name ?? '', values.join(' ')] as const;
  }),
);

const cspOf = (): Map<string, string> => {
  const { reply, headers } = recorder();
  securityHeaders(reply, { isHtml: true }, true);
  const header = headers.get('content-security-policy');
  if (!header) throw new Error('el documento salió sin CSP');
  return directives(header);
};

describe('la CSP del documento de la aplicación', () => {
  it('no deja que un contexto anidado se navegue fuera', () => {
    /*
     * Explícito y no heredado del `default-src`. Cae en `'self'` igual por el fallback, pero
     * escrito es lo que hace que quien lo cambie vea lo que está abriendo.
     */
    expect(cspOf().get('frame-src')).toBe("'self'");
  });

  it('mantiene lo demás que sostiene el aislamiento', () => {
    const csp = cspOf();
    // Nada de terceros ejecutando en el origen de la aplicación.
    expect(csp.get('script-src')).toBe("'self'");
    // `base-uri` y `object-src` no caen en `default-src`: si no están escritos, no existen.
    expect(csp.get('base-uri')).toBe("'self'");
    expect(csp.get('object-src')).toBe("'none'");
    // La consola no se embebe en ningún sitio: el clickjacking sobre una aprobación sería caro.
    expect(csp.get('frame-ancestors')).toBe("'none'");
  });

  it('un recurso que no es documento no lleva CSP, pero sí el resto de cabeceras', () => {
    const { reply, headers } = recorder();
    securityHeaders(reply, { isHtml: false }, true);
    expect(headers.has('content-security-policy')).toBe(false);
    expect(headers.get('x-frame-options')).toBe('DENY');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('sin cookies seguras no se promete HSTS, que sería mentir sobre el transporte', () => {
    const { reply, headers } = recorder();
    securityHeaders(reply, { isHtml: true }, false);
    expect(headers.has('strict-transport-security')).toBe(false);
  });
});
