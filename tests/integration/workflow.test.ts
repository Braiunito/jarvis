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

    const paso = services.plans.steps(plan.id).at(-1);
    expect(paso?.kind).toBe('run');
    expect(paso?.approvalId).toBeNull();
  });

  it('pedir más permiso del firmado no falla: pregunta, y dice qué se autorizó', async () => {
    const { services, plan } = enMarcha(new PlanBrain([() => unRun('auto')]));
    await services.plans.advance(plan.id, user);

    const paso = services.plans.steps(plan.id).at(-1);
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
    expect(services.plans.steps(plan.id).at(-1)?.kind).toBe('run');

    // Segundo paso: el sobre ya no da para otro trabajo.
    await services.plans.advance(plan.id, user);
    const segundo = services.plans.steps(plan.id).at(-1);
    expect(segundo?.kind).toBe('approval');
    expect(services.plans.approval(segundo!.approvalId!)?.summary).toContain('el trabajo 2');
  });
});
