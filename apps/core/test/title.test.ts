/**
 * UX-05: el workspace se llama de algo.
 *
 * Lo que se prueba aquí no es la calidad del nombre sino la regla que más molesta cuando falla:
 * el título que escribe una persona no se toca.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeSessionIndex } from '@jarvis/testkit';
import { openDatabase } from '../src/platform/db.js';
import { fixedClock } from '../src/platform/clock.js';
import { buildServices, type CoreServices } from '../src/services.js';
import { titleFromPrompt, type TitleModel } from '../src/workspaces/title.js';

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
