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
import { afterEach, describe, expect, it } from 'vitest';
import { FakeSessionIndex, fakeSshPath, indexRow } from '@jarvis/testkit';
import type { AutonomyMode, PermissionProfile, WorkflowEnvelope } from '@jarvis/contracts';
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

function harness(model: PlanBrain): CoreServices {
  const services = buildServices({
    db: openDatabase({ path: ':memory:' }),
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
