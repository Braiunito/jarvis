/**
 * Contratos ADAPT-*: cómo se invoca cada CLI y cómo se normaliza su salida.
 *
 * Los transcripts vienen de las CLIs instaladas, no de la imaginación: si un proveedor cambia su
 * formato, esto falla en CI antes de que el normalizador empiece a producir basura.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAdapter } from '@jarvis/agent-adapters';
import type { AgentEvent, PermissionProfile, Provider } from '@jarvis/contracts';
import { PERMISSION_PROFILES } from '@jarvis/contracts';

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', name), 'utf8')) as T;

interface InvocationFixture {
  cases: Array<{ id: string; provider: Provider; options: Record<string, unknown>; argv: string[]; env: Record<string, string> }>;
  attach: Array<{ id: string; provider: Provider; options: Record<string, unknown>; argv: string[] }>;
  permissionModes: Record<Provider, Record<PermissionProfile, string>>;
}

const invocations = fixture<InvocationFixture>('adapters/invocations.json');

describe('ADAPT-*: invocación', () => {
  for (const item of invocations.cases) {
    it(`${item.id} produce exactamente el argv esperado`, () => {
      const adapter = getAdapter(item.provider);
      const built = adapter.buildRun(item.options as never);
      expect(built.argv).toEqual(item.argv);
      expect(built.env).toEqual(item.env);
    });
  }

  for (const item of invocations.attach) {
    it(`${item.id} conserva el perfil de permiso en modo interactivo`, () => {
      const adapter = getAdapter(item.provider);
      expect(adapter.buildAttach(item.options as never).argv).toEqual(item.argv);
    });
  }

  it('ADAPT-PERM-01: el mapa de permisos no cambia y nunca se eleva por defecto', () => {
    for (const [provider, modes] of Object.entries(invocations.permissionModes)) {
      const adapter = getAdapter(provider as Provider);
      for (const profile of PERMISSION_PROFILES) {
        expect(adapter.permissionMode(profile)).toBe(modes[profile]);
      }
      // Un perfil desconocido cae en `safe`, no en el permisivo.
      expect(adapter.permissionMode('inventado' as PermissionProfile)).toBe(modes.safe);
    }
  });
});

interface TranscriptFixture {
  records: unknown[];
  expected: Array<Record<string, unknown>>;
}

const flatten = (value: AgentEvent | AgentEvent[] | null): AgentEvent[] =>
  value === null ? [] : Array.isArray(value) ? value : [value];

describe.each([
  ['claude', 'adapters/claude.transcript.json'],
  ['codex', 'adapters/codex.transcript.json'],
  ['opencode', 'adapters/opencode.transcript.json'],
] as const)('%s: normalización', (provider, path) => {
  const data = fixture<TranscriptFixture>(path);
  const adapter = getAdapter(provider);

  it('convierte el transcript capturado en los eventos esperados', () => {
    const events = data.records.flatMap((record) => flatten(adapter.normalize(record)));
    expect(events.length).toBe(data.expected.length);
    data.expected.forEach((expectation, index) => {
      const actual = events[index] as Record<string, unknown>;
      for (const [key, value] of Object.entries(expectation)) {
        if (key === 'tool') {
          expect(actual['tool']).toMatchObject(value as object);
        } else {
          expect(actual[key]).toEqual(value);
        }
      }
    });
  });

  it('un registro desconocido degrada a raw en vez de romper el run', () => {
    expect(flatten(adapter.normalize({ type: 'nunca-visto', a: 1 }))[0]?.type).toBe('raw');
    expect(flatten(adapter.normalize(null))[0]?.type).toBe('raw');
    expect(() => adapter.normalize('no es un objeto')).not.toThrow();
  });

  it('cada evento de tool es un objeto propio: no comparte referencia con el anterior', () => {
    const events = data.records.flatMap((record) => flatten(adapter.normalize(record)));
    const tools = events.filter((event) => event.type === 'tool');
    const seen = new Set<unknown>();
    for (const event of tools) {
      expect(seen.has((event as { tool: unknown }).tool)).toBe(false);
      seen.add((event as { tool: unknown }).tool);
    }
  });
});
