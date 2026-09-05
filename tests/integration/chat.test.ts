/**
 * La conversación con el asistente local, de punta a punta.
 *
 * Lo que se prueba son las cuatro promesas que hace esta feature, y ninguna es «el modelo es
 * listo»:
 *
 *  1. Un turno deja rastro **según ocurre**: la consulta a una herramienta está escrita antes de
 *     que exista la respuesta, que es lo que permite enseñar «mirando la memoria…» y lo que hace
 *     que recargar a mitad no pierda nada.
 *  2. En autonomía `manual` no se lanza trabajo sin firma, aunque el modelo lo pida en perfil
 *     seguro. En `auto` sí, y siguen firmándose las excepciones.
 *  3. **No se sale a la nube sin permiso.** Ni cuando el modelo lo pide, ni cuando el modelo local
 *     se cae. Es la promesa que justifica toda la arquitectura, así que se comprueba contando
 *     llamadas: si el modelo de nube recibe una sola sin aprobación, la feature está rota.
 *  4. Una capacidad con efectos sobre la máquina tampoco, y lo que se ejecuta al firmar es
 *     exactamente lo que decía la tarjeta.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { FakeSessionIndex, fakeSshPath, indexRow } from '@jarvis/testkit';
import { openDatabase } from '../../apps/core/src/platform/db.js';
import { buildServices, type CoreServices } from '../../apps/core/src/services.js';
import { HybridModel } from '../../apps/core/src/assistant/hybrid.js';
import { McpService } from '../../apps/core/src/mcp/service.js';
import { parseMcpServers } from '../../apps/core/src/mcp/config.js';
import { systemClock } from '../../apps/core/src/platform/clock.js';
import type {
  AssistantDecision, AssistantModel, AssistantToolbox, PlanContext,
} from '../../apps/core/src/assistant/types.js';

const user = { userId: 'u1', username: 'braian' };

/**
 * Un modelo guionizado: hace lo que se le diga, en orden, y **cuenta cuántas veces le preguntan**.
 *
 * Ese contador es la mitad del valor de este fichero: la promesa «no se consulta a la nube sin
 * permiso» sólo se puede comprobar mirando que el de la nube no recibió ninguna llamada.
 */
class ScriptedBrain implements AssistantModel {
  readonly id: string;
  calls = 0;
  lastContext: PlanContext | null = null;
  #script: Array<(toolbox: AssistantToolbox) => Promise<AssistantDecision> | AssistantDecision>;

  constructor(id: string, script: Array<(toolbox: AssistantToolbox) => Promise<AssistantDecision> | AssistantDecision>) {
    this.id = id;
    this.#script = script;
  }

  async decide(context: PlanContext, toolbox: AssistantToolbox): Promise<AssistantDecision> {
    this.lastContext = context;
    const step = this.#script[this.calls] ?? (() => ({ kind: 'finish' as const, summary: 'nada que añadir' }));
    this.calls += 1;
    return step(toolbox);
  }
}

/** El MCP de Zeus, en pequeño: dos lecturas y una escritura, con sus tags. */
function fakeMcp({ writable = false }: { writable?: boolean } = {}): { service: McpService; restarts: string[] } {
  const restarts: string[] = [];
  const tools = [
    {
      name: 'memory_pressure', title: 'Memory Pressure', description: 'RAM, swap y si el kernel va apurado.',
      inputSchema: { type: 'object', properties: {} }, _meta: { fastmcp: { tags: ['system', 'safe'] } },
    },
    {
      name: 'zeus_playbook', title: 'Zeus Playbook', description: 'El manual del servidor.',
      inputSchema: { type: 'object', properties: {} }, _meta: { fastmcp: { tags: ['meta', 'safe'] } },
    },
    {
      name: 'docker_restart', title: 'Docker Restart', description: 'Reinicia un contenedor permitido.',
      inputSchema: { type: 'object', properties: { container: { type: 'string' } }, required: ['container'] },
      _meta: { fastmcp: { tags: ['docker', 'write'] } },
    },
    {
      name: 'list_processes', title: 'List Processes', description: 'Lista procesos con PID y consumo.',
      inputSchema: { type: 'object', properties: {} }, _meta: { fastmcp: { tags: ['process', 'safe'] } },
    },
  ];

  const sse = (payload: unknown, headers: Record<string, string> = {}): Response => new Response(
    `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } },
  );

  const service = new McpService({
    servers: parseMcpServers({
      servers: 'zeus=http://zeus.test/mcp',
      ...(writable ? { writeServers: 'zeus' } : {}),
    }),
    clock: systemClock,
    audit: { record: () => undefined } as never,
    fetchImpl: async (_url, init) => {
      const message = JSON.parse(String(init.body)) as { id?: number; method: string; params?: never };
      if (message.method === 'initialize') {
        return sse({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'Zeus falso', version: '1' } } },
          { 'mcp-session-id': 's1' });
      }
      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (message.method === 'tools/list') return sse({ jsonrpc: '2.0', id: message.id, result: { tools } });
      if (message.method === 'tools/call') {
        const params = message.params as unknown as { name: string; arguments: Record<string, unknown> };
        if (params.name === 'docker_restart') restarts.push(String(params.arguments['container']));
        return sse({
          jsonrpc: '2.0', id: message.id,
          result: { content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: true, tool: params.name }, isError: false },
        });
      }
      return sse({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'nope' } });
    },
  });
  return { service, restarts };
}

interface Harness {
  services: CoreServices;
  local: ScriptedBrain;
  cloud: ScriptedBrain;
  restarts: string[];
}

function harness({ local, cloud, writable = false }: {
  local: ScriptedBrain;
  cloud?: ScriptedBrain;
  writable?: boolean;
}): Harness {
  const nube = cloud ?? new ScriptedBrain('nube', []);
  const mcp = fakeMcp({ writable });
  const services = buildServices({
    db: openDatabase({ path: ':memory:' }),
    index: new FakeSessionIndex([indexRow()]) as never,
    model: new HybridModel({ local, cloud: nube }),
    mcp: mcp.service,
    config: {
      hosts: ['bastion'], bastionHost: 'bastion', spoolRoot: '/tmp/jarvis-chat-spool',
      // Sin esto no se puede lanzar trabajo de verdad, y la mitad de lo que se prueba aquí es
      // justo cuándo se lanza y cuándo no.
      sshCommand: fakeSshPath(), knownHostsFile: '',
    },
  });
  return { services, local, cloud: nube, restarts: mcp.restarts };
}

/**
 * Espera al turno.
 *
 * Se le pregunta al servicio en vez de sondear el estado: entre `send()` y el primer `await` del
 * turno el hilo todavía pone «idle», así que un sondeo optimista da por terminado lo que no ha
 * empezado. Es exactamente el fallo que tuvo este fichero antes de existir `chat.settled()`.
 */
const settled = (services: CoreServices, id: string): Promise<void> => services.chat.settled(id);

let open: CoreServices[] = [];
afterEach(() => {
  for (const services of open) services.close();
  open = [];
});

function track(harnessed: Harness): Harness {
  open.push(harnessed.services);
  return harnessed;
}

describe('CHAT · un turno deja rastro según ocurre', () => {
  it('la consulta a una capacidad se escribe antes que la respuesta', async () => {
    const local = new ScriptedBrain('local', [
      async (toolbox) => {
        await toolbox.invoke('use_capability', { name: 'memory_pressure', args: {} });
        return { kind: 'finish', summary: 'La RAM va holgada: 10 GiB libres y sin swap.' };
      },
    ]);
    const { services } = track(harness({ local }));

    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, '¿cómo va la memoria de zeus?', user);
    await settled(services, conversation.id);

    const messages = services.chat.messages(conversation.id);
    expect(messages.map((message) => message.role)).toEqual(['user', 'tool', 'assistant']);
    // La herramienta quedó escrita con su nombre y su resultado, no dentro de la respuesta.
    expect(messages[1]?.toolName).toBe('zeus.memory_pressure');
    expect(messages[1]?.toolOk).toBe(true);
    expect(messages[2]?.text).toContain('10 GiB');
    // Y `seq` es correlativo: es lo que hace que reconectar el stream no repita ni salte nada.
    expect(messages.map((message) => message.seq)).toEqual([0, 1, 2]);
  });

  it('sin sesión de trabajo no se ofrecen las herramientas que hablan de una sesión', async () => {
    let offered: string[] = [];
    const local = new ScriptedBrain('local', [
      (toolbox) => {
        offered = toolbox.definitions().map((tool) => tool.name);
        return { kind: 'finish', summary: 'listo' };
      },
    ]);
    const { services } = track(harness({ local }));
    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'hola', user);
    await settled(services, conversation.id);

    // Un catálogo que promete «los trabajos de esta sesión» sin sesión es un catálogo que miente.
    expect(offered).not.toContain('get_session_context');
    expect(offered).not.toContain('create_run');
    // Lo que sí tiene sentido sin sesión sigue estando.
    expect(offered).toContain('use_capability');
    expect(offered).toContain('search_sessions');
    expect(offered).toContain('get_health');
  });

  it('el primer mensaje nombra la conversación', async () => {
    const { services } = track(harness({ local: new ScriptedBrain('local', [() => ({ kind: 'finish', summary: 'ya' })]) }));
    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'mira los contenedores parados', user);
    await settled(services, conversation.id);

    expect(services.chat.require(conversation.id).title).toBe('mira los contenedores parados');
  });
});

describe('CHAT · la puerta a la nube', () => {
  it('el modelo pide escalar y NADIE llama a la nube hasta que se firma', async () => {
    const local = new ScriptedBrain('local', [
      () => ({ kind: 'escalate', reason: 'hay que razonar sobre cuatro repos a la vez' }),
    ]);
    const cloud = new ScriptedBrain('nube', [() => ({ kind: 'finish', summary: 'lo miro yo: son cuatro repos y…' })]);
    const { services } = track(harness({ local, cloud }));

    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'compara los cuatro despliegues', user);
    await settled(services, conversation.id);

    // La promesa central de esta arquitectura, comprobada contando: cero llamadas a la nube.
    expect(cloud.calls).toBe(0);
    expect(services.chat.require(conversation.id).status).toBe('waiting_approval');
    const [approval] = services.chat.pendingApprovals(conversation.id);
    expect(approval?.actionType).toBe('escalate');
    expect(approval?.summary).toContain('cuatro repos');

    // Y al firmar, se consulta: una vez, y con el hilo marcado como pensado fuera.
    await services.chat.resolveApproval(approval!.id, 'approved', user);
    await settled(services, conversation.id);
    expect(cloud.calls).toBe(1);
    expect(cloud.lastContext?.source).toBe('cloud');

    const messages = services.chat.messages(conversation.id);
    const answer = messages.at(-1);
    expect(answer?.source).toBe('cloud');
    expect(answer?.text).toContain('son cuatro repos');
    // Terminado el turno, el hilo vuelve a casa: la autorización era para eso, no una suscripción.
    expect(services.chat.require(conversation.id).source).toBe('local');
  });

  it('rechazar la escalada no consulta a la nube', async () => {
    const local = new ScriptedBrain('local', [() => ({ kind: 'escalate', reason: 'no puedo' })]);
    const cloud = new ScriptedBrain('nube', [() => ({ kind: 'finish', summary: 'no debería llegar aquí' })]);
    const { services } = track(harness({ local, cloud }));

    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'algo difícil', user);
    await settled(services, conversation.id);
    const [approval] = services.chat.pendingApprovals(conversation.id);
    await services.chat.resolveApproval(approval!.id, 'rejected', user);

    expect(cloud.calls).toBe(0);
    expect(services.chat.require(conversation.id).status).toBe('idle');
    expect(services.chat.messages(conversation.id).at(-1)?.text).toContain('No lo autorizaste');
  });

  it('si el modelo local se cae, se ofrece la nube pero tampoco se llama sola', async () => {
    const local = new ScriptedBrain('local', [() => { throw new Error('connect ECONNREFUSED 127.0.0.1:8181'); }]);
    const cloud = new ScriptedBrain('nube', [() => ({ kind: 'finish', summary: 'contesto yo' })]);
    const { services } = track(harness({ local, cloud }));

    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'lo que sea', user);
    await settled(services, conversation.id);

    // Una avería del cerebro de casa no es permiso para gastar en el de fuera.
    expect(cloud.calls).toBe(0);
    const [approval] = services.chat.pendingApprovals(conversation.id);
    expect(approval?.actionType).toBe('escalate');
    expect(approval?.summary).toContain('ECONNREFUSED');
  });

  it('sin modelo de nube no se ofrece la herramienta de escalar', async () => {
    let offered: string[] = [];
    const local = new ScriptedBrain('local', [
      (toolbox) => {
        offered = toolbox.definitions().map((tool) => tool.name);
        return { kind: 'finish', summary: 'ok' };
      },
    ]);
    const mcp = fakeMcp();
    const services = buildServices({
      db: openDatabase({ path: ':memory:' }),
      index: new FakeSessionIndex([indexRow()]) as never,
      model: new HybridModel({ local, cloud: null }),
      mcp: mcp.service,
      config: {
      hosts: ['bastion'], bastionHost: 'bastion', spoolRoot: '/tmp/jarvis-chat-spool',
      // Sin esto no se puede lanzar trabajo de verdad, y la mitad de lo que se prueba aquí es
      // justo cuándo se lanza y cuándo no.
      sshCommand: fakeSshPath(), knownHostsFile: '',
    },
    });
    open.push(services);

    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'hola', user);
    await settled(services, conversation.id);

    expect(offered).not.toContain('escalate');
    expect((await services.chat.capabilities()).cloudAvailable).toBe(false);
  });
});

describe('CHAT · tocar una máquina', () => {
  it('una capacidad con efectos no se ejecuta sin firma, y al firmar hace exactamente lo que decía', async () => {
    const local = new ScriptedBrain('local', [
      (toolbox) => toolbox.invoke('request_capability', {
        name: 'zeus.docker_restart',
        args: { container: 'camwall' },
        summary: 'Reiniciar el contenedor camwall en zeus',
      }).then((outcome) => {
        if (outcome.type !== 'decision') throw new Error('esperaba una decisión');
        return outcome.decision;
      }),
      () => ({ kind: 'finish', summary: 'Reiniciado camwall; el hub tarda unos minutos en recuperar las cámaras.' }),
    ]);
    const { services, restarts } = track(harness({ local, writable: true }));

    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'reinicia camwall', user);
    await settled(services, conversation.id);

    expect(restarts).toEqual([]);
    const [approval] = services.chat.pendingApprovals(conversation.id);
    expect(approval?.actionType).toBe('capability');
    expect(approval?.summary).toBe('Reiniciar el contenedor camwall en zeus');

    await services.chat.resolveApproval(approval!.id, 'approved', user);
    await settled(services, conversation.id);

    // Se ejecutó, una vez, con el argumento que decía la tarjeta.
    expect(restarts).toEqual(['camwall']);
    // Y el modelo cuenta qué salió: ejecutar sin explicar deja a la persona leyendo un volcado.
    expect(services.chat.messages(conversation.id).at(-1)?.text).toContain('Reiniciado camwall');
  });

  it('una capacidad de sólo lectura se ejecuta sin preguntar nada', async () => {
    const local = new ScriptedBrain('local', [
      async (toolbox) => {
        const outcome = await toolbox.invoke('use_capability', { name: 'zeus_playbook', args: {} });
        expect(outcome.type).toBe('observation');
        return { kind: 'finish', summary: 'consultado el manual' };
      },
    ]);
    const { services } = track(harness({ local }));
    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, '¿qué corre en zeus?', user);
    await settled(services, conversation.id);

    expect(services.chat.pendingApprovals(conversation.id)).toHaveLength(0);
    expect(services.chat.require(conversation.id).status).toBe('idle');
  });

  it('pedir permiso para algo que sólo lee se rechaza con la forma correcta de hacerlo', async () => {
    let outcome: unknown;
    const local = new ScriptedBrain('local', [
      async (toolbox) => {
        outcome = await toolbox.invoke('request_capability', {
          name: 'memory_pressure', args: {}, summary: 'mirar la memoria',
        });
        return { kind: 'finish', summary: 'ya' };
      },
    ]);
    const { services } = track(harness({ local }));
    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'memoria', user);
    await settled(services, conversation.id);

    expect(JSON.stringify(outcome)).toContain('use_capability');
    expect(services.chat.pendingApprovals(conversation.id)).toHaveLength(0);
  });

  it('un nombre inventado devuelve las capacidades que se le parecen', async () => {
    let outcome: unknown;
    const local = new ScriptedBrain('local', [
      async (toolbox) => {
        // Es lo que hizo el modelo de verdad al probarlo sin catálogo: inventarse el nombre.
        outcome = await toolbox.invoke('use_capability', { name: 'check_ram_status', args: {} });
        return { kind: 'finish', summary: 'ya' };
      },
    ]);
    const { services } = track(harness({ local }));
    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'la ram', user);
    await settled(services, conversation.id);

    // Un «no existe» seco le hace inventarse otro; darle los parecidos lo pone en la vía.
    expect(JSON.stringify(outcome)).toContain('no te la inventes');
  });

  it('al inventarse un nombre CUALIFICADO, el servidor no contamina las sugerencias', async () => {
    /*
     * En producción se inventó `zeus.processes` y `zeus.network_traffic`, cualificados, porque el
     * catálogo que ve va cualificado. Si se busca la cadena entera, «zeus» es un término más y
     * casa con `zeus_playbook` tan fuerte como «processes» con `list_processes`: las sugerencias
     * saldrían encabezadas por el manual del servidor en vez de por lo que se buscaba.
     */
    let outcome = '';
    const local = new ScriptedBrain('local', [
      async (toolbox) => {
        outcome = JSON.stringify(await toolbox.invoke('use_capability', { name: 'zeus.processes', args: {} }));
        return { kind: 'finish', summary: 'ya' };
      },
    ]);
    const { services } = track(harness({ local }));
    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'qué procesos hay', user);
    await settled(services, conversation.id);

    expect(outcome).toContain('zeus.list_processes');
    expect(outcome).not.toContain('zeus_playbook');
  });
});

describe('CHAT · cuánta cuerda tiene', () => {
  it('en manual, lanzar trabajo en perfil seguro pasa a pedir permiso', async () => {
    const local = new ScriptedBrain('local', [
      (toolbox) => toolbox.invoke('create_run', {
        title: 'Mirar el estado', prompt: 'resume el estado del repo',
        permission_profile: 'safe', rationale: 'hace falta leer antes de tocar',
      }).then((outcome) => {
        if (outcome.type !== 'decision') throw new Error('esperaba una decisión');
        return outcome.decision;
      }),
    ]);
    const { services } = track(harness({ local }));

    const { workspace } = services.workspaces.open(
      { ref: { host: 'bastion', provider: 'claude', sessionId: 'sid-1' } }, user,
    );
    const conversation = services.chat.create({ workspaceId: workspace.id, autonomy: 'manual', user });
    services.chat.send(conversation.id, 'mira el repo', user);
    await settled(services, conversation.id);

    // El modelo pidió un run; en manual sale por la puerta de la aprobación, no por la del efecto.
    const [approval] = services.chat.pendingApprovals(conversation.id);
    expect(approval?.actionType).toBe('run');
    expect(approval?.summary).toContain('permiso «safe»');
    expect(services.runs.listByWorkspace(workspace.id, 10)).toHaveLength(0);
  });

  it('en auto, el mismo paso se lanza sin preguntar', async () => {
    const local = new ScriptedBrain('local', [
      (toolbox) => toolbox.invoke('create_run', {
        title: 'Mirar el estado', prompt: 'resume el estado del repo',
        permission_profile: 'safe', rationale: 'leer antes de tocar',
      }).then((outcome) => {
        if (outcome.type !== 'decision') throw new Error('esperaba una decisión');
        return outcome.decision;
      }),
    ]);
    const { services } = track(harness({ local }));

    const { workspace } = services.workspaces.open(
      { ref: { host: 'bastion', provider: 'claude', sessionId: 'sid-1' } }, user,
    );
    const conversation = services.chat.create({ workspaceId: workspace.id, autonomy: 'auto', user });
    services.chat.send(conversation.id, 'mira el repo', user);
    await settled(services, conversation.id);

    expect(services.chat.pendingApprovals(conversation.id)).toHaveLength(0);
    expect(services.runs.listByWorkspace(workspace.id, 10)).toHaveLength(1);
  });

  it('cambiar la autonomía queda escrito', async () => {
    const { services } = track(harness({ local: new ScriptedBrain('local', []) }));
    const conversation = services.chat.create({ user });
    expect(conversation.autonomy).toBe('manual');
    expect(services.chat.setAutonomy(conversation.id, 'auto', user).autonomy).toBe('auto');
  });
});

describe('CHAT · durabilidad', () => {
  it('dos envíos seguidos no producen dos turnos a la vez', async () => {
    const local = new ScriptedBrain('local', [
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { kind: 'finish', summary: 'primera' };
      },
      () => ({ kind: 'finish', summary: 'segunda' }),
    ]);
    const { services } = track(harness({ local }));
    const conversation = services.chat.create({ user });

    services.chat.send(conversation.id, 'uno', user);
    services.chat.send(conversation.id, 'dos', user);
    await settled(services, conversation.id);
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Dos turnos simultáneos ven el mismo historial y contestan dos veces a lo mismo.
    expect(local.calls).toBe(2);
    const answers = services.chat.messages(conversation.id).filter((message) => message.role === 'assistant');
    expect(answers.map((message) => message.text)).toEqual(['primera', 'segunda']);
  });

  it('una conversación que se quedó pensando se cierra al arrancar', async () => {
    /*
     * Un turno vive en memoria. Si el proceso muere a mitad —un despliegue, un reinicio— la fila
     * se queda en `thinking` y no vuelve sola nunca: la pantalla dice «pensando…» para siempre y
     * quien mira no tiene forma de saber que ya no hay nadie pensando. Pasó en producción.
     */
    const db = openDatabase({ path: ':memory:' });
    const local = new ScriptedBrain('local', [() => ({ kind: 'finish', summary: 'ya' })]);
    const first = buildServices({
      db,
      index: new FakeSessionIndex([indexRow()]) as never,
      model: new HybridModel({ local, cloud: null }),
      mcp: fakeMcp().service,
      config: {
        hosts: ['bastion'], bastionHost: 'bastion', spoolRoot: '/tmp/jarvis-chat-spool',
        sshCommand: fakeSshPath(), knownHostsFile: '',
      },
    });
    const conversation = first.chat.create({ user });
    // Se simula el proceso muerto a mitad de turno: la fila queda pensando y nadie la mueve.
    db.prepare("UPDATE conversations SET status = 'thinking' WHERE id = ?").run(conversation.id);
    first.planSupervisor.stop();
    first.supervisor.stop();
    first.retention.stop();

    const second = buildServices({
      db,
      index: new FakeSessionIndex([indexRow()]) as never,
      model: new HybridModel({ local: new ScriptedBrain('local2', []), cloud: null }),
      mcp: fakeMcp().service,
      config: {
        hosts: ['bastion'], bastionHost: 'bastion', spoolRoot: '/tmp/jarvis-chat-spool',
        sshCommand: fakeSshPath(), knownHostsFile: '',
      },
    });
    open.push(second);

    expect(second.chat.require(conversation.id).status).toBe('idle');
    // Y no se cierra en silencio: se dice qué pasó, porque quien preguntó sigue esperando.
    expect(second.chat.messages(conversation.id).at(-1)?.text).toContain('se reinició');
  });

  it('los mensajes sobreviven a un reinicio del core', async () => {
    const db = openDatabase({ path: ':memory:' });
    const local = new ScriptedBrain('local', [() => ({ kind: 'finish', summary: 'apuntado' })]);
    const first = buildServices({
      db,
      index: new FakeSessionIndex([indexRow()]) as never,
      model: new HybridModel({ local, cloud: null }),
      mcp: fakeMcp().service,
      config: {
      hosts: ['bastion'], bastionHost: 'bastion', spoolRoot: '/tmp/jarvis-chat-spool',
      // Sin esto no se puede lanzar trabajo de verdad, y la mitad de lo que se prueba aquí es
      // justo cuándo se lanza y cuándo no.
      sshCommand: fakeSshPath(), knownHostsFile: '',
    },
    });
    const conversation = first.chat.create({ user });
    first.chat.send(conversation.id, 'recuérdame esto', user);
    await settled(first, conversation.id);
    first.planSupervisor.stop();
    first.supervisor.stop();
    first.retention.stop();

    // Otro proceso, la misma base: lo que se dijo sigue ahí y con su orden.
    const second = buildServices({
      db,
      index: new FakeSessionIndex([indexRow()]) as never,
      model: new HybridModel({ local: new ScriptedBrain('local2', []), cloud: null }),
      mcp: fakeMcp().service,
      config: {
      hosts: ['bastion'], bastionHost: 'bastion', spoolRoot: '/tmp/jarvis-chat-spool',
      // Sin esto no se puede lanzar trabajo de verdad, y la mitad de lo que se prueba aquí es
      // justo cuándo se lanza y cuándo no.
      sshCommand: fakeSshPath(), knownHostsFile: '',
    },
    });
    open.push(second);

    const messages = second.chat.messages(conversation.id);
    expect(messages.map((message) => message.text)).toEqual(['recuérdame esto', 'apuntado']);
    expect(second.chat.require(conversation.id).status).toBe('idle');
  });
});
