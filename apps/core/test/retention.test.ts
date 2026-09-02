/**
 * ADR-007: la retención de eventos, ejecutada de verdad.
 *
 * Este test no compara la consulta que se generaría: **abre una base, siembra trabajos de
 * distintas edades y ejecuta el barrido**, y luego mira qué quedó. La diferencia importa —en este
 * mismo proyecto una limpieza pasó meses «implementada» porque su test comprobaba la cadena del
 * comando en vez de correrlo, y el comando no lo parseaba ningún shell—.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeSessionIndex } from '@jarvis/testkit';
import { openDatabase } from '../src/platform/db.js';
import { fixedClock } from '../src/platform/clock.js';
import { buildServices, type CoreServices } from '../src/services.js';
import { applyRetention, compactPayload, summarize } from '../src/runs/retention.js';
import type { RunStatus } from '@jarvis/contracts';

const NOW = '2026-09-02T10:00:00.000Z';
const user = { userId: 'u1', username: 'braian' };
const clock = fixedClock(NOW);

const daysAgo = (days: number): string =>
  new Date(Date.parse(NOW) - days * 24 * 60 * 60 * 1000).toISOString();

/** Una salida de herramienta de las que pesan: lo que esto existe para quitar de en medio. */
const bigOutput = (label: string): Record<string, unknown> => ({
  name: label,
  output: 'x'.repeat(4000),
});

let services: CoreServices;
let seeded = 0;

beforeEach(() => {
  const db = openDatabase({ path: ':memory:' });
  services = buildServices({
    db,
    clock,
    index: new FakeSessionIndex() as never,
    config: { hosts: ['bastion'], bastionHost: 'bastion', spoolRoot: '/tmp/jarvis-retention-spool' },
  });
  seeded = 0;
});

/** Un trabajo con sus eventos, terminado hace `ageDays` (o vivo, si no se dice edad). */
function seedRun({ ageDays, status = 'completed' }: { ageDays?: number; status?: RunStatus } = {}): string {
  seeded += 1;
  const { workspace } = services.workspaces.open({
    ref: { host: 'bastion', provider: 'claude', sessionId: `sid-${seeded}` },
  }, user);
  const runId = `r000000000000000${seeded}`;
  const createdAt = ageDays === undefined ? NOW : daysAgo(ageDays);
  services.runRepository.insert({
    id: runId,
    workspaceId: workspace.id,
    createdBy: user.username,
    provider: 'claude',
    sessionId: `sid-${seeded}`,
    prompt: 'hola',
    workHost: 'bastion',
    executionHost: 'bastion',
    strategy: 'B',
    strategyReason: null,
    cwd: null,
    permissionProfile: 'safe',
    model: null,
    attempt: 1,
    parentRunId: null,
    remoteName: `jarvis-${runId}`,
    remoteSpoolDir: `/tmp/spool/${runId}`,
    createdAt,
    deadlineAt: null,
  });
  services.runRepository.appendBatch(runId, [
    { type: 'run.status', payload: { status: 'running' }, at: createdAt },
    { type: 'run.target', payload: { host: 'bastion' }, at: createdAt },
    { type: 'agent.tool', payload: bigOutput('grep'), at: createdAt },
    { type: 'agent.text', payload: { text: 'lo que respondió el agente' }, at: createdAt },
    { type: 'agent.raw', payload: { subtype: 'thinking_tokens', blob: 'y'.repeat(3000) }, at: createdAt },
    { type: 'agent.result', payload: { ok: true }, at: createdAt },
  ], ageDays === undefined
    ? { status: 'running' }
    : { status, finishedAt: daysAgo(ageDays) });
  return runId;
}

const typesOf = (runId: string): string[] => services.runRepository.events(runId).map((e) => e.type);
const seqsOf = (runId: string): number[] => services.runRepository.events(runId).map((e) => e.seq);
const eventAt = (runId: string, seq: number) =>
  services.runRepository.events(runId).find((e) => e.seq === seq);

describe('resumen de un payload que se va', () => {
  it('prefiere lo que una persona reconocería, y si no hay nada dice qué campos traía', () => {
    expect(summarize({ name: 'grep', input: {} }, 200)).toBe('grep');
    expect(summarize({ note: 'el modelo está pensando' }, 200)).toBe('el modelo está pensando');
    expect(summarize({ a: 1, b: 2 }, 200)).toBe('2 campos: a, b');
    expect(summarize(null, 200)).toBeNull();
  });

  it('recorta al límite y lo dice con el carácter de continuación', () => {
    expect(summarize({ text: 'z'.repeat(500) }, 10)).toBe(`${'z'.repeat(10)}…`);
  });

  it('no pierde la huella aunque el payload guardado no sea JSON válido', () => {
    const compacted = compactPayload('{roto', 200);
    expect(compacted.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(compacted.originalBytes).toBe(5);
    expect(compacted.summary).toBeNull();
  });
});

describe('lo reciente y lo vivo no se tocan', () => {
  it('un trabajo en marcha queda intacto por muy pesado que sea', () => {
    const runId = seedRun();
    const report = applyRetention({ db: services.runRepository.db, clock });
    expect(report.compactedEvents).toBe(0);
    expect(report.droppedEvents).toBe(0);
    expect(typesOf(runId)).toHaveLength(6);
    expect(eventAt(runId, 2)?.compacted).toBeUndefined();
  });

  it('un trabajo terminado hace tres días conserva todo', () => {
    const runId = seedRun({ ageDays: 3 });
    applyRetention({ db: services.runRepository.db, clock });
    expect(typesOf(runId)).toHaveLength(6);
    expect(services.runRepository.events(runId).every((e) => !e.compacted)).toBe(true);
  });
});

describe('entre 7 y 30 días: se va el peso, no la historia', () => {
  it('compacta la salida de herramienta y el volcado crudo, y deja el resto entero', () => {
    const runId = seedRun({ ageDays: 15 });
    const report = applyRetention({ db: services.runRepository.db, clock });

    expect(report.compactedEvents).toBe(2);
    expect(report.droppedEvents).toBe(0);
    expect(report.runsTouched).toBe(1);
    expect(report.bytesFreed).toBeGreaterThan(6000);

    // Ninguna fila se ha ido: sigue habiendo seis eventos con sus seq de siempre.
    expect(typesOf(runId)).toEqual([
      'run.status', 'run.target', 'agent.tool', 'agent.text', 'agent.raw', 'agent.result',
    ]);
    expect(seqsOf(runId)).toEqual([0, 1, 2, 3, 4, 5]);

    const tool = eventAt(runId, 2);
    expect(tool?.compacted).toBe(true);
    const payload = tool?.payload as Record<string, unknown>;
    expect(payload['compacted']).toBe(true);
    expect(payload['digest']).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(payload['originalBytes']).toBeGreaterThan(4000);
    expect(payload['summary']).toBe('grep');

    // Lo que alguien vuelve a leer sigue ahí, palabra por palabra.
    expect((eventAt(runId, 3)?.payload as Record<string, unknown>)['text'])
      .toBe('lo que respondió el agente');
    expect(eventAt(runId, 3)?.compacted).toBeUndefined();
    expect(eventAt(runId, 5)?.compacted).toBeUndefined();
  });

  it('no reescribe un payload que ocuparía más compactado que entero', () => {
    const runId = seedRun({ ageDays: 15 });
    services.runRepository.appendBatch(runId, [
      { type: 'agent.tool', payload: { n: 1 }, at: daysAgo(15) },
    ], {});
    const report = applyRetention({ db: services.runRepository.db, clock });
    expect(report.compactedEvents).toBe(2);
    expect(eventAt(runId, 6)?.compacted).toBeUndefined();
    expect(eventAt(runId, 6)?.payload).toEqual({ n: 1 });
  });
});

describe('pasados los 30 días queda el esqueleto', () => {
  it('conserva los estructurales, borra el resto y no renumera lo que queda', () => {
    const runId = seedRun({ ageDays: 60 });
    const report = applyRetention({ db: services.runRepository.db, clock });

    expect(report.droppedEvents).toBe(3);
    expect(typesOf(runId)).toEqual(['run.status', 'run.target', 'agent.result']);
    // `seq` es identidad pública y durable: los huecos se quedan como huecos.
    expect(seqsOf(runId)).toEqual([0, 1, 5]);
    expect(report.bytesFreed).toBeGreaterThan(6000);
  });

  it('el trabajo sigue existiendo: esto limpia eventos, no borra historia', () => {
    const runId = seedRun({ ageDays: 60 });
    applyRetention({ db: services.runRepository.db, clock });
    expect(services.runRepository.find(runId)?.id).toBe(runId);
  });

  it('un trabajo cancelado hace mucho también se limpia', () => {
    const runId = seedRun({ ageDays: 60, status: 'cancelled' });
    const report = applyRetention({ db: services.runRepository.db, clock });
    expect(report.droppedEvents).toBe(3);
    expect(typesOf(runId)).toEqual(['run.status', 'run.target', 'agent.result']);
  });
});

describe('el barrido se puede repetir', () => {
  it('la segunda pasada seguida no cambia nada', () => {
    seedRun({ ageDays: 15 });
    seedRun({ ageDays: 60 });
    const first = applyRetention({ db: services.runRepository.db, clock });
    expect(first.compactedEvents + first.droppedEvents).toBeGreaterThan(0);

    const second = applyRetention({ db: services.runRepository.db, clock });
    expect(second.compactedEvents).toBe(0);
    expect(second.droppedEvents).toBe(0);
    expect(second.bytesFreed).toBe(0);
    expect(second.runsTouched).toBe(0);
  });

  it('cada trabajo se trata según su propia edad, no según el más viejo', () => {
    const fresco = seedRun({ ageDays: 2 });
    const medio = seedRun({ ageDays: 15 });
    const viejo = seedRun({ ageDays: 60 });
    const report = applyRetention({ db: services.runRepository.db, clock });

    expect(report.runsTouched).toBe(2);
    expect(typesOf(fresco)).toHaveLength(6);
    expect(typesOf(medio)).toHaveLength(6);
    expect(typesOf(viejo)).toHaveLength(3);
  });
});
