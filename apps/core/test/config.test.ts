/**
 * Que una errata en el entorno no conceda permisos.
 *
 * `config.ts` decide con qué autonomía nacen las conversaciones, qué servidores MCP pueden
 * escribir, si el modo «Sin preguntar» está abierto y cuántas funciones caben. Hasta ahora **no lo
 * comprobaba nada**, y eso es un hueco raro: es el fichero que traduce lo que alguien escribió a
 * mano en un `.env` a lo que la máquina hace sola.
 *
 * Lo que se fija aquí no es «que lea bien la variable», que es trivial. Es la **dirección en la que
 * cae cuando no la entiende**: hacia preguntar más, nunca hacia dejar pasar.
 *
 * `config` se lee al importar el módulo, así que cada caso reimporta con su entorno. `resetModules`
 * es lo que hace que eso funcione, y sin él todas las pruebas verían la primera lectura.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const entorno = { ...process.env };

afterEach(() => {
  process.env = { ...entorno };
  vi.resetModules();
});

async function conEntorno(vars: Record<string, string | undefined>): Promise<typeof import('../src/config.js')['config']> {
  process.env = { ...entorno, ...vars };
  vi.resetModules();
  return (await import('../src/config.js')).config;
}

describe('CONFIG · una errata no puede abrir una puerta', () => {
  it('una autonomía que no existe cae en manual, no en «ninguno de los dos»', async () => {
    /*
     * Éste es el caso del informe: el gate del toolbox preguntaba «¿es manual? ¿es auto y no
     * seguro?», así que `'Manual'` con mayúscula no era ninguno y **no preguntaba nada**. Un
     * trabajo con permiso de escritura salía sin tarjeta por una tecla.
     */
    for (const escrito of ['Manual', 'automatico', 'AUTO', 'foo', '']) {
      const config = await conEntorno({ JARVIS_CHAT_DEFAULT_AUTONOMY: escrito });
      expect(config.chatDefaultAutonomy, `«${escrito}» debería caer en manual`).toBe('manual');
    }
  });

  it('las tres autonomías buenas se respetan', async () => {
    // La otra mitad, y hace falta: un saneador que lo mande todo a `manual` también «pasaría» la
    // prueba de arriba, y habría roto el producto.
    for (const modo of ['manual', 'auto', 'unrestricted'] as const) {
      const config = await conEntorno({ JARVIS_CHAT_DEFAULT_AUTONOMY: modo });
      expect(config.chatDefaultAutonomy).toBe(modo);
    }
  });

  it('los interruptores que conceden nacen apagados', async () => {
    /*
     * Los tres se leen con el mismo ayudante, así que lo que se fija no es cada uno: es que la
     * ausencia signifique «no». Un interruptor que concede y se enciende solo cuando falta su
     * variable es la forma más silenciosa de abrir algo.
     */
    const config = await conEntorno({
      JARVIS_ALLOW_UNRESTRICTED: undefined,
      JARVIS_ALLOW_YOLO: undefined,
      JARVIS_MCP_WRITE_SERVERS: undefined,
      JARVIS_MCP_TRUST_UNTAGGED: undefined,
    });
    expect(config.chatAllowUnrestricted).toBe(false);
    expect(config.allowYolo).toBe(false);
    expect(config.mcpWriteServers).toBe('');
    expect(config.mcpTrustUntagged).toBe('');
  });

  it('un booleano escrito de cualquier manera razonable se entiende, y lo raro no enciende', async () => {
    for (const si of ['1', 'true', 'yes', 'on', 'TRUE']) {
      expect((await conEntorno({ JARVIS_ALLOW_UNRESTRICTED: si })).chatAllowUnrestricted).toBe(true);
    }
    // Y lo que no se entiende **no enciende**, que es la mitad que importa: `'sí'`, `'2'` o un
    // espacio son cosas que alguien escribe de verdad creyendo que activan algo.
    for (const no of ['sí', 'si', '2', ' ', 'verdadero', 'ok']) {
      expect((await conEntorno({ JARVIS_ALLOW_UNRESTRICTED: no })).chatAllowUnrestricted).toBe(false);
    }
  });

  it('sin hosts declarados sólo se alcanza el bastión, nunca la flota entera', async () => {
    // Una allowlist vacía que significara «todos» convertiría una variable olvidada en ejecución
    // remota arbitraria. Se comprueba aquí porque es la misma clase de decisión.
    const config = await conEntorno({ JARVIS_HOSTS: undefined, JARVIS_BASTION_HOST: 'bastion' });
    expect(config.hosts).toEqual(['bastion']);
  });
});
