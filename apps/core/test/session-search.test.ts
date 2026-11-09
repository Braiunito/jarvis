/**
 * Buscar por trozos, y el modelo de cada sesión.
 *
 * El índice falso busca como el de verdad (`@jarvis/testkit` → `ftsMatch`): por palabras enteras
 * salvo que la consulta pida prefijo, y sin la máquina en el texto. Con el falso de antes, que
 * buscaba subcadenas en el título, «vul» encontraba «vultr» y nada de esto se podía ver fallar.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeSessionIndex, ftsMatch, indexRow } from '@jarvis/testkit';
import { openDatabase } from '../src/platform/db.js';
import { fixedClock } from '../src/platform/clock.js';
import { buildServices, type CoreServices } from '../src/services.js';
import { fold, matchesCard, prefixQuery, searchTerms } from '../src/sessions/search.js';
import { cleanModel, modelCatalog } from '../src/sessions/models.js';

const user = { userId: 'u1', username: 'braian' };

const ROWS = [
  indexRow({
    session_key: 'vultr:claude:sid-v', host: 'vultr', session_id: 'sid-v', cwd: '/root/web',
    title: 'renovar certificados', preview: 'el certificado del borde caduca',
    model: 'claude-opus-5-5', updated_at: '2026-09-01T10:00:00.000Z',
  }),
  indexRow({
    session_key: 'goro2:codex:sid-m', host: 'goro2', provider: 'codex', session_id: 'sid-m', cwd: '/srv/api',
    title: 'Migración de pedidos', preview: 'índices de la tabla de pedidos',
    model: 'openai', updated_at: '2026-09-01T12:00:00.000Z',
  }),
  indexRow({
    session_key: 'local:claude:sid-l', host: 'local', session_id: 'sid-l', cwd: '/home/dev/jarvis',
    title: 'pool de conexiones', preview: 'el pool se queda sin conexiones',
    model: '<synthetic>', updated_at: '2026-09-01T08:00:00.000Z',
  }),
];

let index: FakeSessionIndex;
let services: CoreServices;
beforeEach(() => {
  index = new FakeSessionIndex(ROWS.map((row) => ({ ...row })));
  index.transcripts.set('sid-l', [
    { role: 'user', at: null, text: 'revisa el handler de reintentos' },
    { role: 'assistant', at: null, text: 'falta un finally en el handler' },
  ]);
  services = buildServices({
    db: openDatabase({ path: ':memory:' }),
    clock: fixedClock('2026-09-02T12:00:00.000Z'),
    index: index as never,
    model: null,
    config: { hosts: ['bastion', 'vultr', 'goro2'], bastionHost: 'bastion', spoolRoot: '/tmp/jarvis-search-spool' },
  });
});

const found = async (q: string): Promise<string[]> =>
  (await services.sessions.search({ q })).sessions.map((session) => session.ref.sessionId).sort();

describe('el índice falso busca como el de verdad', () => {
  it('una palabra suelta tiene que estar entera; con asterisco basta el principio', () => {
    expect(ftsMatch('vul', ['vultr'])).toBe(false);
    expect(ftsMatch('"vul"*', ['vultr'])).toBe(true);
    expect(ftsMatch('"migracion"*', ['Migración de pedidos'])).toBe(true);
    expect(ftsMatch('"jarvis-ne"*', ['/home/dev/jarvis-next'])).toBe(true);
    expect(ftsMatch('"next"* "jar"*', ['jarvis-next'])).toBe(true);
    expect(ftsMatch('"next"* "zzz"*', ['jarvis-next'])).toBe(false);
  });
});

describe('buscar por trozos', () => {
  it('un trozo del nombre de la máquina la encuentra, aunque la máquina no esté en el índice', async () => {
    expect(await found('vul')).toEqual(['sid-v']);
    expect(await found('VULTR')).toEqual(['sid-v']);
  });

  it('un trozo de palabra encuentra la conversación entera, no sólo el título', async () => {
    expect(await found('reintent')).toEqual(['sid-l']);
    expect(await found('finall')).toEqual(['sid-l']);
  });

  it('sin tildes y sin mayúsculas', async () => {
    expect(await found('migracion')).toEqual(['sid-m']);
    expect(await found('INDICES')).toEqual(['sid-m']);
  });

  it('varios trozos se suman: cada uno puede estar en un sitio distinto', async () => {
    expect(await found('goro ped')).toEqual(['sid-m']);
    expect(await found('vul pedidos')).toEqual([]);
  });

  it('el nombre que se le puso aquí también cuenta', async () => {
    const opened = services.workspaces.open({ ref: { host: 'vultr', provider: 'claude', sessionId: 'sid-v' }, title: null }, user).workspace;
    services.titles.setByUser(opened.id, 'Tienda de Laura');
    expect(await found('laur')).toEqual(['sid-v']);
  });

  it('el modelo también, y la lista sale con lo más reciente primero', async () => {
    expect(await found('opus')).toEqual(['sid-v']);
    const all = (await services.sessions.search({ q: 'e' })).sessions.map((session) => session.ref.sessionId);
    expect(all.length).toBeGreaterThan(1);
    expect(all).toEqual([...all].sort((a, b) => ['sid-m', 'sid-v', 'sid-l'].indexOf(a) - ['sid-m', 'sid-v', 'sid-l'].indexOf(b)));
  });

  it('sin nada escrito no se busca: sale la lista entera', async () => {
    expect(await found('')).toEqual(['sid-l', 'sid-m', 'sid-v']);
  });
});

describe('las piezas', () => {
  it('cada término va a FTS5 entre comillas y como prefijo, con las comillas dobladas', () => {
    expect(prefixQuery(searchTerms('  Vul   jarvis-next '))).toBe('"vul"* "jarvis-next"*');
    expect(prefixQuery(['a"b'])).toBe('"a""b"*');
    expect(fold('Migración ÍNDICE')).toBe('migracion indice');
  });

  it('la ficha se compara entera', () => {
    const session = {
      ref: { host: 'goro3', provider: 'codex' as const, sessionId: 'abc' },
      title: null, cwd: '/srv/tienda', sourceRoot: null, messageCount: 1, startedAt: null,
      lastActivityAt: null, preview: null, model: 'gpt-5.6-sol', workspaceId: null,
      workspaceTitle: null, empty: false, resumable: true,
    };
    expect(matchesCard(session, ['goro3', 'tien', 'sol'])).toBe(true);
    expect(matchesCard(session, ['goro2'])).toBe(false);
  });
});

describe('el modelo de una sesión', () => {
  it('lo que no es un modelo no se enseña', () => {
    expect(cleanModel('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(cleanModel('<synthetic>')).toBeNull();
    expect(cleanModel('openai')).toBeNull();
    expect(cleanModel('')).toBeNull();
    expect(cleanModel(undefined)).toBeNull();
  });

  it('viaja en la lista y en el transcript', async () => {
    const { sessions } = await services.sessions.search({});
    const byId = Object.fromEntries(sessions.map((session) => [session.ref.sessionId, session.model]));
    expect(byId).toEqual({ 'sid-v': 'claude-opus-5-5', 'sid-m': null, 'sid-l': null });
  });
});

describe('el catálogo de modelos', () => {
  it('primero los alias, después lo usado en la flota, lo más reciente antes y sin repetir', () => {
    const catalog = modelCatalog([
      { provider: 'claude', model: 'claude-sonnet-5', at: '2026-08-01T00:00:00.000Z' },
      { provider: 'claude', model: 'claude-opus-5-5', at: '2026-09-01T00:00:00.000Z' },
      { provider: 'claude', model: 'claude-sonnet-5', at: '2026-08-20T00:00:00.000Z' },
      { provider: 'claude', model: 'opus', at: '2026-09-02T00:00:00.000Z' },
      { provider: 'claude', model: '<synthetic>', at: '2026-09-03T00:00:00.000Z' },
      { provider: 'codex', model: 'openai', at: '2026-09-03T00:00:00.000Z' },
      { provider: 'codex', model: 'gpt-5.6-sol', at: '2026-09-01T12:00:00.000Z' },
      { provider: 'codex', model: '--yolo', at: '2026-09-04T00:00:00.000Z' },
      { provider: 'otro', model: 'x', at: null },
    ]);
    expect(catalog.map((option) => `${option.provider}:${option.id}:${option.kind}`)).toEqual([
      'claude:opus:alias', 'claude:sonnet:alias', 'claude:haiku:alias',
      'codex:gpt-5.6-sol:seen', 'claude:claude-opus-5-5:seen', 'claude:claude-sonnet-5:seen',
    ]);
    expect(catalog.find((option) => option.id === 'claude-sonnet-5')?.lastUsedAt).toBe('2026-08-20T00:00:00.000Z');
  });

  it('suma lo del índice y lo pedido desde aquí, y sin índice sale con lo que hay', async () => {
    const ids = (await services.sessions.models()).models.map((option) => option.id);
    expect(ids).toContain('claude-opus-5-5');
    expect(ids).not.toContain('openai');

    index.list = async () => { throw new Error('index down'); };
    const fallback = (await services.sessions.models()).models.map((option) => option.id);
    expect(fallback).toEqual(['opus', 'sonnet', 'haiku']);
  });
});

describe('mandar trabajo con modelo', () => {
  it('lo que no es un nombre de modelo se rechaza antes de llegar a la máquina', async () => {
    const opened = services.workspaces.open({ ref: { host: 'bastion', provider: 'claude', sessionId: 'sid-l' }, title: null }, user).workspace;
    await expect(services.runs.create({ workspaceId: opened.id, prompt: 'hola', model: '--dangerously-skip-permissions' }, user, 'r1'))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(services.runs.create({ workspaceId: opened.id, prompt: 'hola', model: 'opus; rm -rf ~' }, user, 'r2'))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
