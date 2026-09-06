/**
 * Un turno pedido no se pierde en un reinicio, y uno a medio escribir no se repite.
 *
 * Son las dos mitades de la misma promesa y tiran en direcciones contrarias. La primera pide
 * rehacer; la segunda pide no tocar. Lo que las concilia es la marca de agua: se rehace sólo lo
 * que **no llegó a escribir nada**, porque un turno escribe según ocurre y el memo que impide
 * repetir consultas vive en el toolbox, que nace vacío en cada intento.
 *
 * El proceso no se mata de verdad: se monta el estado que deja un proceso muerto —trabajo cogido,
 * conversación pensando— y se llama a `reconcile()`. Matar un proceso de verdad haría la prueba
 * lenta y no probaría nada más.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { FakeSessionIndex, fakeSshPath, indexRow } from '@jarvis/testkit';
import { openDatabase } from '../../apps/core/src/platform/db.js';
import { JobRepository } from '../../apps/core/src/platform/jobs.js';
import { JobSupervisor } from '../../apps/core/src/platform/job-supervisor.js';
import { buildServices, type CoreServices } from '../../apps/core/src/services.js';
import { HybridModel } from '../../apps/core/src/assistant/hybrid.js';
import type {
  AssistantDecision, AssistantModel, AssistantToolbox, PlanContext,
} from '../../apps/core/src/assistant/types.js';

const user = { userId: 'u1', username: 'braian' };

/** Un modelo que hace lo que se le diga por turno, y cuenta cuántas veces le preguntan. */
class ScriptedBrain implements AssistantModel {
  readonly id = 'local';
  calls = 0;
  #script: Array<(toolbox: AssistantToolbox) => Promise<AssistantDecision> | AssistantDecision>;

  constructor(script: Array<(toolbox: AssistantToolbox) => Promise<AssistantDecision> | AssistantDecision>) {
    this.#script = script;
  }

  async decide(_context: PlanContext, toolbox: AssistantToolbox): Promise<AssistantDecision> {
    const step = this.#script[this.calls] ?? (() => ({ kind: 'finish' as const, summary: 'nada que añadir' }));
    this.calls += 1;
    return step(toolbox);
  }
}

let open: CoreServices[] = [];
afterEach(() => {
  for (const services of open) services.close();
  open = [];
});

/** Un core con cola. La base va aparte para poder hablarle directamente. */
function harness(local: ScriptedBrain): { services: CoreServices; jobs: JobRepository; db: ReturnType<typeof openDatabase> } {
  const db = openDatabase({ path: ':memory:' });
  const services = buildServices({
    db,
    index: new FakeSessionIndex([indexRow()]) as never,
    model: new HybridModel({ local, cloud: null }),
    config: {
      hosts: ['bastion'], bastionHost: 'bastion', spoolRoot: '/tmp/jarvis-durable-spool',
      sshCommand: fakeSshPath(), knownHostsFile: '',
    },
  });
  open.push(services);
  return { services, jobs: new JobRepository(db), db };
}

/**
 * El estado que deja un proceso que murió a mitad de un turno.
 *
 * El trabajo cogido y la conversación pensando: exactamente lo que se encuentra `reconcile()` al
 * arrancar, sin haber tenido que matar nada.
 */
const comoSiHubieraMuerto = (jobs: JobRepository, db: ReturnType<typeof openDatabase>, id: string): void => {
  jobs.claim('chat.turn', '2030-01-01T00:00:00.000Z');
  db.prepare("UPDATE conversations SET status = 'thinking' WHERE id = ?").run(id);
};

describe('DURABLE · lo que se pidió queda escrito antes de pensarlo', () => {
  it('enviar deja un trabajo encolado con el punto del hilo', async () => {
    const local = new ScriptedBrain([() => ({ kind: 'finish', summary: 'listo' })]);
    const { services, jobs } = harness(local);
    const conversation = services.chat.create({ user });
    const message = services.chat.send(conversation.id, 'hola', user);

    // Antes de que el turno haya terminado, la intención ya está en la base.
    const job = jobs.find(jobs.alive('conversation', conversation.id)?.id ?? '');
    expect(job?.kind).toBe('chat.turn');
    expect(job?.watermarkSeq).toBe(message.seq);

    await services.chat.settled(conversation.id);
    // Y al acabar el turno queda cerrado, no pendiente para siempre.
    expect(jobs.alive('conversation', conversation.id)).toBeNull();
  });

  it('pulsar enviar dos veces no deja dos trabajos', async () => {
    const local = new ScriptedBrain([() => ({ kind: 'finish', summary: 'uno' })]);
    const { services, jobs } = harness(local);
    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'hola', user);
    services.chat.send(conversation.id, 'hola otra vez', user);

    expect(jobs.counts().ready + jobs.counts().running).toBe(1);
    await services.chat.settled(conversation.id);
  });
});

describe('DURABLE · qué se rehace al arrancar y qué no', () => {
  it('un turno que no llegó a escribir nada se rehace', async () => {
    const local = new ScriptedBrain([() => ({ kind: 'finish', summary: 'contestado al fin' })]);
    const { services, jobs, db } = harness(local);
    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, '¿cómo va la memoria?', user);
    await services.chat.settled(conversation.id);

    // Se rehace el escenario: el trabajo vuelve a estar cogido y la conversación pensando, con el
    // hilo tal como estaba cuando se encoló —sólo el mensaje de la persona—.
    const job = jobs.enqueue({
      kind: 'chat.turn', resourceType: 'conversation', resourceId: conversation.id,
      watermarkSeq: services.chat.messages(conversation.id).at(-1)?.seq ?? 0,
      at: '2030-01-01T00:00:00.000Z',
    });
    comoSiHubieraMuerto(jobs, db, conversation.id);

    services.chat.reconcile();

    // Vuelve a la cola, y sin contarle a nadie que se perdió: no se ha perdido.
    expect(jobs.require(job.id).status).toBe('ready');
    const eventos = services.chat.messages(conversation.id).filter((m) => m.role === 'event');
    expect(eventos.map((e) => e.text).join(' ')).not.toContain('se perdió');
  });

  it('un turno que ya dejó una traza de herramienta NO se rehace', async () => {
    /*
     * El caso que importa, y el que se ve mal si sólo se prueba con respuestas.
     *
     * Una fila `tool` sube el `seq` igual que un mensaje del asistente, y es lo **primero** que
     * escribe un turno: consultar tres herramientas y caerse es precisamente lo que no hay que
     * repetir. Si la marca de agua sólo mirara los mensajes de respuesta, este turno se daría por
     * no escrito y se rehacía.
     */
    const local = new ScriptedBrain([
      async (toolbox) => {
        await toolbox.invoke('get_health', {});
        return { kind: 'finish', summary: 'la casa va bien' };
      },
    ]);
    const { services, jobs, db } = harness(local);
    const conversation = services.chat.create({ user });
    const message = services.chat.send(conversation.id, '¿cómo está la casa?', user);
    await services.chat.settled(conversation.id);

    // La consulta quedó escrita: hay traza en el hilo.
    expect(services.chat.messages(conversation.id).some((m) => m.role === 'tool')).toBe(true);

    // El trabajo se encoló **antes** de esa traza, así que su marca de agua se quedó atrás.
    const job = jobs.enqueue({
      kind: 'chat.turn', resourceType: 'conversation', resourceId: conversation.id,
      watermarkSeq: message.seq, at: '2030-01-01T00:00:00.000Z',
    });
    comoSiHubieraMuerto(jobs, db, conversation.id);

    services.chat.reconcile();

    // No vuelve a la cola: rehacerlo repetiría la consulta y duplicaría el hilo.
    expect(jobs.require(job.id).status).toBe('failed');
    expect(jobs.require(job.id).lastError).toContain('duplicar');
    // Y a la persona se le cuenta lo que pasó, como se hacía antes de que existiera la cola.
    const eventos = services.chat.messages(conversation.id).filter((m) => m.role === 'event');
    expect(eventos.map((e) => e.text).join(' ')).toContain('se perdió');
  });

  it('sin cola, reconcile hace lo de siempre', async () => {
    const local = new ScriptedBrain([() => ({ kind: 'finish', summary: 'ya' })]);
    const { services, db } = harness(local);
    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'hola', user);
    await services.chat.settled(conversation.id);
    db.prepare("UPDATE conversations SET status = 'thinking' WHERE id = ?").run(conversation.id);

    // La cola es opcional y su ausencia no puede cambiar lo que ya funcionaba: sin trabajo vivo,
    // una conversación colgada se cierra diciéndolo.
    expect(services.chat.reconcile()).toBe(1);
    expect(services.chat.messages(conversation.id).at(-1)?.text).toContain('se perdió');
  });
});

describe('DURABLE · el supervisor termina lo que quedó a medias', () => {
  it('coge el trabajo recuperado y el turno acaba contestando', async () => {
    const local = new ScriptedBrain([
      () => ({ kind: 'finish', summary: 'primera respuesta' }),
      () => ({ kind: 'finish', summary: 'la que faltaba' }),
    ]);
    const { services, jobs, db } = harness(local);
    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'una pregunta', user);
    await services.chat.settled(conversation.id);

    jobs.enqueue({
      kind: 'chat.turn', resourceType: 'conversation', resourceId: conversation.id,
      watermarkSeq: services.chat.messages(conversation.id).at(-1)?.seq ?? 0,
      at: '2030-01-01T00:00:00.000Z',
    });
    comoSiHubieraMuerto(jobs, db, conversation.id);
    services.chat.reconcile();

    const supervisor = new JobSupervisor({
      jobs,
      clock: { nowIso: () => '2030-01-01T00:01:00.000Z', nowMs: () => Date.parse('2030-01-01T00:01:00.000Z') },
      handlers: { 'chat.turn': (job) => services.chat.resume(job.resourceId) },
    });

    expect(await supervisor.tick()).toBe(1);
    await services.chat.settled(conversation.id);

    // El turno se hizo, con su respuesta en el hilo, y el trabajo quedó cerrado.
    expect(services.chat.messages(conversation.id).at(-1)?.text).toContain('la que faltaba');
    expect(jobs.alive('conversation', conversation.id)).toBeNull();
    expect(jobs.counts().done).toBeGreaterThanOrEqual(1);
  });

  it('lo que falla vuelve a la cola con espera, y no se pierde', async () => {
    const { services, jobs } = harness(new ScriptedBrain([]));
    const conversation = services.chat.create({ user });
    const job = jobs.enqueue({
      kind: 'chat.turn', resourceType: 'conversation', resourceId: conversation.id,
      watermarkSeq: 0, at: '2030-01-01T00:00:00.000Z',
    });

    const supervisor = new JobSupervisor({
      jobs,
      clock: { nowIso: () => '2030-01-01T00:00:00.000Z', nowMs: () => Date.parse('2030-01-01T00:00:00.000Z') },
      handlers: { 'chat.turn': () => Promise.reject(new Error('el modelo no responde')) },
    });
    await supervisor.tick();

    const despues = jobs.require(job.id);
    expect(despues.status).toBe('ready');
    expect(despues.lastError).toContain('no responde');
    // Con espera: reintentar en bucle cerrado es peor que esperar dos segundos.
    expect(Date.parse(despues.availableAt)).toBeGreaterThan(Date.parse('2030-01-01T00:00:00.000Z'));
  });
});

describe('DURABLE · la salud cuenta lo que quedó sin contestar', () => {
  it('un turno que agotó sus intentos sale como avería, no como cola', async () => {
    const { services, jobs } = harness(new ScriptedBrain([]));
    const conversation = services.chat.create({ user });
    const job = jobs.enqueue({
      kind: 'chat.turn', resourceType: 'conversation', resourceId: conversation.id,
      watermarkSeq: 0, at: '2030-01-01T00:00:00.000Z',
    });

    // Con el trabajo pendiente, la casa está ocupada pero sana: tener cola no es tener un
    // problema, y avisar de esto enseñaría a ignorar el aviso.
    const ocupada = await services.health.snapshot({ probeHosts: false });
    expect(ocupada.checks['chatJobs']?.status).toBe('ok');

    jobs.abandon(job.id, 'nadie pudo con él', '2030-01-01T00:00:00.000Z');

    /*
     * Un turno rendido es una pregunta que alguien hizo y nadie contestó. Sin esto no se enteraría
     * nadie: la conversación se queda en `idle` con el mensaje de la persona como último, que
     * desde fuera se ve igual que una conversación que terminó bien.
     */
    const rota = await services.health.snapshot({ probeHosts: false });
    expect(rota.checks['chatJobs']?.status).toBe('degraded');
    expect(rota.checks['chatJobs']?.message).toContain('sin contestar');
  });
});

describe('DURABLE · el trabajo que ya se está haciendo no se hace otra vez', () => {
  it('el supervisor no arranca un segundo turno sobre lo que send() ya está pensando', async () => {
    /*
     * El fallo medido en producción: un mensaje, dos turnos completos, `attempts: 1`.
     *
     * No era un reintento: `send()` encolaba **y** arrancaba el turno, así que el trabajo quedaba
     * `ready` y el supervisor lo reclamaba en su siguiente vuelta. `#turns` no los pisa, los
     * **encadena**, de modo que el segundo turno ve la respuesta del primero y contesta otra vez.
     * Con el esfuerzo de razonamiento alto eso costó siete minutos y el doble de tokens.
     *
     * Un trabajo `ready` tiene que significar «nadie lo está haciendo». Mientras el proceso que lo
     * pidió lo tiene en la mano, está `running`; si ese proceso muere, queda huérfano y es
     * `reconcile()` quien decide, que es justo para lo que existe.
     */
    const local = new ScriptedBrain([
      () => ({ kind: 'finish', summary: 'primera y única respuesta' }),
      () => ({ kind: 'finish', summary: 'ésta no debería existir' }),
    ]);
    const { services, jobs } = harness(local);
    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, '¿qué puedes hacer?', user);

    // El supervisor da su vuelta mientras el turno está en marcha, como pasa de verdad.
    const supervisor = new JobSupervisor({
      jobs,
      clock: { nowIso: () => '2030-01-01T00:00:00.000Z', nowMs: () => Date.parse('2030-01-01T00:00:00.000Z') },
      handlers: { 'chat.turn': (job) => services.chat.resume(job.resourceId) },
    });
    await supervisor.tick();
    await services.chat.settled(conversation.id);

    // Al modelo se le preguntó una vez, no dos.
    expect(local.calls).toBe(1);
    const respuestas = services.chat.messages(conversation.id).filter((m) => m.role === 'assistant');
    expect(respuestas).toHaveLength(1);
    expect(respuestas[0]?.text).toContain('única');
  });
});
