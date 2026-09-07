/**
 * Que una errata en el entorno no conceda permisos.
 *
 * `config.ts` decide con qué autonomía nacen las conversaciones, qué servidores MCP pueden
 * escribir, si el modo «Sin preguntar» está abierto y cuántas funciones caben. Hasta hace poco **no
 * lo comprobaba nada**, y eso es un hueco raro: es el fichero que traduce lo que alguien escribió a
 * mano en un `.env` a lo que la máquina hace sola.
 *
 * Lo que se fija aquí no es «que lea bien la variable», que es trivial. Es la **dirección en la que
 * cae cuando no la entiende**: hacia preguntar más, nunca hacia dejar pasar.
 *
 * La primera versión reemplazaba `process.env` y reimportaba el módulo, y eso daba rojas
 * intermitentes: `process.env` es global al proceso y los ficheros de prueba corren en paralelo,
 * así que un caso que sustituye el entorno mientras otro lo lee falla y luego pasa al repetir. Lo
 * cazó jarvis-f9 al ver que los plazos eran redondos —5 s— en unos casos y no en otros. Ahora el
 * entorno es un argumento: probar esto no toca nada de nadie.
 */
import { describe, expect, it } from 'vitest';
import { buildConfig } from '../src/config.js';

/** Un entorno limpio: sólo lo que cada caso declara, sin heredar el de quien corre las pruebas. */
const con = (vars: Record<string, string | undefined> = {}): ReturnType<typeof buildConfig> =>
  buildConfig(vars as NodeJS.ProcessEnv);

describe('CONFIG · una errata no puede abrir una puerta', () => {
  it('una autonomía que no existe cae en manual, no en «ninguno de los dos»', () => {
    /*
     * El caso del informe: el gate del toolbox preguntaba «¿es manual? ¿es auto y no seguro?», así
     * que `'Manual'` con mayúscula no era ninguno y **no preguntaba nada**. Un trabajo con permiso
     * de escritura salía sin tarjeta por una tecla.
     */
    for (const escrito of ['Manual', 'automatico', 'AUTO', 'foo', '']) {
      expect(con({ JARVIS_CHAT_DEFAULT_AUTONOMY: escrito }).chatDefaultAutonomy,
        `«${escrito}» debería caer en manual`).toBe('manual');
    }
  });

  it('las tres autonomías buenas se respetan', () => {
    // La otra mitad, y hace falta: un saneador que lo mandara todo a `manual` también pasaría la
    // prueba de arriba, y habría roto el producto.
    for (const modo of ['manual', 'auto', 'unrestricted'] as const) {
      expect(con({ JARVIS_CHAT_DEFAULT_AUTONOMY: modo }).chatDefaultAutonomy).toBe(modo);
    }
  });

  it('los interruptores que conceden nacen apagados', () => {
    /*
     * Lo que se fija no es cada uno: es que **la ausencia signifique «no»**. Un interruptor que
     * concede y se enciende solo cuando falta su variable es la forma más silenciosa de abrir algo.
     */
    const config = con();
    expect(config.chatAllowUnrestricted).toBe(false);
    expect(config.allowYolo).toBe(false);
    expect(config.mcpWriteServers).toBe('');
    expect(config.mcpTrustUntagged).toBe('');
  });

  it('un booleano escrito de cualquier manera razonable se entiende, y lo raro no enciende', () => {
    for (const si of ['1', 'true', 'yes', 'on', 'TRUE']) {
      expect(con({ JARVIS_ALLOW_UNRESTRICTED: si }).chatAllowUnrestricted, si).toBe(true);
    }
    // Y lo que no se entiende **no enciende**, que es la mitad que importa: `'sí'`, `'2'` o un
    // espacio son cosas que alguien escribe de verdad creyendo que activan algo.
    for (const no of ['sí', 'si', '2', ' ', 'verdadero', 'ok']) {
      expect(con({ JARVIS_ALLOW_UNRESTRICTED: no }).chatAllowUnrestricted, no).toBe(false);
    }
  });

  it('los plazos se pueden cambiar sin tocar código, y el de las tarjetas también', () => {
    /*
     * Era el único plazo de la casa sin variable: estaba escrito dos veces —chat y planes— con un
     * `?? 30 * 60 * 1000` que nadie pasaba. Y no es un detalle de configuración: cuando una tarjeta
     * caduca a mitad de un plan, el plan **entero** se termina y los pasos hechos se pierden.
     */
    expect(con().approvalTtlMs).toBe(8 * 60 * 60 * 1000);
    expect(con({ JARVIS_APPROVAL_TTL_MS: '600000' }).approvalTtlMs).toBe(600_000);
  });

  it('sin hosts declarados sólo se alcanza el bastión, nunca la flota entera', () => {
    // Una allowlist vacía que significara «todos» convertiría una variable olvidada en ejecución
    // remota arbitraria. Se comprueba aquí porque es la misma clase de decisión.
    expect(con({ JARVIS_BASTION_HOST: 'bastion' }).hosts).toEqual(['bastion']);
  });

  it('leer la configuración no toca el entorno de nadie', () => {
    /*
     * La prueba de la prueba. La versión anterior de este fichero reemplazaba `process.env` y por
     * eso daba rojas que desaparecían al repetir; fijarlo aquí es lo que impide que alguien vuelva
     * a hacerlo dentro de seis meses para «poder probar un caso más».
     */
    const antes = { ...process.env };
    con({ JARVIS_ALLOW_UNRESTRICTED: 'true', JARVIS_HOSTS: 'inventado' });
    expect(process.env).toEqual(antes);
  });
});
