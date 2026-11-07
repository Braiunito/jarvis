/**
 * El hilo de una sesión, en turnos.
 *
 * Lo que se prueba es lo que se vería mal en pantalla sin hacer ruido: un trabajo de Jarvis
 * pintado dos veces —una por el trabajo y otra por el transcript, que también lo guarda—, un
 * `/comando` abriendo un turno como si lo hubiera escrito alguien, o un trabajo de hoy pegado a
 * una pregunta idéntica de la semana pasada.
 */
import { describe, expect, it } from 'vitest';
import type { Run, TranscriptMessage } from '@jarvis/contracts';
import { buildTurns, fullAnswer, oneLine, RESULT_SUMMARY_MAX, transcriptTurns } from '../src/ui/turns.js';

const msg = (role: TranscriptMessage['role'], text: string, at: string | null, kind: TranscriptMessage['kind'] = 'text'): TranscriptMessage => ({
  role, text, at, kind, label: kind === 'text' ? null : text, provenance: 'remote-transcript',
});

const run = (id: string, prompt: string, createdAt: string, extra: Partial<Run> = {}): Run => ({
  id, workspaceId: 'w1', createdBy: 'braian', provider: 'claude', sessionId: 's1', workHost: 'zeus',
  executionHost: 'zeus', strategy: 'B', strategyReason: null, cwd: '/var/www/jarvis', permissionProfile: 'safe',
  model: null, attempt: 1, parentRunId: null, remoteName: null, lastEventSeq: -1, status: 'completed',
  createdAt, startedAt: createdAt, finishedAt: createdAt, cancelRequestedAt: null, exitCode: 0,
  errorCode: null, errorMessage: null, resultOk: true, resultSummary: 'hecho', promptPreview: prompt,
  ...extra,
} as Run);

describe('transcriptTurns', () => {
  it('cada mensaje propio abre un turno, y la respuesta es la última del agente', () => {
    const turns = transcriptTurns([
      msg('user', 'mira el log', '2026-11-01T10:00:00Z'),
      msg('assistant', 'primero esto', '2026-11-01T10:00:05Z'),
      msg('assistant', 'y al final esto', '2026-11-01T10:00:09Z'),
      msg('user', 'otra cosa', '2026-11-01T11:00:00Z'),
      msg('assistant', 'vale', '2026-11-01T11:00:02Z'),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.prompt).toBe('mira el log');
    expect(turns[0]?.answer).toBe('y al final esto');
    expect(turns[0]?.messages).toHaveLength(3);
    expect(turns[1]?.answer).toBe('vale');
  });

  it('un /comando no abre turno: es de la CLI, no de la persona', () => {
    const turns = transcriptTurns([
      msg('user', 'arregla el test', null),
      msg('user', '/model', null, 'command'),
      msg('user', 'Set model to opus', null, 'command-output'),
      msg('assistant', 'arreglado', null),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.messages).toHaveLength(4);
  });

  it('lo que hay antes del primer mensaje propio es un turno sin pregunta, no se pierde', () => {
    const turns = transcriptTurns([
      msg('assistant', 'continuación de una página anterior', null),
      msg('user', 'sigue', null),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.prompt).toBeNull();
    expect(turns[0]?.answer).toBe('continuación de una página anterior');
  });
});

describe('buildTurns', () => {
  it('un trabajo de Jarvis que ya está en el transcript sale una vez, como trabajo', () => {
    const turns = buildTurns([
      msg('user', 'Revisa  el pool\nde conexiones', '2026-11-01T10:00:02Z'),
      msg('assistant', 'falta un finally', '2026-11-01T10:01:00Z'),
    ], [run('r1', 'revisa el pool de conexiones', '2026-11-01T10:00:00Z')]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.kind).toBe('run');
    expect(turns[0]?.answer).toBe('hecho');
  });

  it('un trabajo que todavía no llegó al transcript va al final, en su hora', () => {
    const turns = buildTurns([
      msg('user', 'antes', '2026-11-01T09:00:00Z'),
      msg('assistant', 'ok', '2026-11-01T09:00:10Z'),
    ], [run('r2', 'ahora', '2026-11-01T12:00:00Z', { status: 'running', resultSummary: null })]);
    expect(turns.map((turn) => turn.kind)).toEqual(['transcript', 'run']);
    expect(turns[1]?.answer).toBeNull();
  });

  it('la misma pregunta de otro día no se casa con el trabajo de hoy', () => {
    const turns = buildTurns([
      msg('user', 'sigue por donde lo dejaste', '2026-10-01T09:00:00Z'),
      msg('assistant', 'hecho la otra vez', '2026-10-01T09:05:00Z'),
    ], [run('r3', 'sigue por donde lo dejaste', '2026-11-01T12:00:00Z')]);
    expect(turns.map((turn) => turn.kind)).toEqual(['transcript', 'run']);
  });

  it('un trabajo fallido se resume con su error', () => {
    const turns = buildTurns([], [run('r4', 'x', '2026-11-01T12:00:00Z', {
      status: 'failed', resultSummary: null, errorMessage: 'host caído',
    })]);
    expect(turns[0]?.answer).toBe('host caído');
  });
});

describe('fullAnswer · lo que copia la tarjeta plegada', () => {
  it('la respuesta del transcript se copia entera, con su Markdown', () => {
    const turns = buildTurns([
      msg('user', 'qué pasa', '2026-11-01T09:00:00Z'),
      msg('assistant', '**El pool** se agota', '2026-11-01T09:00:10Z'),
    ], []);
    expect(fullAnswer(turns[0]!)).toBe('**El pool** se agota');
  });

  it('la de un trabajo cortada por el core no se ofrece: media respuesta no es la respuesta', () => {
    const cortada = 'x'.repeat(RESULT_SUMMARY_MAX);
    const turns = buildTurns([], [
      run('r5', 'larga', '2026-11-01T12:00:00Z', { resultSummary: cortada }),
      run('r6', 'corta', '2026-11-01T13:00:00Z', { resultSummary: 'hecho' }),
    ]);
    expect(fullAnswer(turns[0]!)).toBeNull();
    expect(fullAnswer(turns[1]!)).toBe('hecho');
  });

  it('sin respuesta no hay nada que copiar', () => {
    const turns = buildTurns([], [run('r7', 'x', '2026-11-01T12:00:00Z', { status: 'running', resultSummary: null })]);
    expect(fullAnswer(turns[0]!)).toBeNull();
  });
});

describe('oneLine', () => {
  it('aplana y recorta', () => {
    expect(oneLine('a\n\n  b')).toBe('a b');
    expect(oneLine('x'.repeat(10), 5)).toBe('xxxx…');
    expect(oneLine(null)).toBe('');
  });

  it('plegado se lee como frase: sin comillas de código ni negritas', () => {
    expect(oneLine('hay un `finally` que **falta**')).toBe('hay un finally que falta');
    expect(oneLine('## Resumen\nTodo bien')).toBe('Resumen Todo bien');
  });
});
