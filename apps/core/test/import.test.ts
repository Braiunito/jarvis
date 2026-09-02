/**
 * Gate M5: importar lo útil y nada más.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeSessionIndex } from '@jarvis/testkit';
import type { ImportReport, LiteChatExport } from '@jarvis/contracts';
import { openDatabase } from '../src/platform/db.js';
import { fixedClock } from '../src/platform/clock.js';
import { buildServices, type CoreServices } from '../src/services.js';

const user = { userId: 'u1', username: 'braian' };

const exportFixture = (overrides: Partial<LiteChatExport> = {}): LiteChatExport => ({
  schema: 'litechat-export-v1',
  exportedAt: '2026-09-01T10:00:00.000Z',
  sourceInstallationId: 'install-abc123',
  conversations: [
    {
      sourceConversationId: 'conv-1',
      title: 'el pool otra vez',
      createdAt: '2026-08-30T10:00:00.000Z',
      updatedAt: '2026-09-01T09:00:00.000Z',
      link: { host: 'local', provider: 'claude', sessionId: 'sid-pool', cwd: '/srv/app' },
      draft: 'seguir con el pool',
      messages: [
        { sourceMessageId: 'm1', role: 'user', at: '2026-08-30T10:00:00.000Z', text: 'mira el log' },
        { sourceMessageId: 'm2', role: 'assistant', at: '2026-08-30T10:01:00.000Z', text: 'hay un timeout' },
      ],
    },
    {
      sourceConversationId: 'conv-2',
      title: 'charla suelta sin agente',
      createdAt: null,
      updatedAt: null,
      link: null,
      draft: null,
      messages: [{ sourceMessageId: 'm3', role: 'user', at: null, text: 'hola' }],
    },
  ],
  ...overrides,
});

let services: CoreServices;
beforeEach(() => {
  services = buildServices({
    db: openDatabase({ path: ':memory:' }),
    clock: fixedClock('2026-09-02T12:00:00.000Z'),
    index: new FakeSessionIndex() as never,
    model: null,
    config: { hosts: ['bastion'], bastionHost: 'bastion', spoolRoot: '/tmp/jarvis-import-spool' },
  });
});

const run = (payload: LiteChatExport): ImportReport => services.imports.import(payload, user, 'req_test');

describe('M5 · importación', () => {
  it('trae la conversación con vínculo y se salta la que no lo tiene', () => {
    const report = run(exportFixture());
    expect(report.imported).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.errors).toEqual([]);

    const workspace = services.workspaceRepository.findById(report.workspaceIds[0] as string);
    expect(workspace?.ref).toEqual({ host: 'bastion', provider: 'claude', sessionId: 'sid-pool' });
    // Procedencia visible: lo importado no se atribuye a esta consola.
    expect(workspace?.provenance).toBe('litechat-import');
    expect(workspace?.cwd).toBe('/srv/app');
  });

  it('los mensajes importados viven aparte del transcript remoto', () => {
    const report = run(exportFixture());
    const messages = services.imports.messagesFor(report.workspaceIds[0] as string);
    expect(messages.map((message) => message.text)).toEqual(['mira el log', 'hay un timeout']);
  });

  it('repetir el import no duplica nada', () => {
    const first = run(exportFixture());
    const second = run(exportFixture());
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(2);
    expect(second.workspaceIds).toEqual(first.workspaceIds);
    expect(services.workspaceRepository.all()).toHaveLength(1);
    expect(services.imports.messagesFor(first.workspaceIds[0] as string)).toHaveLength(2);
  });

  it('si el workspace ya existía, se enlaza en vez de crear otro', () => {
    const opened = services.workspaces.open({
      ref: { host: 'bastion', provider: 'claude', sessionId: 'sid-pool' },
    }, user);
    const report = run(exportFixture());
    expect(report.workspaceIds).toEqual([opened.workspace.id]);
    expect(services.workspaceRepository.all()).toHaveLength(1);
  });

  it('el borrador entra sólo si aquí no había uno', () => {
    const opened = services.workspaces.open({
      ref: { host: 'bastion', provider: 'claude', sessionId: 'sid-pool' },
    }, user);
    services.workspaces.putDraft(opened.workspace.id, user, 'lo que estaba escribiendo aquí', 0);
    run(exportFixture());
    expect(services.workspaces.draft(opened.workspace.id, user).body).toBe('lo que estaba escribiendo aquí');
  });

  it('un export hostil con credenciales se rechaza entero, no se limpia por detrás', () => {
    const hostile = {
      ...exportFixture(),
      apiKeys: { openai: 'sk-secreto' },
    } as unknown as LiteChatExport;
    expect(() => run(hostile)).toThrow(/apiKeys/);
    expect(services.workspaceRepository.all()).toHaveLength(0);

    for (const key of ['providers', 'mods', 'vfs', 'settings']) {
      const payload = { ...exportFixture(), [key]: { algo: 1 } } as unknown as LiteChatExport;
      expect(() => run(payload)).toThrow(new RegExp(key));
    }
  });

  it('un esquema que no es el nuestro no se intenta adivinar', () => {
    expect(() => run({ ...exportFixture(), schema: 'otro' } as unknown as LiteChatExport))
      .toThrow(/litechat-export-v1/);
    expect(() => run({ ...exportFixture(), sourceInstallationId: '' }))
      .toThrow(/sourceInstallationId/);
  });

  it('«local» se normaliza al bastión también al importar', () => {
    const report = run(exportFixture());
    const workspace = services.workspaceRepository.findById(report.workspaceIds[0] as string);
    expect(workspace?.ref.host).toBe('bastion');
  });
});
