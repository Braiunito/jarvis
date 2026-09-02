/**
 * Las herramientas del Assistant y el turno del modelo.
 *
 * Lo que se prueba aquí no es que el coordinador sea listo —eso no se prueba— sino las tres cosas
 * que lo hacen seguro de operar: que una herramienta no alcanza trabajo de otro workspace, que lo
 * que devuelve va acotado y lo dice, y que un turno siempre acaba en una decisión que el core
 * puede persistir, nunca en un bucle de consultas.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeSessionIndex, indexRow } from '@jarvis/testkit';
import type { Plan, Workspace } from '@jarvis/contracts';
import { openDatabase } from '../src/platform/db.js';
import { fixedClock } from '../src/platform/clock.js';
import { newRunId } from '../src/platform/ids.js';
import { buildServices, type CoreServices } from '../src/services.js';
import { CoreAssistantToolbox } from '../src/assistant/toolbox.js';
import { AnthropicModel, renderContext, type FetchLike } from '../src/assistant/model.js';
import type { AssistantToolbox, PlanContext, ToolOutcome } from '../src/assistant/types.js';

const user = { userId: 'u1', username: 'braian' };
const NOW = '2026-09-02T12:00:00.000Z';

let services: CoreServices;
let index: FakeSessionIndex;

beforeEach(() => {
  index = new FakeSessionIndex([
    indexRow(),
    indexRow({ session_key: 'local:codex:sid-2', provider: 'codex', session_id: 'sid-2', title: 'migrar el pool a pgbouncer' }),
  ]);
  services = buildServices({
    db: openDatabase({ path: ':memory:' }),
    clock: fixedClock(NOW),
    index: index as never,
    model: null,
    config: { hosts: ['bastion'], bastionHost: 'bastion', spoolRoot: '/tmp/jarvis-toolbox-spool' },
  });
});

const openWorkspace = (sessionId = 'sid-1'): Workspace =>
  services.workspaces.open({ ref: { host: 'bastion', provider: 'claude', sessionId } }, user).workspace;

const planOn = (workspace: Workspace): Plan => ({
  id: 'pl-test', workspaceId: workspace.id, createdBy: user.username,
  objective: 'averigua por qué el pool se queda sin conexiones', status: 'running',
  currentStep: 0, createdAt: NOW, updatedAt: NOW, finishedAt: null, summary: null,
});

const toolboxFor = (workspace: Workspace): CoreAssistantToolbox => new CoreAssistantToolbox({
  plan: planOn(workspace),
  workspace,
  sessions: services.sessions,
  health: services.health,
  runs: services.runs,
  audit: services.audit,
  user,
});

/** Un run insertado a mano: aquí interesa qué ve el toolbox, no cómo se ejecuta. */
function seedRun(workspaceId: string, overrides: { id?: string } = {}): string {
  const id = overrides.id ?? newRunId();
  services.runRepository.insert({
    id, workspaceId, createdBy: user.username, provider: 'claude', sessionId: 'sid-1',
    prompt: 'mira el log', workHost: 'bastion', executionHost: 'bastion', strategy: 'A',
    strategyReason: null, cwd: '/srv/app', permissionProfile: 'safe', model: null, attempt: 1,
    parentRunId: null, remoteName: `jarvis-${id}`, remoteSpoolDir: `/tmp/${id}`,
    createdAt: NOW, deadlineAt: null,
  });
  return id;
}

const content = (outcome: ToolOutcome): Record<string, unknown> => {
  if (outcome.type !== 'observation') throw new Error('se esperaba una observación, no una decisión');
  return outcome.content as Record<string, unknown>;
};

describe('las herramientas hablan con los casos de uso del core', () => {
  it('search_sessions devuelve referencias acotadas y dice de cuándo son', async () => {
    const toolbox = toolboxFor(openWorkspace());
    const result = content(await toolbox.invoke('search_sessions', { q: 'pool', limit: 50 }));

    expect(result['ok']).toBe(true);
    const sessions = result['sessions'] as Array<Record<string, unknown>>;
    // El límite es del core: pedir 50 no sube el techo.
    expect(sessions.length).toBeLessThanOrEqual(8);
    expect(sessions[0]).toMatchObject({ host: 'bastion', provider: 'claude', sessionId: 'sid-1' });
    // Frescura y momento de la consulta viajan siempre: un índice viejo sirve si se dice que lo es.
    expect(result).toHaveProperty('stale', false);
    expect(result).toHaveProperty('fetchedAt');
    expect(result['freshness']).toBeInstanceOf(Array);
  });

  it('un provider que no existe se explica en vez de fallar por dentro', async () => {
    const toolbox = toolboxFor(openWorkspace());
    const result = content(await toolbox.invoke('search_sessions', { provider: 'gemini' }));
    const error = result['error'] as Record<string, string>;
    expect(result['ok']).toBe(false);
    expect(error['code']).toBe('BAD_INPUT');
    // Decir qué faltaba, no que no se puede.
    expect(error['hint']).toContain('claude');
  });

  it('get_session_context recorta y avisa de que recortó', async () => {
    const workspace = openWorkspace();
    index.transcripts.set('sid-1', [
      { role: 'user', at: NOW, text: 'x'.repeat(5000) },
      { role: 'assistant', at: NOW, text: 'miro el log' },
    ]);
    const result = content(await toolboxFor(workspace).invoke('get_session_context', { last: 5 }));

    const messages = result['messages'] as Array<{ text: string; provenance: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.text.length).toBeLessThan(5000);
    expect(result['messagesClipped']).toBe(true);
    // La procedencia se conserva: lo que escribió el CLI remoto no se confunde con lo de Jarvis.
    expect(messages[0]?.provenance).toBe('remote-transcript');
  });

  it('el transcript dice cuántos mensajes tiene la sesión, no cuántos cabían', async () => {
    const workspace = openWorkspace();
    // La fila del índice declara 3 + 4; la página que se pide es de 2.
    index.transcripts.set('sid-1', [
      { role: 'user', at: NOW, text: 'uno' },
      { role: 'assistant', at: NOW, text: 'dos' },
    ]);
    const transcript = await services.sessions.transcript(workspace.ref, { last: 2 });
    expect(transcript.messages).toHaveLength(2);
    expect(transcript.messageCount).toBe(7);
  });

  it('get_health resume por salto y no arrastra el detalle entero', async () => {
    const result = content(await toolboxFor(openWorkspace()).invoke('get_health', {}));
    const checks = result['checks'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(checks)).toContain('database');
    expect(checks['database']).toHaveProperty('status');
    expect(checks['database']).not.toHaveProperty('detail');
    // Sin sondear: preguntar por la salud en cada turno no puede costar una ronda de SSH.
    expect(result['probed']).toBe(false);
  });

  it('un plan sólo ve el trabajo de su propio workspace', async () => {
    const mine = openWorkspace('sid-1');
    const other = openWorkspace('sid-2');
    const myRun = seedRun(mine.id);
    const foreignRun = seedRun(other.id);
    const toolbox = toolboxFor(mine);

    const listed = content(await toolbox.invoke('list_runs', {}));
    const runs = listed['runs'] as Array<Record<string, unknown>>;
    expect(runs.map((run) => run['runId'])).toEqual([myRun]);

    const stolen = content(await toolbox.invoke('get_run', { runId: foreignRun }));
    expect(stolen['ok']).toBe(false);
    expect((stolen['error'] as Record<string, string>)['code']).toBe('NOT_FOUND');

    const cancelled = content(await toolbox.invoke('cancel_run', { runId: foreignRun }));
    expect((cancelled['error'] as Record<string, string>)['code']).toBe('NOT_FOUND');
  });

  it('el presupuesto de consultas lo impone el core, no el catálogo que se ofrece', async () => {
    const workspace = openWorkspace();
    const toolbox = new CoreAssistantToolbox({
      plan: planOn(workspace), workspace, sessions: services.sessions, health: services.health,
      runs: services.runs, audit: services.audit, user, maxObservations: 2,
    });

    await toolbox.invoke('list_runs', {});
    await toolbox.invoke('list_runs', {});
    // La tercera lectura no se sirve aunque el modelo insista: el freno es del servidor.
    const spent = content(await toolbox.invoke('list_runs', {}));
    expect((spent['error'] as Record<string, string>)['code']).toBe('BUDGET_SPENT');
    expect((spent['error'] as Record<string, string>)['hint']).toContain('finish');
    expect(toolbox.observations).toBe(2);

    // Decidir sigue estando permitido: un turno sin salida sería peor que uno caro.
    const outcome = await toolbox.invoke('finish', { summary: 'lo miro en el siguiente turno' });
    expect(outcome.type).toBe('decision');
  });

  it('una herramienta que no existe dice cuáles hay', async () => {
    const result = content(await toolboxFor(openWorkspace()).invoke('rm_rf', {}));
    const error = result['error'] as Record<string, string>;
    expect(error['code']).toBe('UNKNOWN_TOOL');
    expect(error['hint']).toContain('create_run');
  });
});

describe('las decisiones son las acciones que el core sabe ejecutar', () => {
  it('create_run devuelve un checkpoint, no una espera', async () => {
    const outcome = await toolboxFor(openWorkspace()).invoke('create_run', {
      title: 'Reunir contexto', prompt: 'mira el log de la aplicación', permission_profile: 'safe',
    });
    expect(outcome).toEqual({
      type: 'decision',
      decision: {
        kind: 'run', title: 'Reunir contexto', prompt: 'mira el log de la aplicación',
        permissionProfile: 'safe', rationale: '',
      },
    });
  });

  it('sin restricciones no se concede por la vía rápida', async () => {
    const result = content(await toolboxFor(openWorkspace()).invoke('create_run', {
      title: 'arreglarlo', prompt: 'lo que haga falta', permission_profile: 'yolo',
    }));
    expect((result['error'] as Record<string, string>)['code']).toBe('FORBIDDEN');
    expect((result['error'] as Record<string, string>)['hint']).toContain('request_approval');
  });

  it('la síntesis cita evidencia que existe, y descarta la inventada', async () => {
    const workspace = openWorkspace();
    const runId = seedRun(workspace.id);
    const outcome = await toolboxFor(workspace).invoke('finish', {
      summary: 'el pool no cerraba las conexiones en el handler',
      evidence_run_ids: [runId, 'rinventado'],
    });
    expect(outcome.type).toBe('decision');
    if (outcome.type !== 'decision' || outcome.decision.kind !== 'finish') throw new Error('sin síntesis');
    expect(outcome.decision.evidenceRunIds).toEqual([runId]);
  });

  it('ofrecer una terminal la deja preparada, no la abre', async () => {
    const workspace = openWorkspace();
    const toolbox = toolboxFor(workspace);
    const result = content(await toolbox.invoke('open_terminal_offer', { reason: 'hay que mirarlo en vivo' }));

    expect(result['ok']).toBe(true);
    expect(toolbox.terminalOffer).toMatchObject({
      host: 'bastion', provider: 'claude', sessionId: 'sid-1', permissionProfile: 'safe',
    });
    // Nada se ha levantado en la máquina: la oferta es un dato del plan, y abrir una terminal
    // deja rastro en la auditoría. Aquí no hay ninguno.
    const events = services.audit.recent(50).map((row) => row['event_type']);
    expect(events).not.toContain('terminal.opened');
  });
});

/** Un toolbox de mentira, para mirar el turno del modelo sin base de datos ni red. */
class StubToolbox implements AssistantToolbox {
  readonly calls: string[] = [];
  readonly offered: Array<{ decisionsOnly: boolean }> = [];
  terminalOffer = null;
  observations = 0;

  definitions({ decisionsOnly = false }: { decisionsOnly?: boolean } = {}) {
    this.offered.push({ decisionsOnly });
    const all = [
      { name: 'get_health', description: '', inputSchema: { type: 'object' as const, properties: {} }, decides: false },
      { name: 'finish', description: '', inputSchema: { type: 'object' as const, properties: {} }, decides: true },
    ];
    return all.filter((tool) => !decisionsOnly || tool.decides);
  }

  async invoke(name: string): Promise<ToolOutcome> {
    this.calls.push(name);
    if (name === 'finish') return { type: 'decision', decision: { kind: 'finish', summary: 'listo' } };
    this.observations += 1;
    return { type: 'observation', content: { ok: true, status: 'ok' } };
  }
}

const context: PlanContext = {
  objective: 'revisar el pool',
  workspace: { id: 'w1', host: 'bastion', provider: 'claude', sessionId: 'sid-1', cwd: '/srv/app', title: null },
  history: [],
  pendingInput: null,
  pendingApprovals: [],
  limits: { stepsUsed: 0, maxSteps: 12, maxToolCalls: 2, maxToolOutputBytes: 60_000 },
};

/** Respuestas de la Messages API, en el orden en que se piden. */
function fakeModel(replies: Array<Array<Record<string, unknown>>>): { fetchImpl: FetchLike; bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  let call = 0;
  const fetchImpl: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const content = replies[Math.min(call, replies.length - 1)] ?? [];
    call += 1;
    return new Response(JSON.stringify({ content }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, bodies };
}

describe('un turno del modelo termina en decisión, nunca en bucle', () => {
  it('consulta lo que necesita y cierra con una acción del core', async () => {
    const toolbox = new StubToolbox();
    const { fetchImpl, bodies } = fakeModel([
      [{ type: 'tool_use', id: 't1', name: 'get_health', input: {} }],
      [{ type: 'tool_use', id: 't2', name: 'finish', input: { summary: 'listo' } }],
    ]);
    const model = new AnthropicModel({ apiKey: 'k', baseUrl: 'https://api.test', model: 'claude-sonnet-5', fetchImpl });

    const decision = await model.decide(context, toolbox);

    expect(decision).toEqual({ kind: 'finish', summary: 'listo' });
    expect(toolbox.calls).toEqual(['get_health', 'finish']);
    // La observación vuelve al modelo como tool_result, en la misma llamada: sin request abierta
    // esperando y sin perder lo ya consultado.
    const second = bodies[1]?.['messages'] as Array<{ role: string; content: unknown }>;
    expect(second).toHaveLength(3);
    expect(JSON.stringify(second[2]?.content)).toContain('tool_result');
    // La credencial va en la cabecera del core y no aparece en el cuerpo.
    expect(JSON.stringify(bodies[0])).not.toContain('"k"');
  });

  it('un modelo que sólo consultaría acaba igualmente en decisión', async () => {
    const toolbox = new StubToolbox();
    // Un modelo que consultaría para siempre si se le dejara.
    const { fetchImpl } = fakeModel([[{ type: 'tool_use', id: 't1', name: 'get_health', input: {} }]]);
    const model = new AnthropicModel({
      apiKey: 'k', baseUrl: 'https://api.test', model: 'claude-sonnet-5', fetchImpl, maxToolCalls: 2,
    });

    const decision = await model.decide(context, toolbox);

    // En la última vuelta se le ofrecen sólo las que deciden, y el turno termina en un checkpoint
    // en vez de seguir leyendo.
    expect(toolbox.offered.at(-1)).toEqual({ decisionsOnly: true });
    expect(toolbox.calls.length).toBeLessThanOrEqual(3);
    expect(decision.kind).toBe('finish');
  });

  it('si el modelo contesta sin herramienta, lo dicho se cierra como síntesis', async () => {
    const { fetchImpl } = fakeModel([[{ type: 'text', text: 'no encuentro nada que hacer aquí' }]]);
    const model = new AnthropicModel({ apiKey: 'k', baseUrl: 'https://api.test', model: 'm', fetchImpl });
    const decision = await model.decide(context, new StubToolbox());
    expect(decision).toEqual({ kind: 'finish', summary: 'no encuentro nada que hacer aquí' });
  });
});

describe('el contexto que ve el modelo', () => {
  it('lleva la respuesta de la persona, los límites y las referencias, no los buffers', () => {
    const rendered = renderContext({
      ...context,
      history: [{
        ordinal: 0, kind: 'run', title: 'Reunir contexto', status: 'completed',
        summary: 'faltaba un finally en el handler', runId: 'r123', errorCode: null,
      }],
      pendingInput: 'sí, aplícalo en staging primero',
      pendingApprovals: [{ id: 'a1', summary: 'escribir en /srv/app', expiresAt: NOW }],
    });

    expect(rendered).toContain('trabajo r123');
    expect(rendered).toContain('faltaba un finally');
    expect(rendered).toContain('sí, aplícalo en staging primero');
    // Una aprobación viva se nombra para que no se pida dos veces lo mismo.
    expect(rendered).toContain('escribir en /srv/app');
    expect(rendered).toContain('12 pasos');
  });
});
