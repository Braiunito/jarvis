/**
 * UX-05: el workspace se llama de algo.
 *
 * Lo que se prueba aquí no es la calidad del nombre sino la regla que más molesta cuando falla:
 * el título que escribe una persona no se toca.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeSessionIndex, indexRow } from '@jarvis/testkit';
import { openDatabase } from '../src/platform/db.js';
import { fixedClock } from '../src/platform/clock.js';
import { buildServices, type CoreServices } from '../src/services.js';
import { looksAutomatic, TitleService, titleFromPrompt, type TitleModel } from '../src/workspaces/title.js';

const user = { userId: 'u1', username: 'braian' };

let services: CoreServices;
beforeEach(() => {
  services = buildServices({
    db: openDatabase({ path: ':memory:' }),
    clock: fixedClock('2026-09-02T12:00:00.000Z'),
    index: new FakeSessionIndex() as never,
    model: null,
    config: { hosts: ['bastion'], bastionHost: 'bastion', spoolRoot: '/tmp/jarvis-title-spool' },
  });
});

const open = (sessionId: string, title: string | null = null) =>
  services.workspaces.open({ ref: { host: 'bastion', provider: 'claude', sessionId }, title }, user).workspace;

describe('título automático', () => {
  it('sin modelo, el nombre sale del prompt y no se queda vacío', async () => {
    const workspace = open('sid-1');
    const title = await services.titles.nameFromRun(workspace.id, {
      prompt: '[jarvis] contexto\n\n@@slow:3 revisa por qué el pool se queda sin conexiones',
      resultSummary: 'falta un finally en el handler',
    });
    expect(title).toBe('revisa por qué el pool se queda');
    expect(title).not.toContain('jarvis');
    expect(services.workspaces.require(workspace.id).title).toBe(title);
  });

  it('el prompt se limpia de instrucciones internas antes de nombrar', () => {
    // El preámbulo va en su propio bloque, como lo manda el core de verdad.
    expect(titleFromPrompt('[jarvis] You are running on the bastion.\n\n@@slow:6 arregla el deploy roto'))
      .toBe('arregla el deploy roto');
    // Y si viniera todo en una línea, el marcador se recorta igual.
    expect(titleFromPrompt('[jarvis] contexto interno')).toBe('trabajo sin título');
  });

  /**
   * La misma regla, por la otra puerta: el explorador manda el título del índice cada vez que se
   * pulsa una sesión, así que reabrir no puede deshacer lo que alguien escribió.
   */
  it('reabrir la sesión desde el explorador no pisa el título de la persona', () => {
    const workspace = open('sid-reopen', 'timeout del pool de conexiones');
    services.titles.setByUser(workspace.id, 'el lío del pool');

    const reopened = services.workspaces.open(
      { ref: { host: 'bastion', provider: 'claude', sessionId: 'sid-reopen' },
        cwd: '/srv/app', title: 'timeout del pool de conexiones' },
      user,
    ).workspace;

    expect(reopened.title).toBe('el lío del pool');
    // Lo demás sí se refresca: el índice sabe mejor dónde trabaja esa sesión.
    expect(reopened.cwd).toBe('/srv/app');
  });

  it('un título escrito por una persona gana y no se vuelve a tocar', async () => {
    const workspace = open('sid-2');
    services.titles.setByUser(workspace.id, 'el lío del pool');
    const title = await services.titles.nameFromRun(workspace.id, {
      prompt: 'otra cosa completamente distinta',
      resultSummary: null,
    });
    expect(title).toBeNull();
    expect(services.workspaces.require(workspace.id).title).toBe('el lío del pool');
  });

  it('un título que ya traía el índice tampoco se pisa', async () => {
    const workspace = open('sid-3', 'timeout del pool de conexiones');
    await services.titles.nameFromRun(workspace.id, { prompt: 'mira el log', resultSummary: null });
    expect(services.workspaces.require(workspace.id).title).toBe('timeout del pool de conexiones');
  });

  it('con modelo, se usa lo que devuelva; si falla, se sigue nombrando igual', async () => {
    const good: TitleModel = { summarize: async () => 'fuga de conexiones en el pool' };
    const broken: TitleModel = { summarize: async () => null };

    const withModel = buildServices({
      db: openDatabase({ path: ':memory:' }),
      clock: fixedClock('2026-09-02T12:00:00.000Z'),
      index: new FakeSessionIndex() as never,
      model: null,
      config: { hosts: ['bastion'], bastionHost: 'bastion', spoolRoot: '/tmp/jarvis-title-spool' },
    });
    const workspace = withModel.workspaces.open({
      ref: { host: 'bastion', provider: 'claude', sessionId: 'sid-4' },
    }, user).workspace;

    // El servicio se construye con el doble: lo que importa es la regla, no el proveedor.
    const { TitleService } = await import('../src/workspaces/title.js');
    const service = new TitleService({ db: withModel.db, clock: withModel.clock, model: good });
    expect(await service.nameFromRun(workspace.id, { prompt: 'mira el pool', resultSummary: 'ok' }))
      .toBe('fuga de conexiones en el pool');

    const another = withModel.workspaces.open({
      ref: { host: 'bastion', provider: 'claude', sessionId: 'sid-5' },
    }, user).workspace;
    const fallback = new TitleService({ db: withModel.db, clock: withModel.clock, model: broken });
    expect(await fallback.nameFromRun(another.id, { prompt: 'arregla el deploy roto', resultSummary: null }))
      .toBe('arregla el deploy roto');
    withModel.close();
  });
});

/**
 * Los títulos que ponen las CLIs.
 *
 * Cada agente nombra sus sesiones a su manera y ninguna sirve para reconocer un trabajo en una
 * lista: Claude pone su nombre y un hash, Codex arrastra el preámbulo entero del entorno. Estos
 * casos son literales de sesiones reales, no inventados.
 */
describe('qué título no sirve', () => {
  const codex = '<environment_context> <cwd>/home/zeus</cwd> <shell>zsh</shell> '
    + '<current_date>2026-08-27</current_date> <timezone>America/Argentina/Buenos_Aires</timezone>';

  it('reconoce lo que hay que sustituir', () => {
    expect(looksAutomatic('Claude a758cca7')).toBe(true);
    expect(looksAutomatic('Codex 9f2b1c3d4e5f')).toBe(true);
    expect(looksAutomatic(codex)).toBe(true);
    expect(looksAutomatic('<environment_context>')).toBe(true);
    expect(looksAutomatic('a758cca7c9e14f0b')).toBe(true);
    expect(looksAutomatic('7c9e4f0b-1a2b-4c3d-9e8f-0a1b2c3d4e5f')).toBe(true);
    expect(looksAutomatic('/home/zeus/proyecto')).toBe(true);
    expect(looksAutomatic('new session')).toBe(true);
    expect(looksAutomatic('   ')).toBe(true);
    expect(looksAutomatic(null)).toBe(true);
    // El identificador de la sesión, aunque venga vestido de otra cosa.
    expect(looksAutomatic('sesión sid-pool-42', 'sid-pool-42')).toBe(true);
  });

  it('no toca un título que sí sirve', () => {
    expect(looksAutomatic('timeout del pool de conexiones')).toBe(false);
    expect(looksAutomatic('el lío del pool')).toBe(false);
    expect(looksAutomatic('migrar aisessions a sqlite')).toBe(false);
    // Un nombre corto con números sigue siendo un nombre.
    expect(looksAutomatic('deploy v2 roto')).toBe(false);
  });

  it('el preámbulo de Codex no acaba dentro del nombre', () => {
    expect(titleFromPrompt(`${codex}\n\nrevisa por qué el deploy se cae en producción`))
      .toBe('revisa por qué el deploy se cae');
  });
});

/**
 * Nombrar al entrar, que es lo que pidió el usuario.
 *
 * Lo que se prueba es cuándo **no** se llama al modelo: con un título bueno, con uno recién puesto,
 * y cuando alguien ya escribió el suyo. Una llamada de más cuesta cuota; un renombrado de más
 * cuesta confianza.
 */
describe('nombrar al abrir el workspace', () => {
  const material = { userMessages: ['arregla el pool que se queda sin conexiones'] };

  it('sustituye el hash de la CLI por lo que pidió la persona', async () => {
    const workspace = open('sid-open-1', 'Claude a758cca7');
    expect(services.titles.needsTitle(workspace.id)).toBe(true);

    const title = await services.titles.nameOnOpen(workspace.id, material);
    expect(title).toBe('arregla el pool que se queda sin');
    expect(services.workspaces.require(workspace.id).title).toBe(title);
    // Y ya no vuelve a hacer falta.
    expect(services.titles.needsTitle(workspace.id)).toBe(false);
  });

  it('un título que ya sirve no se toca al abrir', async () => {
    const workspace = open('sid-open-2', 'timeout del pool de conexiones');
    expect(services.titles.needsTitle(workspace.id)).toBe(false);
    expect(await services.titles.nameOnOpen(workspace.id, material)).toBeNull();
  });

  it('el título de la persona gana también aquí', async () => {
    const workspace = open('sid-open-3', 'Claude a758cca7');
    services.titles.setByUser(workspace.id, 'el lío del pool');
    expect(services.titles.needsTitle(workspace.id)).toBe(false);
    expect(await services.titles.nameOnOpen(workspace.id, material)).toBeNull();
    expect(services.workspaces.require(workspace.id).title).toBe('el lío del pool');
  });

  it('un título recién puesto no se regenera: entrar dos veces no cuesta dos llamadas', async () => {
    let calls = 0;
    const counting: TitleModel = {
      summarize: async () => { calls += 1; return `nombre ${calls}`; },
    };
    const service = new TitleService({ db: services.db, clock: services.clock, model: counting });
    const workspace = open('sid-open-4', 'Claude a758cca7');

    expect(await service.nameOnOpen(workspace.id, material)).toBe('nombre 1');
    expect(await service.nameOnOpen(workspace.id, material)).toBeNull();
    expect(calls).toBe(1);
  });

  /**
   * El límite del proveedor no se puede tocar desde aquí, así que lo que se prueba es que llegar a
   * él no rompe nada: se sigue nombrando, sólo que peor.
   */
  it('agotado el presupuesto de llamadas, se nombra igual sin modelo', async () => {
    let calls = 0;
    const model: TitleModel = { summarize: async () => { calls += 1; return 'nombre del modelo'; } };
    const service = new TitleService({
      db: services.db, clock: services.clock, model, perMinute: 1, freshnessMs: 0,
    });

    const first = open('sid-open-5', 'Claude aaaaaaaa');
    const second = open('sid-open-6', 'Claude bbbbbbbb');

    expect(await service.nameOnOpen(first.id, material)).toBe('nombre del modelo');
    expect(await service.nameOnOpen(second.id, material)).toBe('arregla el pool que se queda sin');
    expect(calls).toBe(1);
  });

  it('el primer mensaje y el último llegan juntos al modelo', async () => {
    let seen = '';
    const model: TitleModel = {
      summarize: async ({ prompt }) => { seen = prompt; return 'lo que sea'; },
    };
    const service = new TitleService({ db: services.db, clock: services.clock, model });
    const workspace = open('sid-open-7', 'Claude cccccccc');

    await service.nameOnOpen(workspace.id, {
      userMessages: ['el pool se queda sin conexiones', 'ya probé subir el máximo', 'sigue igual'],
    });
    expect(seen).toContain('el pool se queda sin conexiones');
    expect(seen).toContain('sigue igual');
    expect(seen).not.toContain('ya probé subir el máximo');
  });
});

/**
 * Que el nombre se quede puesto.
 *
 * Renombrar y que al volver a la lista siga el nombre viejo se lee como que no se guardó, y a
 * partir de ahí nadie se fía de la función. Las dos puertas por las que se perdía son éstas.
 */
describe('el nombre persiste', () => {
  it('reabrir desde el explorador no deshace el título automático', async () => {
    const workspace = open('sid-persist', 'Claude a758cca7');
    const title = await services.titles.nameOnOpen(workspace.id, {
      userMessages: ['levanta la página de plataforma que está caída'],
    });
    expect(title).toBe('levanta la página de plataforma que está');

    // El explorador manda el título del índice cada vez que se pulsa la sesión.
    const reopened = services.workspaces.open(
      { ref: { host: 'bastion', provider: 'claude', sessionId: 'sid-persist' },
        title: 'Claude a758cca7' },
      user,
    ).workspace;

    expect(reopened.title).toBe(title);
  });

  it('la lista de sesiones enseña el nombre del workspace, no el del índice', async () => {
    // `sid-1` es la fila que trae el índice falso, con su título del índice.
    const workspace = services.workspaces.open(
      { ref: { host: 'local', provider: 'claude', sessionId: 'sid-1' }, title: 'Claude a758cca7' },
      user,
    ).workspace;
    await services.titles.nameOnOpen(workspace.id, { userMessages: ['arregla el pool'] });

    const result = await services.sessions.search({});
    const row = result.sessions.find((session) => session.ref.sessionId === 'sid-1');
    expect(row?.workspaceTitle).toBe('arregla el pool');
    expect(row?.workspaceId).toBe(workspace.id);
  });
});

/**
 * Las sesiones fantasma.
 *
 * Los agentes escriben el fichero al arrancar, así que un arranque que nunca se usó deja un resto
 * sin nada dentro. Reanudarlo da un agente sin contexto que termina el turno sin decir nada, y eso
 * se lee como un fallo de la aplicación.
 *
 * La regla es por contadores, **no por el patrón del título**: `Claude a758cca7` es la consecuencia
 * —el índice cae a ese nombre cuando ningún mensaje de la persona sirve para titular— y no la
 * causa. Medido sobre las 73 sesiones reales del bastión: 20 tenían ese título, 17 estaban vacías
 * del todo y 3 sólo guardaban envoltorios de `/comando` que nadie contestó.
 */
describe('sesiones sin nada dentro', () => {
  const rows = (extra: Record<string, unknown>) => new FakeSessionIndex([
    indexRow({ session_id: 'viva', user_messages: 3, user_text_messages: 3, assistant_messages: 4 }),
    indexRow({ session_id: 'fantasma', path: '/f2.jsonl', user_messages: 0, user_text_messages: 0, assistant_messages: 0 }),
    indexRow({ session_id: 'solo-comandos', path: '/f3.jsonl', title: 'Claude a758cca7', ...extra }),
  ]);

  const search = async (index: FakeSessionIndex) => {
    const local = buildServices({
      db: openDatabase({ path: ':memory:' }),
      clock: fixedClock('2026-09-02T12:00:00.000Z'),
      index: index as never,
      model: null,
      config: { hosts: ['bastion'], bastionHost: 'bastion', spoolRoot: '/tmp/jarvis-title-spool' },
    });
    const result = await local.sessions.search({});
    local.close();
    return new Map(result.sessions.map((session) => [session.ref.sessionId, session.empty]));
  };

  it('marca la vacía y la que sólo guarda comandos, y respeta la que tiene trabajo', async () => {
    const empty = await search(rows({ user_messages: 2, user_text_messages: 0, assistant_messages: 0 }));
    expect(empty.get('viva')).toBe(false);
    expect(empty.get('fantasma')).toBe(true);
    expect(empty.get('solo-comandos')).toBe(true);
  });

  /** Un índice antiguo no cuenta los turnos con texto: la regla degrada, no se rompe. */
  it('con un índice que no lo cuenta, vale la regla de siempre', async () => {
    const empty = await search(rows({ user_messages: 2, assistant_messages: 0 }));
    expect(empty.get('fantasma')).toBe(true);
    expect(empty.get('solo-comandos')).toBe(false);
  });
});
