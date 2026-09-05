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
  index: FakeSessionIndex;
}

function harness({ local, cloud, writable = false, directCapabilities = false, index }: {
  local: ScriptedBrain;
  cloud?: ScriptedBrain;
  writable?: boolean;
  /**
   * El índice de sesiones, cuando la prueba necesita más de una o transcripts propios.
   *
   * Por defecto una sola sesión, que es lo que basta para casi todo. Se puede pasar otro porque
   * «leer la sesión que acabo de encontrar» sólo se prueba de verdad con dos: con una sola, leer
   * la equivocada da el mismo resultado que leer la correcta.
   */
  index?: FakeSessionIndex;
  /**
   * Directo = el catálogo va como herramientas propias; router = detrás de list/search/use.
   *
   * Por defecto se prueba el router porque es el modo de repliegue —el que hay que garantizar
   * cuando el catálogo no cabe— y porque es el que más superficie tiene. El directo tiene sus
   * propias pruebas más abajo.
   */
  directCapabilities?: boolean;
}): Harness {
  const nube = cloud ?? new ScriptedBrain('nube', []);
  const mcp = fakeMcp({ writable });
  const sessionIndex = index ?? new FakeSessionIndex([indexRow()]);
  const services = buildServices({
    db: openDatabase({ path: ':memory:' }),
    index: sessionIndex as never,
    model: new HybridModel({ local, cloud: nube }),
    mcp: mcp.service,
    config: {
      hosts: ['bastion'], bastionHost: 'bastion', spoolRoot: '/tmp/jarvis-chat-spool',
      // Sin esto no se puede lanzar trabajo de verdad, y la mitad de lo que se prueba aquí es
      // justo cuándo se lanza y cuándo no.
      sshCommand: fakeSshPath(), knownHostsFile: '',
      chatDirectCapabilities: directCapabilities,
    },
  });
  return { services, local, cloud: nube, restarts: mcp.restarts, index: sessionIndex };
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

  it('sin sesión de trabajo se puede leer una sesión, pero no alcanzar el trabajo de un workspace', async () => {
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
    expect(offered).not.toContain('create_run');
    expect(offered).not.toContain('list_runs');
    /*
     * Pero leer una sesión que se acaba de encontrar no exige haber abierto un workspace antes, y
     * negarlo era justo lo que rompía la conversación: el modelo encontraba la sesión, no tenía
     * con qué leerla, y resumía el título como si fuera el contenido. Abrirla y ofrecer terminal
     * van con ella por lo mismo: hallar algo y no poder actuar sobre ello no es haberlo hallado.
     */
    expect(offered).toContain('get_session_context');
    expect(offered).toContain('open_workspace');
    expect(offered).toContain('open_terminal_offer');
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

describe('CHAT · el catálogo como herramientas propias', () => {
  it('ofrece cada capacidad por su nombre, sin el router en medio', async () => {
    let offered: string[] = [];
    const local = new ScriptedBrain('local', [
      (toolbox) => {
        offered = toolbox.definitions().map((tool) => tool.name);
        return { kind: 'finish', summary: 'ok' };
      },
    ]);
    const { services } = track(harness({ local, directCapabilities: true }));
    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'hola', user);
    await settled(services, conversation.id);

    // Cada capacidad es una función declarada: el modelo no puede inventarse un nombre porque la
    // API sólo acepta los que se le dieron. Es la clase de fallo que desaparece en vez de gestionarse.
    expect(offered).toContain('mcp__zeus__memory_pressure');
    expect(offered).toContain('mcp__zeus__zeus_playbook');
    // Y el router sobra: navegar por áreas es lo que se hace cuando no cabe el catálogo.
    expect(offered).not.toContain('search_capabilities');
    expect(offered).not.toContain('use_capability');
  });

  it('llamarla por su nombre la ejecuta por el mismo camino auditado', async () => {
    const local = new ScriptedBrain('local', [
      async (toolbox) => {
        await toolbox.invoke('mcp__zeus__memory_pressure', {});
        return { kind: 'finish', summary: 'la RAM va bien' };
      },
    ]);
    const { services } = track(harness({ local, directCapabilities: true }));
    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, '¿la memoria?', user);
    await settled(services, conversation.id);

    const tool = services.chat.messages(conversation.id).find((message) => message.role === 'tool');
    expect(tool?.toolName).toBe('zeus.memory_pressure');
    expect(tool?.toolOk).toBe(true);
  });

  it('una capacidad con efectos tampoco se ejecuta por su nombre sin firma', async () => {
    let outcome = '';
    const local = new ScriptedBrain('local', [
      async (toolbox) => {
        outcome = JSON.stringify(await toolbox.invoke('mcp__zeus__docker_restart', { container: 'camwall' }));
        return { kind: 'finish', summary: 'ya' };
      },
    ]);
    const { services, restarts } = track(harness({ local, writable: true, directCapabilities: true }));
    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'reinicia camwall', user);
    await settled(services, conversation.id);

    // Ofrecerla como herramienta propia no la abre: sigue haciendo falta la tarjeta.
    expect(restarts).toEqual([]);
    expect(outcome).toContain('request_capability');
  });

  it('si el catálogo no cabe bajo el tope, se vuelve al router entero', async () => {
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
        sshCommand: fakeSshPath(), knownHostsFile: '',
        chatDirectCapabilities: true,
        // Tan bajo que no cabe ni una capacidad además de las propias.
        chatMaxTools: 8,
      },
    });
    open.push(services);
    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'hola', user);
    await settled(services, conversation.id);

    // Entero y no recortado: un catálogo al que le faltan cosas sin decirlo engaña más que uno
    // que hay que navegar.
    expect(offered).toContain('search_capabilities');
    expect(offered.filter((name) => name.startsWith('mcp__'))).toEqual([]);
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

/**
 * TEC-12, de punta a punta: encontrar una sesión y poder seguir.
 *
 * Es la conversación que falló, tal cual. Braian pidió una sesión de Claude sobre iod, Jarvis la
 * encontró, y a «¿de qué trataba?» le devolvió **el título resumido**: no tenía con qué leerla,
 * porque leer el transcript estaba marcado como cosa de workspace y allí no había ninguno. A
 * «ábreme ese workspace» contestó dónde estaba y nada más.
 *
 * Las tres promesas que se fijan aquí son las tres cosas que fallaron: se lee el contenido, se
 * abre lo encontrado, y no se pregunta dos veces lo mismo.
 */
describe('CHAT · una sesión encontrada se lee y se puede continuar', () => {
  /** Cuenta lo que se le pide al índice: sin esto, «no se repitió» no se puede comprobar. */
  class CountingIndex extends FakeSessionIndex {
    listCalls = 0;
    transcriptCalls = 0;

    override async list(query: Parameters<FakeSessionIndex['list']>[0]): ReturnType<FakeSessionIndex['list']> {
      this.listCalls += 1;
      return super.list(query);
    }

    override async transcript(ref: Parameters<FakeSessionIndex['transcript']>[0]): ReturnType<FakeSessionIndex['transcript']> {
      this.transcriptCalls += 1;
      return super.transcript(ref);
    }
  }

  /**
   * Dos sesiones y un transcript propio.
   *
   * Con una sola no se probaría nada: leer la equivocada daría el mismo resultado que leer la
   * correcta, que es exactamente el fallo que se quiere descartar.
   */
  const dosSesiones = (): CountingIndex => {
    const index = new CountingIndex([
      indexRow(),
      indexRow({
        session_key: 'local:claude:sid-iod', session_id: 'sid-iod',
        title: 'iod: el escáner se queda a medias',
        preview: 'llevo dos días con el escáner de iod',
      }),
    ]);
    index.transcripts.set('sid-iod', [
      { role: 'user', at: '2026-08-31T09:00:00.000Z', text: 'el escáner de iod se para al llegar a los ficheros grandes' },
      { role: 'assistant', at: '2026-08-31T09:04:00.000Z', text: 'era el timeout del lector: lo subí a 30s y terminó de barrer' },
    ]);
    return index;
  };

  it('a «¿de qué trataba?» contesta con lo que se dijo dentro, no con el título', async () => {
    let encontrada: Record<string, string> | undefined;
    let leido = '';
    const local = new ScriptedBrain('local', [
      // Turno 1: la busca. Esto ya funcionaba.
      async (toolbox) => {
        const outcome = await toolbox.invoke('search_sessions', { q: 'iod' }) as {
          content: { sessions: Array<Record<string, string>> };
        };
        encontrada = outcome.content.sessions.find((session) => session['sessionId'] === 'sid-iod');
        return { kind: 'finish', summary: `la tengo: ${encontrada?.['title']}` };
      },
      // Turno 2: «¿de qué trataba?». Con la referencia que trajo la búsqueda, no con su título.
      async (toolbox) => {
        const outcome = await toolbox.invoke('get_session_context', {
          host: encontrada?.['host'], provider: encontrada?.['provider'], sessionId: encontrada?.['sessionId'],
        }) as { content: { ok: boolean; messages?: Array<{ text: string }> } };
        leido = (outcome.content.messages ?? []).map((message) => message.text).join(' ');
        return { kind: 'finish', summary: 'era el timeout del lector del escáner' };
      },
    ]);
    // Sin workspace: una conversación suelta, como la que falló.
    const { services } = track(harness({ local, index: dosSesiones() }));
    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'busca una sesión de Claude sobre iod', user);
    await settled(services, conversation.id);
    services.chat.send(conversation.id, '¿de qué trataba?', user);
    await settled(services, conversation.id);

    // Lo que leyó es lo que se dijo dentro, no el título ni la primera línea.
    expect(leido).toContain('timeout del lector');
    expect(leido).not.toBe('');
    // Y consta que fue a leerla: la consulta quedó escrita con su nombre, como cualquier otra.
    const tools = services.chat.messages(conversation.id).filter((message) => message.role === 'tool');
    const lectura = tools.find((message) => message.toolName === 'get_session_context');
    expect(lectura).toBeDefined();
    expect(lectura?.toolOk).toBe(true);
  });

  it('a «ábremela» abre el workspace y deja la referencia para pulsarla', async () => {
    const local = new ScriptedBrain('local', [
      async (toolbox) => {
        await toolbox.invoke('open_workspace', {
          host: 'bastion', provider: 'claude', sessionId: 'sid-iod',
          title: 'iod: el escáner se queda a medias',
        });
        return { kind: 'finish', summary: 'te la dejo abierta' };
      },
    ]);
    const { services } = track(harness({ local, index: dosSesiones() }));
    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'ábreme ese workspace', user);
    await settled(services, conversation.id);

    /*
     * Decir dónde está no es abrirla. Lo que convierte el hallazgo en algo que se puede pulsar es
     * la referencia, y por eso se comprueba en el mensaje y no en la base: si no viaja al hilo, la
     * pantalla no tiene qué pintar y la respuesta vuelve a ser una dirección postal.
     */
    const assistant = services.chat.messages(conversation.id).find((message) => message.role === 'assistant');
    const ref = assistant?.refs?.find((candidate) => candidate.kind === 'workspace');
    expect(ref).toBeDefined();
    // Y el id lleva a algún sitio: es el workspace de la sesión que se pidió, no uno cualquiera.
    const abierto = services.workspaces.require((ref as { workspaceId: string }).workspaceId);
    expect(abierto.ref.sessionId).toBe('sid-iod');
  });

  it('ofrecer terminal sobre una sesión suelta deja la referencia con esa sesión', async () => {
    const local = new ScriptedBrain('local', [
      async (toolbox) => {
        await toolbox.invoke('open_terminal_offer', {
          reason: 'el escáner hay que verlo mientras corre',
          host: 'bastion', provider: 'claude', sessionId: 'sid-iod',
        });
        return { kind: 'finish', summary: 'te dejo el botón' };
      },
    ]);
    const { services } = track(harness({ local, index: dosSesiones() }));
    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'quiero verlo en vivo', user);
    await settled(services, conversation.id);

    const assistant = services.chat.messages(conversation.id).find((message) => message.role === 'assistant');
    const ref = assistant?.refs?.find((candidate) => candidate.kind === 'terminal');
    expect(ref).toMatchObject({ host: 'bastion', provider: 'claude', sessionId: 'sid-iod' });
    // Ofrecida, no abierta: la tmux la levanta quien pulse, como siempre.
    expect((ref as { reason: string }).reason).toContain('mientras corre');
  });

  it('el modelo que insiste con la misma consulta no la ejecuta dos veces', async () => {
    let repetidas = 0;
    const local = new ScriptedBrain('local', [
      async (toolbox) => {
        await toolbox.invoke('search_sessions', { q: 'iod' });
        await toolbox.invoke('search_sessions', { q: 'iod' });
        await toolbox.invoke('search_sessions', { q: 'iod' });
        repetidas = toolbox.repeats;
        return { kind: 'finish', summary: 'ya lo tengo' };
      },
    ]);
    const { services, index } = track(harness({ local, index: dosSesiones() }));
    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'busca lo de iod', user);
    await settled(services, conversation.id);

    /*
     * La repetición no deja fila en el hilo, y aun así se sabe que ocurrió.
     *
     * Una fila `tool` afirma «miré esto»; si el memo cortó la llamada antes de salir, no se miró
     * nada y la fila mentiría —además de dejar en la base justo las repeticiones que este trabajo
     * venía a quitar—. Que no deje rastro no puede significar que no se sepa: por eso se cuentan
     * aparte, y por eso se comprueban las dos cosas juntas. Sin el contador, «arreglé el bucle» y
     * «lo escondí» se ven igual desde fuera.
     */
    const consultas = services.chat.messages(conversation.id)
      .filter((message) => message.role === 'tool' && message.toolName === 'search_sessions');
    expect(consultas).toHaveLength(1);
    expect(repetidas).toBe(2);

    /*
     * Una sola consulta al índice, no tres.
     *
     * En la conversación de verdad **12 de 25 consultas fueron repeticiones exactas**, cinco de
     * ellas esta misma búsqueda. Lo que se recupera cortándolas no es tiempo de índice —es barato—
     * sino el turno: cada repetición gastaba una de las consultas que el modelo tenía para
     * averiguar algo.
     */
    expect(index.listCalls).toBe(1);
  });
});

/**
 * Lo encontrado sobrevive al turno, y la oferta sobrevive al tope.
 *
 * Dos fallos que sólo se ven con el hilo puesto: el título de una sesión se perdía al volver a
 * nombrarla, y la oferta de terminal se caía de la lista de acciones cuando el turno seguía
 * mirando cosas. Ninguno rompe nada de forma visible —por eso hacen falta pruebas— y los dos
 * vacían de sentido lo que se acababa de construir.
 */
describe('CHAT · lo que el hilo recuerda y lo que la pantalla enseña', () => {
  const variasSesiones = (): FakeSessionIndex => {
    const filas = ['iod', 'pool', 'cámaras', 'backup', 'dns'].map((tema, indice) => indexRow({
      session_key: `local:claude:sid-${tema}`, session_id: `sid-${tema}`,
      title: `${tema}: lo que quedó a medias`, preview: `estábamos con ${tema}`,
    }));
    const index = new FakeSessionIndex(filas);
    for (const fila of filas) {
      index.transcripts.set(fila.session_id, [
        { role: 'user', at: '2026-08-31T09:00:00.000Z', text: `el asunto de ${fila.session_id} sigue abierto` },
      ]);
    }
    return index;
  };

  it('el título de una sesión no se pierde al ofrecer una terminal sobre ella', async () => {
    const local = new ScriptedBrain('local', [
      /*
       * Turno 1, en el orden en que pasa de verdad: buscar —de ahí sale el título—, leer, y
       * ofrecer la terminal. La ref `session` de la lectura lleva título; la `terminal` no.
       */
      async (toolbox) => {
        await toolbox.invoke('search_sessions', { q: 'iod' });
        await toolbox.invoke('get_session_context', { host: 'bastion', provider: 'claude', sessionId: 'sid-iod' });
        await toolbox.invoke('open_terminal_offer', { reason: 'verlo en vivo', sessionId: 'sid-iod' });
        return { kind: 'finish', summary: 'te dejo las dos cosas' };
      },
      () => ({ kind: 'finish', summary: 'ya' }),
    ]);
    const { services } = track(harness({ local, index: variasSesiones() }));
    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'mira lo de iod', user);
    await settled(services, conversation.id);
    services.chat.send(conversation.id, '¿y qué era?', user);
    await settled(services, conversation.id);

    /*
     * El contexto del segundo turno tiene que decir de qué iba la sesión, no sólo dónde está.
     *
     * El orden natural es encontrarla y **después** ofrecer la terminal en ella; si lo segundo
     * sobrescribe a lo primero, al modelo le llega «hay una sesión en bastion» sin más, que es lo
     * contrario de para lo que existe este bloque.
     */
    const encontradas = local.lastContext?.found ?? [];
    expect(encontradas.find((sesion) => sesion.sessionId === 'sid-iod')?.title).toContain('iod');
  });

  it('la oferta de terminal no se cae de las acciones aunque el turno siga mirando', async () => {
    const local = new ScriptedBrain('local', [
      async (toolbox) => {
        // Se ofrece pronto...
        await toolbox.invoke('open_terminal_offer', {
          reason: 'hay que verlo mientras corre',
          host: 'bastion', provider: 'claude', sessionId: 'sid-iod',
        });
        // ...y después el turno mira cuatro sesiones más, cada una con su referencia.
        for (const tema of ['pool', 'cámaras', 'backup', 'dns']) {
          await toolbox.invoke('get_session_context', { host: 'bastion', provider: 'claude', sessionId: `sid-${tema}` });
        }
        return { kind: 'finish', summary: 'mirado todo' };
      },
    ]);
    const { services } = track(harness({ local, index: variasSesiones() }));
    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'repasa lo que hay', user);
    await settled(services, conversation.id);

    const assistant = services.chat.messages(conversation.id).find((message) => message.role === 'assistant');
    /*
     * Caben cuatro, y una tiene que ser la terminal.
     *
     * Es la única que explica **por qué** conviene mirar, y el motivo vive dentro de la propia
     * referencia: si se cae, no queda ni rastro de que llegó a ofrecerse. Las otras tres son
     * pastillas intercambiables; ésta no.
     */
    expect(assistant?.refs).toHaveLength(4);
    expect(assistant?.refs.filter((ref) => ref.kind === 'terminal')).toHaveLength(1);
  });

  it('el mismo sitio no se ofrece dos veces por haber cambiado de nombre', async () => {
    const local = new ScriptedBrain('local', [
      async (toolbox) => {
        await toolbox.invoke('open_workspace', { host: 'bastion', provider: 'claude', sessionId: 'sid-iod', title: 'iod' });
        // Otra vez la misma sesión: mismo workspace, y el memo devuelve lo de antes.
        await toolbox.invoke('open_workspace', { host: 'bastion', provider: 'claude', sessionId: 'sid-iod', title: 'iod, renombrado' });
        return { kind: 'finish', summary: 'abierta' };
      },
    ]);
    const { services } = track(harness({ local, index: variasSesiones() }));
    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'ábreme lo de iod', user);
    await settled(services, conversation.id);

    // Dos botones al mismo sitio son un botón: la identidad es el workspace, no el objeto entero.
    const assistant = services.chat.messages(conversation.id).find((message) => message.role === 'assistant');
    expect(assistant?.refs.filter((ref) => ref.kind === 'workspace')).toHaveLength(1);
  });
});

/**
 * Lo que se supo en un turno tiene que seguir sabiéndose en el siguiente.
 *
 * Éste es el fallo que ninguna prueba de toolbox podía ver, y conviene decir por qué: `#seen` vive
 * en el toolbox y **el toolbox se construye uno por turno**, así que una prueba que use un solo
 * toolbox está probando justo el caso que no falla. Se vio contra producción, no aquí: la búsqueda
 * del turno 1 traía el directorio —el modelo hasta lo citaba en su respuesta— y la terminal del
 * turno 3 salía con `cwd: null`, arrancando en el home y sin camino de vuelta.
 *
 * La frontera que hay que cruzar es la del turno, y sólo se cruza mandando dos mensajes.
 */
describe('CHAT · la memoria de las sesiones sobrevive al turno', () => {
  const conDirectorio = (): FakeSessionIndex => {
    const index = new FakeSessionIndex([
      indexRow({ session_id: 'sid-iod', title: 'iod: el escáner se queda a medias', cwd: '/var/www/landing' }),
    ]);
    index.transcripts.set('sid-iod', [
      { role: 'user', at: '2026-08-31T09:00:00.000Z', text: 'el escáner de iod se para con los ficheros grandes' },
    ]);
    return index;
  };

  it('la terminal de un turno posterior sale con el directorio que trajo la búsqueda', async () => {
    const local = new ScriptedBrain('local', [
      // Turno 1: busca y lee. De aquí sale la referencia con el directorio.
      async (toolbox) => {
        await toolbox.invoke('search_sessions', { q: 'iod' });
        await toolbox.invoke('get_session_context', { sessionId: 'sid-iod' });
        return { kind: 'finish', summary: 'era el timeout del escáner' };
      },
      // Turno 2, toolbox nuevo: el modelo pide la terminal como la pide de verdad, con el id.
      async (toolbox) => {
        await toolbox.invoke('open_terminal_offer', { reason: 'verlo mientras barre', sessionId: 'sid-iod' });
        return { kind: 'finish', summary: 'te dejo el botón' };
      },
    ]);
    const { services } = track(harness({ local, index: conDirectorio() }));
    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'busca lo de iod y dime de qué iba', user);
    await settled(services, conversation.id);
    services.chat.send(conversation.id, 'quiero verlo en vivo', user);
    await settled(services, conversation.id);

    const mensajes = services.chat.messages(conversation.id).filter((message) => message.role === 'assistant');
    const terminal = mensajes.at(-1)?.refs.find((ref) => ref.kind === 'terminal');
    // Sin el directorio la tmux arranca en el home: es media oferta, y parece entera.
    expect(terminal).toMatchObject({ sessionId: 'sid-iod', cwd: '/var/www/landing' });
  });

  it('el workspace abierto en un turno es el camino de vuelta de la terminal del siguiente', async () => {
    let abierto: string | undefined;
    const local = new ScriptedBrain('local', [
      async (toolbox) => {
        const outcome = await toolbox.invoke('open_workspace', {
          host: 'bastion', provider: 'claude', sessionId: 'sid-iod',
        }) as { content: { workspaceId?: string } };
        abierto = outcome.content.workspaceId;
        return { kind: 'finish', summary: 'abierta' };
      },
      async (toolbox) => {
        await toolbox.invoke('open_terminal_offer', { reason: 'seguirlo a mano', sessionId: 'sid-iod' });
        return { kind: 'finish', summary: 'ahí tienes' };
      },
    ]);
    const { services } = track(harness({ local, index: conDirectorio() }));
    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'ábreme lo de iod', user);
    await settled(services, conversation.id);
    services.chat.send(conversation.id, 'y déjame una terminal', user);
    await settled(services, conversation.id);

    /*
     * La referencia `workspace` no dice de qué sesión es —lo dice la base—, así que esto sólo
     * funciona si el hilo resuelve el id contra los workspaces. Es la mitad del arreglo que no se
     * ve mirando el toolbox.
     */
    const mensajes = services.chat.messages(conversation.id).filter((message) => message.role === 'assistant');
    const terminal = mensajes.at(-1)?.refs.find((ref) => ref.kind === 'terminal');
    expect(abierto).toBeDefined();
    expect(terminal).toMatchObject({ sessionId: 'sid-iod', workspaceId: abierto });
  });

  it('y con host y provider repetidos pero sin el directorio, que es como falló de verdad', async () => {
    const local = new ScriptedBrain('local', [
      async (toolbox) => {
        await toolbox.invoke('search_sessions', { q: 'iod' });
        await toolbox.invoke('get_session_context', { sessionId: 'sid-iod' });
        return { kind: 'finish', summary: 'era el timeout' };
      },
      /*
       * El modelo repite lo que sabe decir —máquina, proveedor, id— y **no** el directorio, que se
       * le dio dos turnos antes y no vuelve a escribir. Ésta es la forma exacta que se midió
       * contra producción: la referencia salía, así que parecía que funcionaba, y salía con
       * `cwd: null`. Una oferta que existe y arranca donde no es se parece mucho a una que va bien.
       */
      async (toolbox) => {
        await toolbox.invoke('open_terminal_offer', {
          reason: 'verlo mientras barre', host: 'bastion', provider: 'claude', sessionId: 'sid-iod',
        });
        return { kind: 'finish', summary: 'ahí lo tienes' };
      },
    ]);
    const { services } = track(harness({ local, index: conDirectorio() }));
    const conversation = services.chat.create({ user });
    services.chat.send(conversation.id, 'busca lo de iod', user);
    await settled(services, conversation.id);
    services.chat.send(conversation.id, 'quiero verlo en vivo', user);
    await settled(services, conversation.id);

    const mensajes = services.chat.messages(conversation.id).filter((message) => message.role === 'assistant');
    const terminal = mensajes.at(-1)?.refs.find((ref) => ref.kind === 'terminal');
    expect(terminal).toBeDefined();
    expect(terminal).toMatchObject({ sessionId: 'sid-iod', cwd: '/var/www/landing' });
  });
});
