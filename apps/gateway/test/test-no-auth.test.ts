/**
 * El modo de pruebas sin autenticación, que hasta hoy no tenía ni una prueba.
 *
 * Se construyó el 2026-09-06 y se encendió en producción el mismo día. Es la variable que **quita
 * la autenticación entera**: cualquiera que llegue a la red entra, y entra como una cuenta real,
 * con el core detrás sosteniendo la clave SSH de la flota. Que eso viviera sin cobertura es peor
 * que un hueco de cobertura normal, porque los dos candados que lleva —la red privada y la cuenta
 * que existe y está habilitada— **no se notan cuando funcionan**. Sólo se notan el día que fallan
 * abiertos, y ese día ya es tarde.
 *
 * Por eso lo que se fija aquí no es «que el modo funcione», que es lo fácil, sino **la dirección en
 * la que cae cuando algo no cuadra**: hacia 401, nunca hacia dejar pasar.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildGateway } from '../src/app.js';
import { config } from '../src/config.js';
import { users, type User } from '../src/lib/store.js';

const app = buildGateway();

/** Lo que había antes de tocar nada: estas pruebas mutan `config` y tienen que devolverlo. */
let original: { testNoAuth: boolean; testNoAuthLanOnly: boolean; testNoAuthUser: string };
let user: User;

beforeEach(() => {
  original = {
    testNoAuth: config.testNoAuth,
    testNoAuthLanOnly: config.testNoAuthLanOnly,
    testNoAuthUser: config.testNoAuthUser,
  };
  for (const existing of users.list()) users.remove(existing.username);
  user = users.create({ username: 'braian', displayName: 'Braian' });
});

afterEach(() => {
  Object.assign(config, original);
});

/** `remoteAddress` es lo que mira `clientIp`, y de ahí sale si la petición viene de casa. */
const me = async (remoteAddress: string) =>
  app.inject({ method: 'GET', url: '/auth/me', remoteAddress });

const conModo = (extra: Partial<typeof original> = {}): void => {
  Object.assign(config, { testNoAuth: true, testNoAuthLanOnly: true, testNoAuthUser: '', ...extra });
};

describe('El modo de pruebas entra sin credenciales, y sólo desde donde debe', () => {
  it('apagado —que es el defecto— una petición sin cookie no entra', async () => {
    const response = await me('192.168.1.50');

    // Sin esta prueba, un fallo que dejara `testNoAuth` siempre encendido no se notaría: las demás
    // pruebas de este fichero seguirían pasando, porque todas lo encienden a propósito.
    expect(response.statusCode).toBe(401);
    expect(config.testNoAuth).toBe(false);
  });

  it('encendido y desde la red de casa, se entra sin presentar nada y se dice que fue así', async () => {
    conModo();

    const response = await me('192.168.1.50');

    expect(response.statusCode).toBe(200);
    const body = response.json<{ authenticated: boolean; testNoAuth: boolean; user: { username: string } }>();
    expect(body.authenticated).toBe(true);
    expect(body.user.username).toBe('braian');
    /*
     * Y lo dice. Contestar «autenticado» sin decir que no se pidió nada sería la media verdad que
     * hace que el escudo de la cabecera prometa una seguridad que no hay.
     */
    expect(body.testNoAuth).toBe(true);
  });

  it('encendido pero desde fuera de la red privada, no entra', async () => {
    conModo();

    // Una IP pública cualquiera. El modo sigue puesto: lo que cierra es de dónde viene.
    const response = await me('203.0.113.7');

    expect(response.statusCode).toBe(401);
  });

  it('y si alguien quita el candado de la red, entra desde fuera: el candado es esa variable y no otra', async () => {
    conModo({ testNoAuthLanOnly: false });

    const response = await me('203.0.113.7');

    // No es un permiso que se conceda a la ligera; se fija para que quede claro **cuál** es la
    // variable que lo abre, y que apagarla no depende de ningún otro ajuste.
    expect(response.statusCode).toBe(200);
  });
});

describe('El modo de pruebas falla cerrado cuando la cuenta no da', () => {
  it('si la cuenta configurada no existe, no entra nadie', async () => {
    conModo({ testNoAuthUser: 'quien-no-esta' });

    const response = await me('192.168.1.50');

    /*
     * Lo tentador aquí es caer a «la primera cuenta habilitada», que es lo que hace el modo cuando
     * no se nombra ninguna. Pero si **se nombró una** y no existe, eso es una errata en el `.env`,
     * y una errata no puede acabar dando la sesión de otra persona.
     */
    expect(response.statusCode).toBe(401);
  });

  it('si la cuenta está deshabilitada, tampoco: un `disable` sigue apagando la entrada', async () => {
    conModo({ testNoAuthUser: 'braian' });
    users.update(user.userId, (u) => { u.enabled = false; });

    const response = await me('192.168.1.50');

    // Es la razón de resolver contra una cuenta de verdad y no contra una sintética: un modo sin
    // autenticación no tiene por qué ser además un modo sin forma de echar a alguien.
    expect(response.statusCode).toBe(401);
  });

  it('sin ninguna cuenta en el sistema, no se inventa una', async () => {
    conModo();
    for (const existing of users.list()) users.remove(existing.username);

    const response = await me('192.168.1.50');

    expect(response.statusCode).toBe(401);
  });
});
