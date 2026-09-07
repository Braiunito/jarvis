/**
 * Un workflow: el plan entero antes de tocar nada, y un perímetro que se firma una vez.
 *
 * Lo que se prueba aquí no es que el modelo planifique bien —eso no se prueba— sino las dos cosas
 * que hacen que un plan aprobado de golpe sea seguro de ejecutar:
 *
 *   · un borrador **no avanza** hasta que alguien lo firma, y lo que se firma es el sobre;
 *   · lo que se sale del sobre **no falla ni obedece**: se convierte en una tarjeta que dice qué
 *     se pidió y qué se autorizó.
 *
 * Y una tercera que sólo se ve cruzando pasos: los topes del sobre se gastan **a lo largo del
 * plan**, no dentro de un turno. Una prueba que mire un solo paso da por bueno un `maxRuns` que
 * nunca se llega a agotar.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeSessionIndex, fakeSshPath, indexRow } from '@jarvis/testkit';
import type { AutonomyMode, PermissionProfile, WorkflowEnvelope } from '@jarvis/contracts';
import { HybridModel } from '../../apps/core/src/assistant/hybrid.js';
import { openDatabase } from '../../apps/core/src/platform/db.js';
import { buildServices, type CoreServices } from '../../apps/core/src/services.js';
import { digestOf } from '../../apps/core/src/plans/workflow.js';
import type {
  AssistantDecision, AssistantModel, AssistantToolbox, PlanContext,
} from '../../apps/core/src/assistant/types.js';

const user = { userId: 'u1', username: 'braian' };

/** Un modelo que decide lo que se le diga, paso a paso, y guarda el contexto que le llegó. */
class PlanBrain implements AssistantModel {
  readonly id = 'local';
  calls = 0;
  lastContext: PlanContext | null = null;
  #script: Array<(context: PlanContext) => AssistantDecision>;

  constructor(script: Array<(context: PlanContext) => AssistantDecision>) {
    this.#script = script;
  }

  async decide(context: PlanContext, _toolbox: AssistantToolbox): Promise<AssistantDecision> {
    this.lastContext = context;
    const step = this.#script[this.calls] ?? (() => ({ kind: 'finish' as const, summary: 'ya está' }));
    this.calls += 1;
    return step(context);
  }
}

let open: CoreServices[] = [];
afterEach(() => {
  for (const services of open) services.close();
  open = [];
});

function harness(model: PlanBrain, dbPath = ':memory:'): CoreServices {
  const services = buildServices({
    db: openDatabase({ path: dbPath }),
    index: new FakeSessionIndex([indexRow()]) as never,
    model: model as never,
    config: {
      hosts: ['bastion'], bastionHost: 'bastion', spoolRoot: '/tmp/jarvis-workflow-spool',
      sshCommand: fakeSshPath(), knownHostsFile: '',
    },
  });
  open.push(services);
  return services;
}

const sobre = (overrides: Partial<WorkflowEnvelope> = {}): WorkflowEnvelope => ({
  hosts: ['bastion'],
  maxSteps: 6,
  maxRuns: 3,
  highestPermissionProfile: 'safe' as PermissionProfile,
  writes: false,
  capabilities: [],
  ...overrides,
});

/** Un workflow de dos pasos estimativos sobre un workspace de verdad. */
function draftWorkflow(services: CoreServices, envelope = sobre(), autonomy: AutonomyMode = 'auto') {
  const workspace = services.workspaces.open(
    { ref: { host: 'bastion', provider: 'claude', sessionId: 'sid-1' } }, user,
  ).workspace;
  const plan = services.plans.createWorkflow({
    workspaceId: workspace.id,
    objective: 'averiguar por qué el pool se queda sin conexiones',
    envelope,
    autonomy,
    steps: [
      { title: 'Mirar el log', intent: 'ver qué dice el log del pool', expects: 'la hora del primer fallo', unknowns: ['si hay rotación'] },
      { title: 'Comprobar el límite', intent: 'ver el pool_size configurado', expects: 'el número' },
    ],
    user,
  });
  return { workspace, plan };
}

/**
 * Da por terminado el trabajo del último paso, como haría el supervisor.
 *
 * Sin esto el plan se queda esperando —correctamente— y el paso siguiente no se ata nunca. Lo que
 * se prueba aquí es el motor de pasos, no el ciclo de vida de un run.
 */
function terminaElTrabajo(services: CoreServices, planId: string): void {
  const step = services.plans.steps(planId).find((candidate) => candidate.runId);
  if (!step?.runId) throw new Error('no hay ningún paso con trabajo que terminar');
  services.runRepository.appendBatch(step.runId, [], {
    status: 'completed', finishedAt: '2030-01-01T00:00:00.000Z',
    resultOk: true, resultSummary: 'salió bien',
  });
}

describe('WF · un borrador es un plan escrito que todavía no corre', () => {
  it('nace en draft, con sus pasos estimativos y su sobre', () => {
    const services = harness(new PlanBrain([]));
    const { plan } = draftWorkflow(services);

    expect(plan.status).toBe('draft');
    expect(plan.envelope).toMatchObject({ hosts: ['bastion'], maxRuns: 3, writes: false });

    const steps = services.plans.steps(plan.id);
    expect(steps).toHaveLength(2);
    expect(steps[0]?.kind).toBe('estimate');
    // Lo más valioso del borrador es lo que declara **no** saber: quien firma tiene que verlo.
    expect((steps[0]?.input as { unknowns: string[] }).unknowns).toEqual(['si hay rotación']);
    // Y ninguno está atado a nada todavía: eso es trabajo del turno que llegue a cada uno.
    expect(steps.every((step) => step.runId === null)).toBe(true);
  });

  it('un workflow sin pasos no es un plan', () => {
    const services = harness(new PlanBrain([]));
    const workspace = services.workspaces.open(
      { ref: { host: 'bastion', provider: 'claude', sessionId: 'sid-1' } }, user,
    ).workspace;
    expect(() => services.plans.createWorkflow({
      workspaceId: workspace.id, objective: 'algo', envelope: sobre(), steps: [], user,
    })).toThrow(/sin pasos/);
  });

  it('firmarlo lo pone a pensar, y sólo con el sobre que se enseñó', () => {
    const services = harness(new PlanBrain([]));
    const { plan } = draftWorkflow(services);
    const digest = digestOf({ planId: plan.id, objective: plan.objective, envelope: plan.envelope! });

    // Firmar otra cosa no vale: entre proponer y firmar cabe una revisión, y ejecutar un sobre
    // distinto del que se leyó es justo lo que el digest existe para impedir.
    expect(() => services.plans.activate(plan.id, user, 'otro-digest'))
      .toThrow(/no es lo que hay/);

    expect(services.plans.activate(plan.id, user, digest).status).toBe('ready');
    // Y no se firma dos veces.
    expect(() => services.plans.activate(plan.id, user, digest)).toThrow(/ya no es un borrador/);
  });
});

describe('WF · lo que se sale del sobre se convierte en tarjeta', () => {
  const unRun = (permissionProfile: PermissionProfile = 'safe'): AssistantDecision => ({
    kind: 'run',
    title: 'Leer el log',
    prompt: 'lee el log del pool y dime la hora del primer fallo',
    permissionProfile,
    rationale: 'hace falta el log para saber cuándo empezó',
  });

  const enMarcha = (model: PlanBrain, envelope = sobre()) => {
    const services = harness(model);
    const { plan } = draftWorkflow(services, envelope);
    const digest = digestOf({ planId: plan.id, objective: plan.objective, envelope: plan.envelope! });
    services.plans.activate(plan.id, user, digest);
    return { services, plan };
  };

  it('dentro del sobre, el trabajo se lanza sin preguntar', async () => {
    const { services, plan } = enMarcha(new PlanBrain([() => unRun('safe')]));
    await services.plans.advance(plan.id, user);

    const paso = services.plans.steps(plan.id)[0];
    expect(paso?.kind).toBe('run');
    expect(paso?.approvalId).toBeNull();
  });

  it('pedir más permiso del firmado no falla: pregunta, y dice qué se autorizó', async () => {
    const { services, plan } = enMarcha(new PlanBrain([() => unRun('auto')]));
    await services.plans.advance(plan.id, user);

    const paso = services.plans.steps(plan.id)[0];
    expect(paso?.kind).toBe('approval');
    const approval = services.plans.approval(paso!.approvalId!);
    /*
     * El motivo va en el `summary` porque es lo que va a leer una persona. «Fuera del sobre» no
     * explica nada; qué se pidió y qué se autorizó, sí.
     */
    expect(approval?.summary).toContain('permiso «auto»');
    expect(approval?.summary).toContain('«safe»');
  });

  it('un plan sin sobre no se comprueba: los de antes siguen igual', async () => {
    const services = harness(new PlanBrain([() => unRun('auto')]));
    const workspace = services.workspaces.open(
      { ref: { host: 'bastion', provider: 'claude', sessionId: 'sid-1' } }, user,
    ).workspace;
    // `create()` no firma perímetro: es un plan de los de siempre.
    const plan = services.plans.create({ workspaceId: workspace.id, objective: 'mirar el pool', user });
    await services.plans.advance(plan.id, user);

    // En `manual` pide tarjeta por su propia regla, no por el sobre: lo que importa aquí es que
    // no aparece ningún motivo de perímetro, porque no hay perímetro que comprobar.
    const paso = services.plans.steps(plan.id).at(-1);
    const approval = paso?.approvalId ? services.plans.approval(paso.approvalId) : null;
    expect(approval?.summary ?? '').not.toContain('Se sale de lo aprobado');
  });
});

describe('WF · los topes se gastan a lo largo del plan, no dentro de un turno', () => {
  it('con un solo trabajo firmado, el segundo paso pide tarjeta', async () => {
    /*
     * La prueba que cruza la frontera de verdad.
     *
     * `maxRuns` no se agota en un turno: se agota cuando el plan lleva ya un trabajo lanzado y
     * pide otro. Mirando un solo paso, cualquier tope parece respetado — y el fallo aparece en el
     * segundo, que es donde nadie mira.
     */
    const model = new PlanBrain([
      () => ({ kind: 'run', title: 'Primero', prompt: 'mira el log', permissionProfile: 'safe', rationale: 'hace falta' }),
      () => ({ kind: 'run', title: 'Segundo', prompt: 'mira el otro log', permissionProfile: 'safe', rationale: 'y esto también' }),
    ]);
    const services = harness(model);
    const { plan } = draftWorkflow(services, sobre({ maxRuns: 1 }));
    const digest = digestOf({ planId: plan.id, objective: plan.objective, envelope: plan.envelope! });
    services.plans.activate(plan.id, user, digest);

    await services.plans.advance(plan.id, user);
    expect(services.plans.steps(plan.id)[0]?.kind).toBe('run');

    // Segundo paso: el sobre ya no da para otro trabajo. El primero tiene que haber terminado,
    // que es lo que hace que el plan pase de esperar a pensar.
    terminaElTrabajo(services, plan.id);
    await services.plans.advance(plan.id, user);
    const segundo = services.plans.steps(plan.id)[1];
    expect(segundo?.kind).toBe('approval');
    expect(services.plans.approval(segundo!.approvalId!)?.summary).toContain('el trabajo 2');
  });
});

describe('WF · un plan puede repartir trabajo entre máquinas', () => {
  /*
   * Para esto existe un plan de varios pasos, y hasta ahora no se podía.
   *
   * Los dos sitios donde el motor creaba un run usaban el workspace del plan, así que todos los
   * trabajos caían en la misma máquina y el `hosts` **en plural** del sobre prometía algo que nadie
   * podía cumplir. Lo que eso impedía es el caso real de la casa: un agente investiga en una
   * máquina, encuentra la causa y dice «no tengo acceso a la otra, que lo haga quien lo tenga», y
   * una persona hace de puente. Ese puente es lo que el plan tiene que saber hacer solo.
   */
  const casa = (model: PlanBrain): CoreServices => {
    const services = buildServices({
      db: openDatabase({ path: ':memory:' }),
      index: new FakeSessionIndex([indexRow()]) as never,
      model: model as never,
      config: {
        hosts: ['bastion', 'goro2'], bastionHost: 'bastion', spoolRoot: '/tmp/jarvis-workflow-spool',
        sshCommand: fakeSshPath(), knownHostsFile: '',
      },
    });
    open.push(services);
    return services;
  };

  const enDos = (services: CoreServices) => {
    const workspace = services.workspaces.open(
      { ref: { host: 'bastion', provider: 'claude', sessionId: 'sid-1' } }, user,
    ).workspace;
    const plan = services.plans.createWorkflow({
      workspaceId: workspace.id,
      objective: 'averiguar por qué el login entra en bucle',
      envelope: sobre({ hosts: ['bastion', 'goro2'], maxRuns: 4 }),
      steps: [
        { title: 'Investigar en bastion', intent: 'leer el código', expects: 'la causa' },
        { title: 'Arreglar en goro2', intent: 'aplicar el arreglo', expects: 'el diff' },
      ],
      user,
    });
    const digest = digestOf({ planId: plan.id, objective: plan.objective, envelope: plan.envelope! });
    services.plans.activate(plan.id, user, digest);
    return plan;
  };

  const dondeCorrio = (services: CoreServices, ordinal: number): string | null => {
    const step = services.plans.steps(services.plans.listActive()[0]!.id)[ordinal];
    if (!step?.runId) return null;
    const run = services.runs.require(step.runId);
    return services.workspaces.find(run.workspaceId)?.ref.host ?? null;
  };

  it('el segundo paso trabaja en otra máquina, y se le abre sesión si no la había', async () => {
    const services = casa(new PlanBrain([
      () => ({ kind: 'run', title: 'Investigar', prompt: 'lee el código', permissionProfile: 'safe', rationale: 'hace falta' }),
      () => ({ kind: 'run', title: 'Arreglar', prompt: 'aplica el arreglo', permissionProfile: 'safe', rationale: 'y ahora allí', host: 'goro2' }),
    ]));
    const plan = enDos(services);

    await services.plans.advance(plan.id, user);
    terminaElTrabajo(services, plan.id);
    await services.plans.advance(plan.id, user);

    expect(dondeCorrio(services, 0)).toBe('bastion');
    // Y el segundo se fue a la otra máquina, con sesión abierta para él.
    expect(dondeCorrio(services, 1)).toBe('goro2');
  });

  it('y elige con qué agente: un Codex donde sólo había un Claude', async () => {
    /*
     * La casa tiene Claude, Codex y OpenCode, y cuál conviene depende del trabajo. El motor abría
     * siempre Claude, así que «lánzame un Codex en goro2» no se podía pedir aunque estuviera
     * instalado. Y una sesión abierta con otro agente no sirve: es otra herramienta.
     */
    const services = casa(new PlanBrain([
      () => ({
        kind: 'run', title: 'Arreglar con Codex', prompt: 'aplica el arreglo',
        permissionProfile: 'safe', rationale: 'aquí va mejor Codex', host: 'goro2', provider: 'codex',
      }),
    ]));
    const plan = enDos(services);

    await services.plans.advance(plan.id, user);

    const step = services.plans.steps(plan.id)[0];
    const run = services.runs.require(step!.runId!);
    const donde = services.workspaces.find(run.workspaceId);
    expect(donde?.ref.host).toBe('goro2');
    expect(donde?.ref.provider).toBe('codex');
  });

  it('y puede trabajar en su propia máquina, que es una más', async () => {
    // `bastion` es donde vive Jarvis, y no es un caso especial: si está en el sobre, se le lanza
    // trabajo como a cualquier otra.
    const services = casa(new PlanBrain([
      () => ({
        kind: 'run', title: 'Mirar aquí mismo', prompt: 'mira el log de casa',
        permissionProfile: 'safe', rationale: 'está aquí', host: 'bastion', provider: 'opencode',
      }),
    ]));
    const plan = enDos(services);

    await services.plans.advance(plan.id, user);

    const step = services.plans.steps(plan.id)[0];
    const donde = services.workspaces.find(services.runs.require(step!.runId!).workspaceId);
    expect(donde?.ref.host).toBe('bastion');
    expect(donde?.ref.provider).toBe('opencode');
  });

  it('no estrena un agente que esa máquina no tiene: lo dice y deja el plan pausado', async () => {
    /*
     * La flota no es uniforme y eso se sabe: la sonda dice que `goro3` sólo tiene Claude y que
     * `goro1` no tiene ninguno. Pedir un Codex donde no lo hay abría la sesión igualmente y el
     * trabajo moría en remoto con un error de shell — la peor forma de enterarse, y con el plan ya
     * gastado.
     */
    const services = casa(new PlanBrain([
      () => ({
        kind: 'run', title: 'Codex donde no hay', prompt: 'arregla esto',
        permissionProfile: 'safe', rationale: 'me apetece Codex', host: 'goro2', provider: 'codex',
      }),
    ]));
    // La flota tal como la dejaría la sonda: en goro2 hay Claude y OpenCode, no Codex.
    services.db.prepare(`INSERT INTO host_capabilities
      (host, binaries_json, providers_json, tmux, probed_at, error)
      VALUES ('goro2', '{}', '["claude","opencode"]', 1, '2030-01-01T00:00:00.000Z', NULL)`).run();
    const plan = enDos(services);

    await services.plans.advance(plan.id, user);

    const despues = services.plans.require(plan.id);
    expect(despues.status).toBe('paused');
    expect(despues.summary).toContain('no hay codex');
  });

  it('una máquina que no se firmó no se toca: se pregunta', async () => {
    const services = casa(new PlanBrain([
      () => ({ kind: 'run', title: 'Colarse', prompt: 'toca goro3', permissionProfile: 'safe', rationale: 'ya que estamos', host: 'goro3' }),
    ]));
    const workspace = services.workspaces.open(
      { ref: { host: 'bastion', provider: 'claude', sessionId: 'sid-1' } }, user,
    ).workspace;
    const plan = services.plans.createWorkflow({
      workspaceId: workspace.id,
      objective: 'arreglar el login',
      envelope: sobre({ hosts: ['bastion', 'goro2'] }),
      steps: [{ title: 'Uno', intent: 'algo', expects: 'algo' }],
      user,
    });
    services.plans.activate(plan.id, user,
      digestOf({ planId: plan.id, objective: plan.objective, envelope: plan.envelope! }));

    await services.plans.advance(plan.id, user);

    const paso = services.plans.steps(plan.id)[0];
    expect(paso?.kind).toBe('approval');
    // El motivo dice qué máquina se pidió y cuáles se firmaron: «fuera del sobre» no explica nada.
    expect(services.plans.approval(paso!.approvalId!)?.summary).toContain('goro3');
  });

  it('y un plan de la casa puede trabajar, si dice en qué máquina', async () => {
    /*
     * Antes un plan sin sesión no lanzaba nada, nunca. Ahora sí, **si nombra una máquina firmada**:
     * lo que lo hace seguro no es tener workspace, es el sobre.
     */
    const services = casa(new PlanBrain([
      () => ({ kind: 'run', title: 'Mirar goro2', prompt: 'mira el log', permissionProfile: 'safe', rationale: 'allí está', host: 'goro2' }),
    ]));
    const plan = services.plans.createWorkflow({
      workspaceId: null,
      objective: 'mirar el login en goro2',
      envelope: sobre({ hosts: ['goro2'] }),
      steps: [{ title: 'Mirar', intent: 'ver el log', expects: 'la causa' }],
      user,
    });
    services.plans.activate(plan.id, user,
      digestOf({ planId: plan.id, objective: plan.objective, envelope: plan.envelope! }));

    await services.plans.advance(plan.id, user);

    const paso = services.plans.steps(plan.id)[0];
    expect(paso?.kind).toBe('run');
    expect(dondeCorrio(services, 0)).toBe('goro2');
  });
});

describe('WF · un plan cuenta en su hilo lo que hace', () => {
  /*
   * El bug que se vio en producción: se aprueba el plan y no se vuelve a saber de él.
   *
   * El plan `pfeoyeyawaqhzlsvx` se quedó en `waiting_input` con su paso atado a una pregunta —«¿qué
   * permisos de escritura…?»— que **nunca se escribió en el hilo**. Lo último que se leía era «el
   * plan queda en marcha», así que la persona escribió «autoricé el plan» dos minutos después: no
   * tenía forma de saber que le tocaba a ella. El motor avanza en otro momento que el turno que lo
   * propuso, y hasta ahora no tenía por dónde contarlo.
   */
  const harnessChat = (model: PlanBrain): CoreServices => {
    const services = buildServices({
      db: openDatabase({ path: ':memory:' }),
      index: new FakeSessionIndex([indexRow()]) as never,
      model: new HybridModel({ local: model, cloud: model }),
      config: {
        hosts: ['bastion'], bastionHost: 'bastion', spoolRoot: '/tmp/jarvis-workflow-spool',
        sshCommand: fakeSshPath(), knownHostsFile: '',
      },
    });
    open.push(services);
    return services;
  };

  const propone = (): AssistantDecision => ({
    kind: 'workflow',
    objective: 'averiguar por qué el pool se queda sin conexiones',
    steps: [
      { title: 'Mirar el log', intent: 'ver qué dice el log', expects: 'la hora del primer fallo' },
      { title: 'Comprobar el límite', intent: 'ver el pool_size', expects: 'el número' },
    ],
    hosts: ['bastion'],
    highestPermissionProfile: 'safe',
    rationale: 'con dos pasos se sabe si es el pool o la red',
  });

  it('la pregunta de un plan llega al hilo del que salió', async () => {
    const services = harnessChat(new PlanBrain([
      () => propone(),
      () => ({ kind: 'ask', title: 'Falta un dato', question: '¿qué pool_size esperabas?' }),
    ]));
    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'mira por qué se queda sin conexiones', user);
    await services.chat.settled(conversation.id);

    const [tarjeta] = services.chat.pendingApprovals(conversation.id);
    const planId = String((tarjeta!.target as { planId?: string }).planId);
    await services.chat.resolveApproval(tarjeta!.id, 'approved', user);
    await services.plans.advance(planId, user);

    expect(services.plans.require(planId).status).toBe('waiting_input');
    // Y la persona puede enterarse, que es de lo que iba todo esto.
    const dicho = services.chat.messages(conversation.id).map((message) => message.text ?? '').join('\n');
    expect(dicho).toContain('¿qué pool_size esperabas?');
  });

  it('y cuando termina, también lo dice', async () => {
    const services = harnessChat(new PlanBrain([
      () => propone(),
      () => ({ kind: 'finish', summary: 'era el pool_size, estaba en 5' }),
    ]));
    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'mira por qué se queda sin conexiones', user);
    await services.chat.settled(conversation.id);

    const [tarjeta] = services.chat.pendingApprovals(conversation.id);
    const planId = String((tarjeta!.target as { planId?: string }).planId);
    await services.chat.resolveApproval(tarjeta!.id, 'approved', user);
    await services.plans.advance(planId, user);

    const dicho = services.chat.messages(conversation.id).map((message) => message.text ?? '').join('\n');
    expect(dicho).toContain('era el pool_size');
  });

  it('un plan de la casa no tiene a quién contárselo, y no se rompe por eso', async () => {
    // Sin conversación detrás no hay hilo donde escribir: el plan sigue funcionando igual.
    const services = harness(new PlanBrain([() => ({ kind: 'finish', summary: 'ya está' })]));
    const plan = services.plans.createWorkflow({
      workspaceId: null,
      objective: 'mirar la casa',
      envelope: sobre({ hosts: [] }),
      steps: [{ title: 'Mirar', intent: 'ver', expects: 'algo' }],
      user,
    });
    services.plans.activate(plan.id, user);
    await services.plans.advance(plan.id, user);

    expect(services.plans.require(plan.id).status).toBe('completed');
  });
});

describe('WF · cerrar un plan a medias no destruye lo hecho', () => {
  const enMarcha = (model: PlanBrain, envelope = sobre()) => {
    const services = harness(model);
    const { plan } = draftWorkflow(services, envelope);
    const digest = digestOf({ planId: plan.id, objective: plan.objective, envelope: plan.envelope! });
    services.plans.activate(plan.id, user, digest);
    return { services, plan };
  };

  it('un finish que deja pasos firmados sin dar deja el plan pausado, no terminado', async () => {
    /*
     * Medido contra producción: el modelo cierra el plan tras el primer paso parte de las veces,
     * incluso con el aviso del turno delante. Lo que se arregla aquí no es esa frecuencia —eso es
     * conducta del modelo— sino lo que costaba: el plan quedaba `completed` y los pasos firmados
     * que quedaban se perdían, así que para seguir había que reproponerlo entero y repetir lo hecho.
     */
    const { services, plan } = enMarcha(new PlanBrain([() => ({ kind: 'finish', summary: 'con el primero basta' })]));
    await services.plans.advance(plan.id, user);

    const despues = services.plans.require(plan.id);
    expect(despues.status).toBe('paused');
    expect(despues.summary).toContain('con el primero basta');
    // Y lo que queda sigue ahí: eso es lo que permite reanudar en vez de reproponer.
    const pasos = services.plans.steps(plan.id);
    expect(pasos.find((step) => step.kind === 'synthesis')).toBeDefined();
    expect(pasos.filter((step) => step.kind === 'estimate' && step.status === 'draft')).toHaveLength(1);
  });

  it('y se reanuda con lo hecho intacto', async () => {
    const { services, plan } = enMarcha(new PlanBrain([
      () => ({ kind: 'finish', summary: 'con el primero basta' }),
      () => ({ kind: 'finish', summary: 'ahora sí, todo mirado' }),
    ]));
    await services.plans.advance(plan.id, user);
    expect(services.plans.require(plan.id).status).toBe('paused');

    services.plans.steer({ planId: plan.id, op: 'resume', reason: 'sigue, que falta uno', user });
    await services.plans.advance(plan.id, user);

    // El segundo cierre ya no deja nada sin dar, así que ahora sí termina.
    expect(services.plans.require(plan.id).status).toBe('completed');
  });

  it('un plan pausado no piensa aunque lo empujen, y al reanudarlo sigue donde estaba', async () => {
    /*
     * Estar pausado significa no avanzar; si no, la pausa es decorativa. El corte del motor tenía
     * `completed`, `failed` y `cancelled`, y como al supervisor le basta con que el plan no esté
     * terminado para empujarlo, ni la pausa de una persona ni la del propio motor paraban nada.
     * Visto en producción: pausado a las 12:04:07 y decidiendo otra vez a las 12:05:50.
     */
    const model = new PlanBrain([
      () => ({ kind: 'finish', summary: 'con el primero basta' }),
      () => ({ kind: 'finish', summary: 'esto no debería llegar a pasar' }),
    ]);
    const { services, plan } = enMarcha(model);

    await services.plans.advance(plan.id, user);
    expect(services.plans.require(plan.id).status).toBe('paused');

    // Se le empuja tres veces, como haría el supervisor: no se le pregunta nada al modelo.
    const antes = model.calls;
    await services.plans.advance(plan.id, user);
    await services.plans.advance(plan.id, user);
    await services.plans.advance(plan.id, user);
    expect(model.calls).toBe(antes);
    expect(services.plans.require(plan.id).status).toBe('paused');
  });

  it('cerrar cuando ya no queda nada por dar termina el plan, como siempre', async () => {
    /*
     * La guarda no puede comerse el final bueno: cuando el `finish` ata el último paso, el plan
     * está completo. Sin esta distinción ningún workflow acabaría nunca en `completed`.
     */
    const { services, plan } = enMarcha(new PlanBrain([
      () => ({ kind: 'run', title: 'Primero', prompt: 'mira el log', permissionProfile: 'safe', rationale: 'hace falta' }),
      () => ({ kind: 'finish', summary: 'ya está todo' }),
    ]));
    await services.plans.advance(plan.id, user);
    terminaElTrabajo(services, plan.id);
    await services.plans.advance(plan.id, user);

    expect(services.plans.require(plan.id).status).toBe('completed');
  });
});

describe('WF · firmar la tarjeta es lo único que pone un workflow en marcha', () => {
  /*
   * El puente entre la conversación y el motor, que no lo probaba nadie.
   *
   * El hilo propone el workflow y crea la tarjeta; el motor sólo arranca si alguien firma. Entre
   * las dos mitades hay un salto —la tarjeta se resuelve en `chat`, el plan vive en `plans`— y las
   * pruebas de cada lado daban verde sin que el salto existiera: `tests/integration/chat.test.ts`
   * firma tarjetas de run, de escalada y de capacidad, nunca de workflow, y este fichero activa
   * los planes llamando a `activate` a mano, que es justo lo que en producción no puede hacer
   * nadie — no hay ruta que active un plan.
   *
   * Así que lo que se comprueba aquí es lo mínimo y lo único que importa: firmar **saca el plan de
   * borrador**. Sin esto, un workflow aprobado se queda quieto para siempre y la firma no se
   * distingue de no haber firmado.
   */
  /*
   * El hilo quiere un modelo híbrido, no uno suelto: `chat` distingue el local del de la nube y sin
   * esa distinción se planta antes de pensar. El resto del fichero no lo necesita porque el motor
   * de planes habla con el modelo directamente.
   */
  const harnessChat = (model: PlanBrain): CoreServices => {
    const services = buildServices({
      db: openDatabase({ path: ':memory:' }),
      index: new FakeSessionIndex([indexRow()]) as never,
      model: new HybridModel({ local: model, cloud: model }),
      config: {
        hosts: ['bastion'], bastionHost: 'bastion', spoolRoot: '/tmp/jarvis-workflow-spool',
        sshCommand: fakeSshPath(), knownHostsFile: '',
      },
    });
    open.push(services);
    return services;
  };

  const propone = (): AssistantDecision => ({
    kind: 'workflow',
    objective: 'averiguar por qué el pool se queda sin conexiones',
    steps: [
      { title: 'Mirar el log', intent: 'ver qué dice el log', expects: 'la hora del primer fallo' },
      { title: 'Comprobar el límite', intent: 'ver el pool_size', expects: 'el número' },
    ],
    hosts: ['bastion'],
    highestPermissionProfile: 'safe',
    rationale: 'con dos pasos se sabe si es el pool o la red',
  });

  it('un workflow firmado desde el hilo deja de ser un borrador', async () => {
    const services = harnessChat(new PlanBrain([
      () => propone(),
      () => ({ kind: 'finish', summary: 'ya está' }),
    ]));
    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'mira por qué se queda sin conexiones', user);
    await services.chat.settled(conversation.id);

    const [tarjeta] = services.chat.pendingApprovals(conversation.id);
    expect(tarjeta?.actionType).toBe('workflow');
    const planId = String((tarjeta!.target as { planId?: string }).planId);
    expect(services.plans.require(planId).status).toBe('draft');

    await services.chat.resolveApproval(tarjeta!.id, 'approved', user);
    await services.chat.settled(conversation.id);

    /*
     * El estado se afirma por su nombre y no con un `not.toBe('draft')`: un plan que acaba en
     * `failed` también deja de ser un borrador, y esa prueba pasaría dando por buena una firma que
     * rompió el plan. Firmar tiene que ponerlo a andar.
     */
    /*
     * El estado se afirma por su nombre y no con un `not.toBe('draft')`: un plan que acaba en
     * `failed` también deja de ser un borrador, y esa prueba pasaría dando por buena una firma que
     * rompió el plan. Firmar tiene que ponerlo a andar.
     */
    expect(['ready', 'running', 'waiting_run', 'waiting_approval', 'completed'])
      .toContain(services.plans.require(planId).status);
  });

  it('y rechazarla lo deja donde estaba', async () => {
    const services = harnessChat(new PlanBrain([() => propone()]));
    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'mira por qué se queda sin conexiones', user);
    await services.chat.settled(conversation.id);

    const [tarjeta] = services.chat.pendingApprovals(conversation.id);
    const planId = String((tarjeta!.target as { planId?: string }).planId);
    await services.chat.resolveApproval(tarjeta!.id, 'rejected', user);

    expect(services.plans.require(planId).status).toBe('draft');
  });
});

describe('WF · el plan escrito no gasta el tope de pasos', () => {
  it('un workflow firmado a su medida cabe en su propio sobre desde el primer paso', async () => {
    /*
     * El caso que el modelo de verdad escribe **siempre** y que aquí no se probaba nunca.
     *
     * En producción `maxSteps` sale igual al número de pasos —seis pasos, `maxSteps: 6`—, así que
     * un workflow nace pegado a su propio tope. Las pruebas de arriba usan un sobre holgado
     * (`maxSteps: 6` para dos pasos) y por eso el borde no se cruza nunca: el sesgo no está en el
     * código, está en que el sobre de la prueba es más generoso que el real.
     *
     * Lo que se firma son los pasos que se van a hacer. Que estén escritos por delante no puede
     * gastarlos: si contase el plan escrito, el primer paso de todo workflow pediría tarjeta y el
     * sobre no autorizaría nada — sería una firma que no sirve para nada.
     */
    const model = new PlanBrain([
      () => ({ kind: 'run', title: 'Primero', prompt: 'mira el log', permissionProfile: 'safe', rationale: 'hace falta' }),
    ]);
    const services = harness(model);
    const { plan } = draftWorkflow(services, sobre({ maxSteps: 2 }));
    const digest = digestOf({ planId: plan.id, objective: plan.objective, envelope: plan.envelope! });
    services.plans.activate(plan.id, user, digest);

    await services.plans.advance(plan.id, user);

    const paso = services.plans.steps(plan.id)[0];
    const motivo = paso?.approvalId ? services.plans.approval(paso.approvalId)?.summary ?? '' : '';
    expect(motivo).not.toContain('Se sale de lo aprobado');
    expect(paso?.kind).toBe('run');
  });

  it('y el tope se cruza cuando el plan ya gastó los pasos que se firmaron', async () => {
    /*
     * La otra mitad: el tope tiene que seguir mordiendo, y morder por los pasos **hechos**.
     *
     * Un paso firmado y dos escritos: el primero cabe, el segundo ya no. Que estuviera escrito no
     * le da derecho a hacerse — lo que autoriza es el tope, no el papel.
     */
    const model = new PlanBrain([
      () => ({ kind: 'run', title: 'Primero', prompt: 'mira el log', permissionProfile: 'safe', rationale: 'hace falta' }),
      () => ({ kind: 'run', title: 'Segundo', prompt: 'mira el otro', permissionProfile: 'safe', rationale: 'y esto' }),
    ]);
    const services = harness(model);
    const { plan } = draftWorkflow(services, sobre({ maxSteps: 1, maxRuns: 9 }));
    const digest = digestOf({ planId: plan.id, objective: plan.objective, envelope: plan.envelope! });
    services.plans.activate(plan.id, user, digest);

    await services.plans.advance(plan.id, user);
    expect(services.plans.steps(plan.id)[0]?.kind).toBe('run');

    terminaElTrabajo(services, plan.id);
    await services.plans.advance(plan.id, user);

    const segundo = services.plans.steps(plan.id)[1];
    expect(segundo?.kind).toBe('approval');
    expect(services.plans.approval(segundo!.approvalId!)?.summary).toContain('el paso 2');
  });
});

describe('WF · atar: el paso estimativo se convierte en el que se hace', () => {
  const enMarcha = (model: PlanBrain, envelope = sobre()) => {
    const services = harness(model);
    const { plan } = draftWorkflow(services, envelope);
    const digest = digestOf({ planId: plan.id, objective: plan.objective, envelope: plan.envelope! });
    services.plans.activate(plan.id, user, digest);
    return { services, plan };
  };

  it('el trabajo ocupa el sitio del paso que lo planificó, no se añade detrás', async () => {
    /*
     * Lo que esto descarta es que el plan firmado y el ejecutado sean dos.
     *
     * Sin atar, un workflow de dos pasos acabaría con los dos estimativos intactos y los pasos
     * reales al final: se leería como cuatro, y lo que se enseñó para firmar no sería lo que
     * corrió. Es la clase de divergencia que no da error nunca.
     */
    const { services, plan } = enMarcha(new PlanBrain([
      () => ({ kind: 'run', title: 'Leer el log', prompt: 'lee el log', permissionProfile: 'safe', rationale: 'hace falta' }),
    ]));
    await services.plans.advance(plan.id, user);

    const steps = services.plans.steps(plan.id);
    // Siguen siendo dos pasos: el primero atado, el segundo todavía por atar.
    expect(steps).toHaveLength(2);
    expect(steps[0]?.kind).toBe('run');
    expect(steps[0]?.ordinal).toBe(0);
    expect(steps[1]?.kind).toBe('estimate');

    // Y lo que el paso prometía sigue ahí dentro: es lo que permite leer después si se cumplió.
    const input = steps[0]?.input as { estimate?: { intent?: string; expects?: string } };
    expect(input.estimate?.intent).toContain('log del pool');
    expect(input.estimate?.expects).toContain('primer fallo');
  });

  it('el modelo ve el plan entero y en qué paso está', async () => {
    const model = new PlanBrain([
      () => ({ kind: 'run', title: 'Uno', prompt: 'mira el log', permissionProfile: 'safe', rationale: 'x' }),
      () => ({ kind: 'finish', summary: 'ya está' }),
    ]);
    const { services, plan } = enMarcha(model);

    await services.plans.advance(plan.id, user);
    // Primer turno: el paso 0 es el actual y el 1 todavía no.
    const primero = model.lastContext?.plannedSteps ?? [];
    expect(primero.map((step) => step.state)).toEqual(['current', 'pending']);
    // Y lo que el borrador declaraba no saber llega al modelo, que es para lo que se escribió.
    expect(primero[0]?.unknowns).toEqual(['si hay rotación']);

    terminaElTrabajo(services, plan.id);
    await services.plans.advance(plan.id, user);
    // Segundo turno: el primero ya está atado, el actual es el otro.
    const segundo = model.lastContext?.plannedSteps ?? [];
    expect(segundo.map((step) => step.state)).toEqual(['current']);
    // El sobre viaja con él: el modelo tiene que saber dentro de qué está decidiendo.
    expect(model.lastContext?.envelope).toMatchObject({ maxRuns: 3, writes: false });
  });

  it('un plan sin sobre no ve nada de esto', async () => {
    const model = new PlanBrain([() => ({ kind: 'finish', summary: 'nada' })]);
    const services = harness(model);
    const workspace = services.workspaces.open(
      { ref: { host: 'bastion', provider: 'claude', sessionId: 'sid-1' } }, user,
    ).workspace;
    const plan = services.plans.create({ workspaceId: workspace.id, objective: 'mirar', user });
    await services.plans.advance(plan.id, user);

    // Lo que decide es tener sobre, no ser un plan: los de antes ven exactamente lo que veían.
    expect(model.lastContext?.envelope).toBeUndefined();
    expect(model.lastContext?.plannedSteps).toBeUndefined();
  });
});

describe('WF · gobernar el plan desde fuera', () => {
  it('pausar lo detiene y reanudar lo devuelve a pensar', () => {
    const services = harness(new PlanBrain([]));
    const { plan } = draftWorkflow(services);
    services.plans.activate(plan.id, user);

    expect(services.plans.steer({ planId: plan.id, op: 'pause', reason: 'ahora no', user })).toEqual({ ok: true });
    expect(services.plans.require(plan.id).status).toBe('paused');

    // Pausar dos veces no es un error del sistema, pero se dice.
    expect(services.plans.steer({ planId: plan.id, op: 'pause', reason: 'otra vez', user }))
      .toMatchObject({ ok: false });

    expect(services.plans.steer({ planId: plan.id, op: 'resume', reason: 'seguimos', user })).toEqual({ ok: true });
    expect(services.plans.require(plan.id).status).toBe('ready');
  });

  it('cancelar no deshace lo hecho, y lo cancelado ya no se gobierna', () => {
    const services = harness(new PlanBrain([]));
    const { plan } = draftWorkflow(services);
    services.plans.activate(plan.id, user);
    services.plans.steer({ planId: plan.id, op: 'cancel', reason: 'ya no hace falta', user });

    expect(services.plans.require(plan.id).status).toBe('cancelled');
    expect(services.plans.steer({ planId: plan.id, op: 'resume', reason: 'me arrepentí', user }))
      .toMatchObject({ ok: false, message: expect.stringContaining('ya terminó') });
  });
});

describe('WF · un workflow de la casa, sin sesión detrás', () => {
  /*
   * Desde la v18 un plan puede no tener workspace: «compara el disco de las tres máquinas» no
   * pertenece a ninguna sesión de agente. Lo que gana es poder existir; lo que no gana es poder
   * lanzar trabajo, porque un run necesita un workspace donde vivir.
   */
  const deLaCasa = (services: CoreServices) => {
    const plan = services.plans.createWorkflow({
      workspaceId: null,
      objective: 'comparar el disco de las tres máquinas',
      envelope: sobre({ capabilities: ['zeus.disk_usage'] }),
      autonomy: 'auto',
      steps: [{ title: 'Mirar el disco', intent: 'ver cuánto queda en cada máquina', expects: 'tres cifras' }],
      user,
    });
    services.plans.activate(plan.id, user);
    return plan;
  };

  it('se puede proponer y firmar sin ninguna sesión', () => {
    const services = harness(new PlanBrain([]));
    const plan = deLaCasa(services);

    expect(services.plans.require(plan.id).workspaceId).toBeNull();
    expect(services.plans.require(plan.id).status).toBe('ready');
  });

  it('el contexto dice que no hay sesión, en vez de inventarse una vacía', async () => {
    const model = new PlanBrain([() => ({ kind: 'finish', summary: 'los tres discos van bien' })]);
    const services = harness(model);
    const plan = deLaCasa(services);
    await services.plans.advance(plan.id, user);

    /*
     * Un workspace con todos los campos en nulo se lee como «hay una sesión y no sé nada de
     * ella», y entonces el modelo habla de una sesión que no existe. Ausente es más honesto.
     */
    expect(model.lastContext?.workspace).toBeUndefined();
  });

  it('y si pide lanzar trabajo, se le dice por qué no puede', async () => {
    const model = new PlanBrain([
      () => ({ kind: 'run', title: 'Mirar', prompt: 'df -h', permissionProfile: 'safe', rationale: 'hace falta' }),
    ]);
    const services = harness(model);
    const plan = deLaCasa(services);
    await services.plans.advance(plan.id, user);

    // Se corta al pedirlo y no al crear el plan: un workflow de la casa es legítimo mientras se
    // limite a mirar, y lo que no puede es acabar lanzando un trabajo.
    const final = services.plans.require(plan.id);
    expect(final.status).toBe('failed');
    expect(final.summary).toContain('no está atado a ninguna sesión');
  });
});

describe('WF · corregir el plan sin volver a firmarlo', () => {
  /*
   * Lo que hace legítima una revisión sin firma nueva es que el perímetro no cambie: se firmó el
   * sobre precisamente porque los pasos iban a cambiar. Lo que no puede hacer una corrección es
   * ensanchar ese perímetro, porque entonces deja de corregir un plan y pasa a proponer otro.
   */
  const enMarcha = (envelope = sobre()) => {
    const services = harness(new PlanBrain([]));
    const { plan } = draftWorkflow(services, envelope);
    services.plans.activate(plan.id, user);
    return { services, plan };
  };

  it('reescribir un paso que no ha empezado se aplica sin preguntar', () => {
    const { services, plan } = enMarcha();
    const resultado = services.plans.revise({
      planId: plan.id,
      reason: 'el log está rotado, hay que mirar el del día',
      changes: [{ op: 'replace', ordinal: 0, title: 'Mirar el log del día', intent: 'ver el log de hoy' }],
      user,
    });

    expect(resultado).toEqual({ ok: true });
    const pasos = services.plans.steps(plan.id);
    expect(pasos[0]?.title).toBe('Mirar el log del día');
    expect((pasos[0]?.input as { intent: string }).intent).toBe('ver el log de hoy');
    // Y el resto sigue ahí: corregir uno no reescribe el plan entero.
    expect(pasos).toHaveLength(2);
  });

  it('añadir un paso por delante cabe, si el sobre da para él', () => {
    const { services, plan } = enMarcha(sobre({ maxSteps: 6 }));
    expect(services.plans.revise({
      planId: plan.id,
      reason: 'antes hay que saber si hay rotación',
      changes: [{ op: 'insert_after', ordinal: 0, title: 'Ver logrotate', intent: 'saber si rota', expects: 'sí o no' }],
      user,
    })).toEqual({ ok: true });
    expect(services.plans.steps(plan.id)).toHaveLength(3);
  });

  it('una revisión que deja más pasos de los firmados no se aplica, y dice cuántos', () => {
    const { services, plan } = enMarcha(sobre({ maxSteps: 2 }));
    const resultado = services.plans.revise({
      planId: plan.id,
      reason: 'hacen falta más pasos',
      changes: [{ op: 'insert_after', ordinal: 0, title: 'Uno más', intent: 'algo', expects: 'algo' }],
      user,
    });

    // Ensanchar el perímetro no es corregir: eso lo firma una persona.
    expect(resultado).toMatchObject({ ok: false });
    expect((resultado as { message: string }).message).toContain('autorizaste fueron 2');
    // Y el plan se queda como estaba: una revisión rechazada no deja el plan a medias.
    expect(services.plans.steps(plan.id)).toHaveLength(2);
  });

  it('y una que mete un paso que escribe donde se firmó sólo mirar, tampoco', () => {
    const { services, plan } = enMarcha(sobre({ writes: false }));
    const resultado = services.plans.revise({
      planId: plan.id,
      reason: 'hay que borrar los logs viejos',
      changes: [{ op: 'replace', ordinal: 0, title: 'Borrar', intent: 'borrar logs', writes: true }],
      user,
    });

    expect(resultado).toMatchObject({ ok: false });
    expect((resultado as { message: string }).message).toContain('sólo mirar');
  });

  it('no se reescribe lo ya hecho: la historia de un plan no se corrige', async () => {
    const model = new PlanBrain([
      () => ({ kind: 'run', title: 'Primero', prompt: 'mira', permissionProfile: 'safe', rationale: 'x' }),
    ]);
    const services = harness(model);
    const { plan } = draftWorkflow(services, sobre());
    services.plans.activate(plan.id, user);
    await services.plans.advance(plan.id, user);

    // El paso 0 ya está atado y corriendo: tocarlo sería reescribir lo que pasó.
    const resultado = services.plans.revise({
      planId: plan.id, reason: 'mejor de otra forma',
      changes: [{ op: 'replace', ordinal: 0, title: 'Otra cosa', intent: 'otra' }], user,
    });
    expect(resultado).toMatchObject({ ok: false });
    expect((resultado as { message: string }).message).toMatch(/ya se hicieron|no hay ningún paso pendiente/);
  });

  it('una revisión sin cambios no es una revisión', () => {
    const { services, plan } = enMarcha();
    expect(services.plans.revise({ planId: plan.id, reason: 'porque sí', changes: [], user }))
      .toMatchObject({ ok: false });
  });
});

describe('WF · qué invalida la firma y qué no', () => {
  /*
   * El digest es lo que impide que se firme una cosa y se ejecute otra, así que lo que importa no
   * es que exista sino **de qué depende**. Cubre el sobre entero: subir un tope o añadir una
   * máquina lo invalida. Lo que no cubre son los pasos, y es a propósito — se firmó el perímetro
   * precisamente porque los pasos iban a cambiar.
   */
  const conSobre = (envelope: WorkflowEnvelope) =>
    digestOf({ planId: 'pl-fijo', objective: 'el mismo objetivo', envelope });

  it('subir un tope invalida la firma', () => {
    expect(conSobre(sobre({ maxRuns: 2 }))).not.toBe(conSobre(sobre({ maxRuns: 20 })));
    expect(conSobre(sobre({ maxSteps: 6 }))).not.toBe(conSobre(sobre({ maxSteps: 60 })));
  });

  it('añadir una máquina o subir el permiso, también', () => {
    expect(conSobre(sobre({ hosts: ['bastion'] }))).not.toBe(conSobre(sobre({ hosts: ['bastion', 'serverC'] })));
    expect(conSobre(sobre({ highestPermissionProfile: 'safe' })))
      .not.toBe(conSobre(sobre({ highestPermissionProfile: 'auto' })));
    expect(conSobre(sobre({ writes: false }))).not.toBe(conSobre(sobre({ writes: true })));
  });

  it('pasar de sólo mirar a poder usar una capacidad, también', () => {
    expect(conSobre(sobre({ capabilities: [] })))
      .not.toBe(conSobre(sobre({ capabilities: ['zeus.disk_usage'] })));
  });

  it('pero el orden en que estén escritos los campos no cambia nada', () => {
    // Si el digest dependiera del orden de las claves, una revisión inocente invalidaría la firma
    // y el asistente pediría permiso otra vez sin que nada hubiera cambiado.
    const uno = { hosts: ['bastion'], maxSteps: 6, maxRuns: 3, highestPermissionProfile: 'safe' as const, writes: false, capabilities: [] };
    const otro = { capabilities: [], writes: false, highestPermissionProfile: 'safe' as const, maxRuns: 3, maxSteps: 6, hosts: ['bastion'] };
    expect(conSobre(uno)).toBe(conSobre(otro));
  });
});

describe('WF · lo que el hilo puede contar de un workflow', () => {
  it('describe da lo justo para contarlo, y nada de un plan que no existe', () => {
    const services = harness(new PlanBrain([]));
    const { plan } = draftWorkflow(services);

    expect(services.plans.describe(plan.id))
      .toMatchObject({ objective: expect.stringContaining('pool'), steps: 2, status: 'draft' });
    // Un id que no es de nadie no inventa un plan vacío: dice que no hay.
    expect(services.plans.describe('pl-que-no-existe')).toBeNull();
  });
});

describe('WF · un workflow sobrevive a que se apague el core', () => {
  it('el plan, su sobre y los pasos sin atar siguen ahí, y continúa donde estaba', async () => {
    /*
     * Un workflow dura más que un turno: entre que se firma y termina puede haber un despliegue.
     * Lo que tiene que sobrevivir no es sólo el plan, es **qué se firmó** —sin el sobre, al
     * arrancar de nuevo no habría con qué comprobar nada— y **por dónde iba**.
     *
     * Se cierra el servicio y se abre otro sobre la misma base, que es lo que ocurre en un
     * reinicio. Con `:memory:` no se puede: la base se va con el proceso.
     */
    const dbPath = join(mkdtempSync(join(tmpdir(), 'jarvis-wf-')), 'core.db');
    const antes = harness(new PlanBrain([
      () => ({ kind: 'run', title: 'Primero', prompt: 'mira el log', permissionProfile: 'safe', rationale: 'x' }),
    ]), dbPath);

    const workspace = antes.workspaces.open(
      { ref: { host: 'bastion', provider: 'claude', sessionId: 'sid-1' } }, user,
    ).workspace;
    const plan = antes.plans.createWorkflow({
      workspaceId: workspace.id,
      objective: 'averiguar por qué se llena el disco',
      envelope: sobre({ maxRuns: 2 }),
      autonomy: 'auto',
      steps: [
        { title: 'Mirar el log', intent: 'ver qué crece', expects: 'el fichero culpable', unknowns: ['si rota'] },
        { title: 'Comprobar rotación', intent: 'ver logrotate', expects: 'la política' },
      ],
      user,
    });
    antes.plans.activate(plan.id, user);
    await antes.plans.advance(plan.id, user);
    antes.close();

    // Y aquí se apagó el core.
    const despues = harness(new PlanBrain([
      () => ({ kind: 'finish', summary: 'era el journal' }),
    ]), dbPath);

    const recuperado = despues.plans.require(plan.id);
    // El sobre sobrevive: sin él, al continuar no habría con qué comprobar si algo se sale.
    expect(recuperado.envelope).toMatchObject({ maxRuns: 2, writes: false });
    expect(recuperado.autonomy).toBe('auto');

    const pasos = despues.plans.steps(plan.id);
    // El primero quedó atado antes del apagón; el segundo sigue esperando a que lo aten.
    expect(pasos[0]?.kind).toBe('run');
    expect(pasos[1]?.kind).toBe('estimate');
    expect(pasos[1]?.status).toBe('draft');
    // Y lo que el paso atado prometía sigue dentro, que es lo que permite leer si se cumplió.
    expect((pasos[0]?.input as { estimate?: { intent?: string } }).estimate?.intent).toContain('qué crece');

    despues.close();
  });

  it('un borrador no avanza aunque alguien lo empuje: nadie lo ha firmado', async () => {
    /*
     * Visto en producción: un workflow recién propuesto aparecía en `running` **sin que nadie
     * hubiera firmado la tarjeta**. `#advanceOnce` sólo se paraba en `completed|failed|cancelled`,
     * y `draft` no estaba en esa lista, así que el supervisor lo empujaba como a cualquier otro:
     * `#proposeNext` lo ponía en `running` y le pedía una decisión al modelo.
     *
     * Con autonomía `manual` el daño se queda en gastar modelo por un plan que nadie autorizó.
     * Con `auto` sería peor: el sobre existe, así que las comprobaciones pasarían, y un plan que
     * nadie firmó lanzaría trabajo dentro de un perímetro que nadie firmó tampoco.
     *
     * `draft` significa **propuesto y sin aprobar**; que el motor lo trate como pendiente de
     * pensar vacía de sentido la firma entera.
     */
    const model = new PlanBrain([() => ({ kind: 'finish', summary: 'no debería llegar aquí' })]);
    const services = harness(model);
    const { plan } = draftWorkflow(services, sobre());

    await services.plans.advance(plan.id, user);

    // Ni se le pregunta al modelo, ni cambia de estado, ni se ata ningún paso.
    expect(model.calls).toBe(0);
    expect(services.plans.require(plan.id).status).toBe('draft');
    expect(services.plans.steps(plan.id).every((step) => step.kind === 'estimate')).toBe(true);
  });

  it('y un borrador sin firmar sigue sin correr después del reinicio', () => {
    /*
     * Lo contrario también tiene que aguantar: un plan propuesto y no aprobado no puede
     * aprovechar un reinicio para colarse. `draft` no es «le toca pensar».
     */
    const dbPath = join(mkdtempSync(join(tmpdir(), 'jarvis-wf-')), 'core.db');
    const antes = harness(new PlanBrain([]), dbPath);
    const { plan } = draftWorkflow(antes, sobre());
    antes.close();

    const despues = harness(new PlanBrain([]), dbPath);
    expect(despues.plans.require(plan.id).status).toBe('draft');
    despues.close();
  });
});
