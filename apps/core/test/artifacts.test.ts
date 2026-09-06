/**
 * Lo que el asistente enseña.
 *
 * Lo que se prueba aquí no es que elija bien qué presentar —eso no se prueba— sino las tres cosas
 * que hacen que presentar sea seguro de operar: que un cuerpo mal formado se le devuelve diciendo
 * **qué** falta para que se corrija dentro del turno, que lo que se sirve va acotado y lo dice, y
 * que enseñar no consume el presupuesto de consultas ni desaparece cuando ese presupuesto se agota.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeSessionIndex, indexRow } from '@jarvis/testkit';
import { openDatabase } from '../src/platform/db.js';
import { fixedClock } from '../src/platform/clock.js';
import { buildServices, type CoreServices } from '../src/services.js';
import { CoreAssistantToolbox } from '../src/assistant/toolbox.js';
import {
  ArtifactRepository, MAX_ARTIFACT_BYTES, normalizeChart, normalizeTable, previewOf, resolveKind,
  samePresentation, validateBody,
} from '../src/chat/artifacts.js';
import type {
  AssistantToolbox, PlanContext, ToolDefinition, ToolOutcome,
} from '../src/assistant/types.js';
import {
  OpenAiCompatibleModel, REASONING_EFFORTS, ScriptedModel,
  type FetchLike, type ModelTurnUsage,
} from '../src/assistant/model.js';

const user = { userId: 'u1', username: 'braian' };
const NOW = '2026-09-05T12:00:00.000Z';

let services: CoreServices;
let artifacts: ArtifactRepository;
let conversationId: string;

beforeEach(() => {
  services = buildServices({
    db: openDatabase({ path: ':memory:' }),
    clock: fixedClock(NOW),
    index: new FakeSessionIndex([indexRow()]) as never,
    model: null,
    config: { hosts: ['bastion'], bastionHost: 'bastion', spoolRoot: '/tmp/jarvis-artifacts-spool' },
  });
  artifacts = new ArtifactRepository({ db: services.db, clock: fixedClock(NOW) });
  // La conversación se inserta a pelo: aquí interesa el artifact, no el turno, y crearla por el
  // servicio exigiría un modelo configurado que estas pruebas no usan para nada.
  conversationId = 'c-test';
  services.db.prepare(`INSERT INTO conversations
    (id, title, created_by, workspace_id, autonomy, status, source, created_at, updated_at, last_message_at)
    VALUES (?, 'prueba', ?, NULL, 'manual', 'idle', 'local', ?, ?, NULL)`)
    .run(conversationId, user.username, NOW, NOW);
});

const toolbox = (options: { maxObservations?: number } = {}): CoreAssistantToolbox =>
  new CoreAssistantToolbox({
    sessions: services.sessions,
    health: services.health,
    runs: services.runs,
    audit: services.audit,
    user,
    artifacts: { repository: artifacts, conversationId },
    ...(options.maxObservations === undefined ? {} : { maxObservations: options.maxObservations }),
  });

const failed = (outcome: ToolOutcome): { code: string; message: string; hint?: string } => {
  expect(outcome.type).toBe('observation');
  const content = (outcome as { content: { ok?: boolean; error?: { code: string; message: string; hint?: string } } }).content;
  expect(content.ok).toBe(false);
  return content.error!;
};

const served = (outcome: ToolOutcome): Record<string, unknown> => {
  expect(outcome.type).toBe('observation');
  const content = (outcome as { content: Record<string, unknown> }).content;
  expect(content['ok']).toBe(true);
  return content;
};

const table = (rows: unknown): string => JSON.stringify({
  columns: [{ key: 'host', label: 'Máquina' }, { key: 'libre', label: 'Libre' }],
  rows,
});

describe('ARTIFACT · un cuerpo mal formado se corrige, no se rechaza y ya', () => {
  it('dice qué columna falta y en qué fila, que es lo que se puede arreglar', async () => {
    const error = failed(await toolbox().invoke('present', {
      kind: 'table', presentation: 'inline', title: 'Disco',
      body: table([{ host: 'zeus', libre: '40G' }, { host: 'bastion' }]),
    }));

    expect(error.code).toBe('BAD_INPUT');
    expect(error.message).toContain('libre');
    expect(error.message).toContain('fila 2');
  });

  it('un JSON que no se puede leer viene con un ejemplo de la forma buena', async () => {
    const error = failed(await toolbox().invoke('present', {
      kind: 'table', presentation: 'inline', title: 'Disco', body: 'esto no es json',
    }));

    expect(error.code).toBe('BAD_INPUT');
    expect(error.hint).toContain('columns');
  });

  it('un gráfico que no sabemos dibujar dice cuáles sí, en vez de prometer uno genérico', async () => {
    const error = failed(await toolbox().invoke('present', {
      kind: 'chart', presentation: 'inline', title: 'Carga',
      body: JSON.stringify({ shape: 'scatter', points: [] }),
    }));

    expect(error.message).toContain('scatter');
    expect(error.hint).toContain('bars');
    expect(error.hint).toContain('donut');
    expect(error.hint).toContain('meter');
  });

  it('y después del error se puede volver a intentar en el mismo turno', async () => {
    const caja = toolbox();
    failed(await caja.invoke('present', {
      kind: 'table', presentation: 'inline', title: 'Disco', body: 'roto',
    }));
    served(await caja.invoke('present', {
      kind: 'table', presentation: 'inline', title: 'Disco', body: table([{ host: 'zeus', libre: '40G' }]),
    }));
  });
});

describe('ARTIFACT · lo mismo escrito de otra forma sigue siendo lo mismo', () => {
  // Medido en producción: a «¿qué puedes hacer?» presentó cuatro veces la misma lista, cambiando
  // el título y una palabra del cuerpo. El memo por argumentos no podía verlo.
  const lista = 'Localizar sesiones de agente en toda la flota y abrir sus workspace como marcador.\n'
    + 'Encargar trabajo al agente de sesión y supervisarlo; dura horas y sobrevive a reinicios.';
  const reformulada = 'Localizar sesiones de agente en toda la flota y abrir sus workspace como marcadores.\n'
    + 'Encargar trabajo al agente de sesión y supervisarlo; dura horas y sobrevive a reinicios.';

  it('una palabra distinta no lo convierte en otro cuadro', () => {
    expect(samePresentation(lista, reformulada)).toBe(true);
  });

  it('pero dos cuadros distintos del mismo tema siguen siendo dos', () => {
    expect(samePresentation(lista, 'Disco por máquina: zeus 40G libres, bastion 12G, serverC 210G'))
      .toBe(false);
  });

  it('repetir devuelve el que ya había y no gasta uno de los tres', async () => {
    const caja = toolbox();
    const primero = served(await caja.invoke('present', {
      kind: 'markdown', presentation: 'panel', title: 'Qué puedes hacer', body: lista,
    }));
    const segundo = served(await caja.invoke('present', {
      kind: 'markdown', presentation: 'panel', title: 'Capacidades', body: reformulada,
    }));

    expect(segundo['repeated']).toBe(true);
    expect(segundo['artifactId']).toBe(primero['artifactId']);
    // Un solo artifact colgado, no dos: el turno enseñó una cosa porque enseñó una cosa.
    expect(caja.refs.filter((ref) => ref.kind === 'artifact')).toHaveLength(1);
    expect(caja.repeats).toBe(1);
  });

  it('y quedan los tres huecos para lo que de verdad sea distinto', async () => {
    const caja = toolbox();
    await caja.invoke('present', { kind: 'markdown', presentation: 'inline', title: 'A', body: lista });
    await caja.invoke('present', { kind: 'markdown', presentation: 'inline', title: 'A2', body: reformulada });
    served(await caja.invoke('present', { kind: 'markdown', presentation: 'inline', title: 'B', body: 'disco y memoria de las tres máquinas' }));
    served(await caja.invoke('present', { kind: 'markdown', presentation: 'inline', title: 'C', body: 'trabajos en marcha ahora mismo y su estado' }));

    expect(caja.refs.filter((ref) => ref.kind === 'artifact')).toHaveLength(3);
  });
});

describe('ARTIFACT · confundir los dos campos no cuesta el turno', () => {
  it('un kind que es una presentación se resuelve mirando el cuerpo, no se rechaza', async () => {
    // Medido en producción: `kind: "panel"` con `presentation: "panel"`. Son dos enumerados
    // seguidos y «panel» es una respuesta plausible a «de qué tipo es».
    const outcome = served(await toolbox().invoke('present', {
      kind: 'panel', presentation: 'panel', title: 'Planes',
      body: '- Plan corto: validar\n- Plan medio: estabilizar',
    }));

    expect(outcome['presentation']).toBe('panel');
  });

  it('y el cuerpo decide el tipo: una tabla se reconoce por sus columnas', () => {
    expect(resolveKind('panel', table([{ host: 'zeus' }]))).toBe('table');
    expect(resolveKind('modal', JSON.stringify({ shape: 'meter', value: 1, max: 2 }))).toBe('chart');
    // `html` NO se infiere: es la única rama donde adivinar mal concede en vez de degradar, y
    // se dispararía con un carácter. Un cuerpo con etiquetas sale como texto, que es inerte.
    expect(resolveKind('inline', '<p>hola</p>')).toBe('markdown');
    expect(resolveKind('panel', 'texto normal')).toBe('markdown');
    expect(resolveKind('markdown', 'texto normal')).toBe('markdown');
  });

  it('pero un kind que no es ni un tipo ni una presentación sigue siendo un error', () => {
    // Adivinar aquí sería inventar: sólo se rescata la confusión que se ha visto de verdad.
    expect(resolveKind('diagrama', 'lo que sea')).toBeNull();
  });
});

describe('ARTIFACT · lo que se sirve va acotado y lo dice', () => {
  it('un cuerpo enorme se recorta y se dice que se recortó', () => {
    const created = artifacts.create(conversationId, {
      kind: 'markdown', presentation: 'panel', title: 'Log',
      body: 'a'.repeat(MAX_ARTIFACT_BYTES + 1000),
    });

    expect('code' in created).toBe(false);
    const artifact = created as Exclude<typeof created, { code: unknown }>;
    expect(artifact.truncated).toBe(true);
    expect(artifact.bytes).toBeLessThanOrEqual(MAX_ARTIFACT_BYTES);
  });

  it('un html nunca se cuela dentro de la burbuja: se mira a propósito', () => {
    const created = artifacts.create(conversationId, {
      kind: 'html', presentation: 'inline', title: 'Informe', body: '<p>hola</p>',
    });

    expect((created as { presentation: string }).presentation).toBe('panel');
  });

  it('el cuarto del turno se rechaza diciendo que ya toca responder', async () => {
    const caja = toolbox();
    for (let i = 0; i < 3; i += 1) {
      served(await caja.invoke('present', {
        kind: 'markdown', presentation: 'inline', title: `Nota ${i}`, body: `cosa ${i}`,
      }));
    }
    const error = failed(await caja.invoke('present', {
      kind: 'markdown', presentation: 'inline', title: 'Nota 4', body: 'una más',
    }));

    expect(error.code).toBe('TOO_MANY');
  });
});

describe('ARTIFACT · lo presentado sobrevive a un turno que acaba en nada', () => {
  it('un turno sin sesión que quiso lanzar trabajo conserva lo que ya había enseñado', async () => {
    const caja = toolbox();
    served(await caja.invoke('present', {
      kind: 'markdown', presentation: 'inline', title: 'Resumen', body: 'lo que averigüé',
    }));

    /*
     * La referencia tiene que salir del toolbox aunque la decisión del turno no se pueda cumplir.
     *
     * Es lo que se rompía: el modelo presentaba tres cosas y luego pedía lanzar un trabajo en una
     * conversación sin sesión; el core escribía el aviso y los tres artifacts quedaban escritos en
     * su tabla sin ningún mensaje del que colgar. Nadie podía abrirlos y nada decía que existieran.
     */
    expect(caja.refs.filter((ref) => ref.kind === 'artifact')).toHaveLength(1);
  });
});

describe('ARTIFACT · el botón dice qué hay detrás', () => {
  it('una tabla se anuncia por su tamaño, no por su título a secas', () => {
    expect(previewOf('table', table([{ host: 'a' }, { host: 'b' }, { host: 'c' }])))
      .toBe('3 filas · 2 columnas');
  });

  it('en singular cuando toca: una lista que dice «1 filas» se lee mal', () => {
    expect(previewOf('table', table([{ host: 'a' }]))).toBe('1 fila · 2 columnas');
  });

  it('un gráfico dice su tamaño en sus propias unidades', () => {
    expect(previewOf('chart', JSON.stringify({
      shape: 'donut', caption: 'Trabajos', total: 9,
      slices: [{ key: 'ok', label: 'Bien', value: 7 }, { key: 'ko', label: 'Mal', value: 2 }],
    }))).toBe('2 porciones');
    expect(previewOf('chart', JSON.stringify({ shape: 'meter', label: 'Disco', value: 60, max: 100 })))
      .toBe('60 de 100');
  });

  it('un documento no se anuncia por su marcado: eso dice cómo está hecho, no qué hay', () => {
    expect(previewOf('html', '<style>body{font:14px system-ui}</style><h3>Sonda</h3>')).toBeNull();
  });

  it('y lo que se lee se anuncia por su primera línea', () => {
    expect(previewOf('markdown', '\n\n## Estado de la flota\ntodo bien')).toBe('## Estado de la flota');
  });
});

describe('ARTIFACT · enseñar no es consultar', () => {
  it('no gasta presupuesto de consultas: no va a ninguna máquina', async () => {
    const caja = toolbox();
    await caja.invoke('present', {
      kind: 'markdown', presentation: 'inline', title: 'Nota', body: 'algo',
    });

    expect(caja.observations).toBe(0);
  });

  it('se sigue ofreciendo con el presupuesto agotado, que es cuando se redacta', async () => {
    const caja = toolbox({ maxObservations: 1 });
    await caja.invoke('get_health', {});
    expect(caja.spent).toBe(true);

    const nombres = caja.definitions({ decisionsOnly: true }).map((tool) => tool.name);
    expect(nombres).toContain('present');
    // Y sigue funcionando de verdad, no sólo ofreciéndose.
    served(await caja.invoke('present', {
      kind: 'markdown', presentation: 'inline', title: 'Resumen', body: 'lo que averigüé',
    }));
  });

  it('deja el puntero en las referencias, no el cuerpo', async () => {
    const caja = toolbox();
    // Largo a propósito: en algo corto el preview y el cuerpo coinciden y la prueba no distingue
    // «lleva un adelanto» de «lleva el contenido», que es justo lo que hay que fijar aquí.
    const cuerpo = `primera línea del informe\n${'detalle que no cabe en un botón. '.repeat(400)}`;
    const outcome = served(await caja.invoke('present', {
      kind: 'markdown', presentation: 'panel', title: 'Informe', body: cuerpo,
    }));

    const ref = caja.refs.find((entry) => entry.kind === 'artifact');
    expect(ref).toBeDefined();
    expect((ref as { artifactId: string }).artifactId).toBe(outcome['artifactId']);
    // El puntero no crece con el contenido: es lo que hace que meterlo en el mensaje no se pague
    // en tokens en cada turno.
    expect(JSON.stringify(ref).length).toBeLessThan(400);
    expect(JSON.stringify(ref)).not.toContain('detalle que no cabe');
  });

  it('sin sitio donde guardarlo, ni se ofrece', () => {
    const sinArtifacts = new CoreAssistantToolbox({
      sessions: services.sessions, health: services.health, runs: services.runs,
      audit: services.audit, user,
    });

    expect(sinArtifacts.definitions().map((tool) => tool.name)).not.toContain('present');
  });
});

/**
 * Enseñar no es consultar, y el presupuesto del turno tiene que saberlo.
 *
 * Medido en producción y con la conversación delante: cuatro consultas y **un** `present` agotaban
 * el presupuesto de seis vueltas, y la persona —que había preguntado por sus planes— recibía «se
 * agotó el presupuesto de consultas de este turno» como respuesta. Dos fallos en uno: uno de
 * contabilidad y otro de qué se le enseña a alguien cuando el contador llega al final.
 */
class ContadorToolbox implements AssistantToolbox {
  readonly calls: string[] = [];
  terminalOffer = null;
  refs = [];
  repeats = 0;
  observations = 0;
  spent = false;

  definitions({ decisionsOnly = false }: { decisionsOnly?: boolean } = {}): ToolDefinition[] {
    const all: ToolDefinition[] = [
      { name: 'get_health', description: '', inputSchema: { type: 'object', properties: {} }, decides: false },
      { name: 'present', description: '', inputSchema: { type: 'object', properties: {} }, decides: false, free: true },
      { name: 'finish', description: '', inputSchema: { type: 'object', properties: {} }, decides: true },
    ];
    return all.filter((tool) => !decisionsOnly || tool.decides || tool.free === true);
  }

  async invoke(name: string): Promise<ToolOutcome> {
    this.calls.push(name);
    if (name === 'finish') return { type: 'decision', decision: { kind: 'finish', summary: 'aquí tienes' } };
    if (name !== 'present') this.observations += 1;
    return { type: 'observation', content: { ok: true } };
  }
}

const contexto: PlanContext = {
  objective: 'dime qué puedes hacer con los planes, y gráficamelo',
  history: [],
  pendingInput: null,
  pendingApprovals: [],
  limits: { stepsUsed: 0, maxSteps: 12, maxToolCalls: 2, maxToolOutputBytes: 60_000 },
};

/** Un modelo guionizado a nivel de HTTP: cada respuesta es la vuelta siguiente. */
const fetchQue = (nombres: string[]): FetchLike => {
  let i = 0;
  return (async () => {
    const name = nombres[i++];
    const message = name
      ? { tool_calls: [{ id: `c${i}`, type: 'function', function: { name, arguments: '{}' } }] }
      : { content: 'sin nada' };
    const payload = { choices: [{ message }] };
    return {
      ok: true, status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  }) as unknown as FetchLike;
};

describe('TURNO · el presupuesto cuenta lo que consulta, no lo que enseña', () => {
  it('presentar tres cosas no gasta el margen de consultas', async () => {
    const toolbox = new ContadorToolbox();
    const model = new OpenAiCompatibleModel({
      apiKey: 'k', baseUrl: 'https://api.test', model: 'm', maxToolCalls: 2,
      fetchImpl: fetchQue(['get_health', 'present', 'present', 'present', 'get_health', 'finish']),
    });

    const decision = await model.decide(contexto, toolbox);

    // Con el fallo anterior las tres presentaciones se comían las vueltas y esto era el mensaje
    // del contador en vez de una respuesta.
    expect(decision).toEqual({ kind: 'finish', summary: 'aquí tienes' });
    expect(toolbox.calls).toEqual(['get_health', 'present', 'present', 'present', 'get_health', 'finish']);
  });

  it('y cuando se acaba de verdad, lo que se lee es una respuesta y no un contador', async () => {
    const toolbox = new ContadorToolbox();
    const model = new OpenAiCompatibleModel({
      apiKey: 'k', baseUrl: 'https://api.test', model: 'm', maxToolCalls: 1,
      fetchImpl: fetchQue(['get_health', 'get_health', 'get_health', 'get_health', 'get_health', 'get_health']),
    });

    const decision = await model.decide(contexto, toolbox);

    expect(decision.kind).toBe('finish');
    const summary = (decision as { summary: string }).summary;
    expect(summary).not.toContain('presupuesto');
    expect(summary).toContain('vuelve a preguntarme');
  });

  /*
   * Quien manda es el turno, no la instancia.
   *
   * El mismo modelo lo comparten la conversación y el motor de planes, que tienen topes distintos,
   * y se construye con el del motor. Sin esto el chat tenía **tres cuentas del mismo turno** —el
   * prompt prometía las suyas, el toolbox dejaba las suyas y el bucle paraba con las del motor— y
   * la más baja mandaba en silencio: se leía «me quedé sin margen» con el margen a medias.
   *
   * Los números imitan el caso real: instancia 1 (como `JARVIS_ASSISTANT_MAX_TOOL_CALLS`), turno 6
   * (como `JARVIS_CHAT_MAX_TOOL_CALLS`). Con el fallo, la cuarta consulta no llegaba a hacerse.
   */
  it('el tope que para el turno es el que se le prometió, no el de la instancia', async () => {
    const toolbox = new ContadorToolbox();
    const model = new OpenAiCompatibleModel({
      apiKey: 'k', baseUrl: 'https://api.test', model: 'm', maxToolCalls: 1,
      fetchImpl: fetchQue(['get_health', 'get_health', 'get_health', 'get_health', 'finish']),
    });

    const decision = await model.decide(
      { ...contexto, limits: { ...contexto.limits, maxToolCalls: 6 } },
      toolbox,
    );

    expect(decision).toEqual({ kind: 'finish', summary: 'aquí tienes' });
    expect(toolbox.calls).toHaveLength(5);
  });
});

/**
 * Cuánto se piensa lo decide una pasada previa, y hay que poder comprobar que decide de verdad.
 *
 * El fallo probable de esto no es que se rompa: es que conteste siempre lo mismo. Desde fuera se
 * ve idéntico a que funcione, así que lo que se fija aquí es que **el nivel que sale cambia con la
 * pregunta** y que llega a la telemetría, que es donde se podrá auditar dentro de una semana.
 */
describe('ESFUERZO · lo decide una pasada previa y queda anotado', () => {
  const conJuez = (dice: string, usos: ModelTurnUsage[]) => {
    let primera = true;
    const enviados: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      enviados.push(body);
      const message = primera
        ? { content: dice }
        : { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'finish', arguments: '{}' } }] };
      primera = false;
      const payload = { choices: [{ message }] };
      return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
    }) as unknown as FetchLike;
    const model = new OpenAiCompatibleModel({
      apiKey: 'k', baseUrl: 'https://api.test', model: 'gpt-5-nano',
      reasoningEffort: 'auto', onUsage: (u) => usos.push(u), fetchImpl,
    });
    return { model, enviados };
  };

  it('la pasada previa va sin herramientas y con esfuerzo bajo: existe para ser barata', async () => {
    const usos: ModelTurnUsage[] = [];
    const { model, enviados } = conJuez('high', usos);
    await model.decide(contexto, new ContadorToolbox());

    expect(enviados[0]?.['tools']).toBeUndefined();
    // `minimal` y no `low`: medido contra la API, clasifica mejor y gasta cero razonamiento.
    expect(enviados[0]?.['reasoning_effort']).toBe('minimal');
  });

  it('y el turno de verdad se pide con lo que ella dijo', async () => {
    // `minimal` no entra aquí: el juez lo puede decir, pero el turno no baja de `low`. Eso tiene
    // su propia prueba, con el motivo medido.
    for (const nivel of REASONING_EFFORTS.filter((level) => level !== 'minimal')) {
      const usos: ModelTurnUsage[] = [];
      const { model, enviados } = conJuez(nivel, usos);
      await model.decide(contexto, new ContadorToolbox());

      expect(enviados[1]?.['reasoning_effort']).toBe(nivel);
      expect(usos.at(-1)?.effort).toBe(nivel);
    }
  });

  it('si la pasada previa contesta cualquier cosa, se piensa lo normal en vez de romperse', async () => {
    const usos: ModelTurnUsage[] = [];
    const { model, enviados } = conJuez('no tengo ni idea', usos);
    const decision = await model.decide(contexto, new ContadorToolbox());

    expect(decision.kind).toBe('finish');
    expect(enviados[1]?.['reasoning_effort']).toBe('medium');
  });
});

/**
 * El guionizado dice el esfuerzo para que el stack de desarrollo pueda enseñarlo.
 *
 * Sin esto se levanta el producto entero y el indicador de la cabecera no se ve nunca: el mismo
 * agujero que tenía `present` antes de que el guion supiera presentar.
 */
describe('ESFUERZO · el stack de desarrollo también puede enseñarlo', () => {
  const conNota = () => {
    const notas: string[] = [];
    const caja = new ContadorToolbox() as ContadorToolbox & { noteEffort(e: string): void };
    caja.noteEffort = (effort: string): void => { notas.push(effort); };
    return { caja, notas };
  };

  it('sale de lo que se pide, así que cambia entre una pregunta y otra', async () => {
    const corto = conNota();
    await new ScriptedModel().decide({ ...contexto, objective: 'hola' }, corto.caja);
    const largo = conNota();
    await new ScriptedModel().decide({
      ...contexto,
      objective: 'compara el disco y la memoria de todas las máquinas de la flota y dime cuál está peor y por qué',
    }, largo.caja);

    expect(corto.notas).toEqual(['minimal']);
    expect(largo.notas).toEqual(['high']);
  });

  it('y se puede forzar uno concreto para ver la pantalla en cada estado', async () => {
    const { caja, notas } = conNota();
    await new ScriptedModel().decide({ ...contexto, objective: 'lo que sea @@effort:medium' }, caja);

    expect(notas).toEqual(['medium']);
  });
});

describe('ESFUERZO · `minimal` sirve para juzgar, no para contestar', () => {
  it('el juez puede decir minimal, pero el turno no baja de low', async () => {
    const toolbox = new ContadorToolbox();
    let primera = true;
    const enviados: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      enviados.push(JSON.parse(init.body) as Record<string, unknown>);
      const message = primera
        ? { content: 'minimal' }
        : { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'finish', arguments: '{}' } }] };
      primera = false;
      const payload = { choices: [{ message }] };
      return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
    }) as unknown as FetchLike;
    const model = new OpenAiCompatibleModel({
      apiKey: 'k', baseUrl: 'https://api.test', model: 'm', reasoningEffort: 'auto', fetchImpl,
    });

    await model.decide({ ...contexto, objective: 'gracias!' }, toolbox);

    /*
     * Medido en producción: con el turno en `minimal`, a «hola» contestó «¿qué quieres hacer con
     * las workspaces listadas?». Sin deliberar nada se agarra a lo primero del contexto en vez de
     * componer una frase. Clasificar es reconocer; contestar es componer.
     */
    expect(enviados[0]?.['reasoning_effort']).toBe('minimal');
    // Se compone con `low`…
    expect(enviados[1]?.['reasoning_effort']).toBe('low');
    // …y sin nada con lo que irse por las ramas: un saludo no gasta ni una consulta.
    expect(toolbox.calls).toEqual(['finish']);
  });
});

describe('R-16 · lo que no se puede pintar no llega a pintarse', () => {
  const tabla = (cuerpo: unknown): ReturnType<typeof validateBody> =>
    validateBody('table', JSON.stringify(cuerpo));

  it('un `label` que no es texto se rechaza aquí, no en el navegador', () => {
    // El mensaje ya prometía comprobar `label` y sólo miraba `key`. React no sabe pintar un objeto:
    // llegaba hasta la pantalla y se la llevaba entera.
    const fallo = tabla({
      columns: [{ key: 'host', label: { es: 'Máquina' } }],
      rows: [{ host: 'zeus' }],
    });
    expect(fallo?.code).toBe('BAD_INPUT');
    expect(fallo?.message).toContain('las dos de texto');
  });

  it('una celda con un objeto dentro dice qué celda y qué hacer', () => {
    /*
     * Es lo que hace el modelo cuando una capacidad devuelve `{used, total}`: mete el objeto en la
     * celda en vez de elegir un número. Lo que cierra el bucle no es el rechazo, es que el mensaje
     * diga qué fila, qué columna y cuál es la salida.
     */
    const fallo = tabla({
      columns: [{ key: 'host', label: 'Máquina' }, { key: 'disco', label: 'Disco' }],
      rows: [{ host: 'zeus', disco: { used: 40, total: 100 } }],
    });
    expect(fallo?.code).toBe('BAD_INPUT');
    expect(fallo?.message).toContain('`disco`');
    expect(fallo?.message).toContain('fila 1');
    expect(fallo?.hint).toContain('elige el campo');
  });

  it('lo que sí se puede escribir sigue pasando', () => {
    // La otra mitad: un validador que rechazara de más rompería las tablas buenas, y `null` es un
    // valor legítimo —«no se sabe»— que no se puede confundir con un objeto.
    expect(tabla({
      columns: [{ key: 'host', label: 'Máquina' }, { key: 'libre', label: 'Libre' }],
      rows: [{ host: 'zeus', libre: 40 }, { host: 'goro2', libre: null }, { host: 'x', libre: true }],
    })).toBeNull();
  });
});

describe('un cuerpo con forma no es texto libre, y una tabla se escribe como se escribe', () => {
  it('`markdown` con una tabla dentro es una tabla, y pasa por su validación', () => {
    /*
     * Visto en producción: se le pidió una tabla **por escrito** y mandó `kind: "markdown"` con
     * `{"columns":…,"rows":…}` en el cuerpo. Como `markdown` es un tipo válido se devolvía tal cual,
     * no pasaba por `validateTable`, y el JSON crudo se guardaba y se pintaba como texto. `ok: true`
     * sin una queja: es peor que la confusión contraria, que al menos se resolvía.
     */
    const cuerpo = JSON.stringify({
      columns: [{ key: 'host', label: 'Máquina' }], rows: [{ host: 'zeus' }],
    });
    expect(resolveKind('markdown', cuerpo)).toBe('table');
  });

  it('pero un markdown de verdad sigue siendo markdown', () => {
    expect(resolveKind('markdown', '# Disco\n\nzeus tiene 40G libres.')).toBe('markdown');
    expect(resolveKind('markdown', '{"algo":1}')).toBe('markdown');
  });

  it('`json` no se reinterpreta: ahí el modelo sí está diciendo lo que quiere', () => {
    // Declarar `json` con datos dentro es coherente —«enséñalo como datos»— y adivinarle la
    // intención le quitaría una opción legítima.
    const cuerpo = JSON.stringify({ columns: ['a'], rows: [['x']] });
    expect(resolveKind('json', cuerpo)).toBe('json');
  });

  it('columnas de texto y filas por posición se normalizan en vez de rechazarse', () => {
    // Es cómo se escribe una tabla cuando no tienes el esquema delante, no un despiste. Rechazarlo
    // costaba una vuelta del turno para enseñar algo que ya nos había dicho entero.
    const natural = JSON.stringify({
      columns: ['maquina', 'estado'],
      rows: [['zeus', 'activa'], ['goro2', 'parada']],
    });
    const canonica = JSON.parse(normalizeTable(natural)) as {
      columns: Array<{ key: string; label: string }>;
      rows: Array<Record<string, unknown>>;
    };

    expect(canonica.columns).toEqual([
      { key: 'maquina', label: 'maquina' }, { key: 'estado', label: 'estado' },
    ]);
    expect(canonica.rows[0]).toEqual({ maquina: 'zeus', estado: 'activa' });
    // Y ya validada: el peor caso deja de ser «se guarda basura».
    expect(validateBody('table', normalizeTable(natural))).toBeNull();
  });

  it('lo que ya venía canónico no se toca', () => {
    const canonica = JSON.stringify({
      columns: [{ key: 'host', label: 'Máquina' }], rows: [{ host: 'zeus' }],
    });
    expect(JSON.parse(normalizeTable(canonica))).toEqual(JSON.parse(canonica));
  });
});

describe('la tolerancia no puede traer un silencio nuevo', () => {
  it('una fila corta se le devuelve al modelo, no se rellena con huecos', () => {
    /*
     * Rellenar con `null` lo que falta convertía «te faltan celdas» en una celda vacía y en
     * silencio, que es lo que fuimos a quitar con lo del `markdown`. Y era asimétrico: la misma
     * tabla escrita como objetos sí recibía el error.
     */
    const corta = normalizeTable(JSON.stringify({
      columns: ['maquina', 'estado', 'disco'],
      rows: [['zeus', 'activa', '40G'], ['goro2', 'parada']],
    }));
    const fallo = validateBody('table', corta);

    expect(fallo?.code).toBe('BAD_INPUT');
    expect(fallo?.message).toContain('fila 2');
    expect(fallo?.message).toContain('2 celdas');
    expect(fallo?.message).toContain('3 columnas');
  });

  it('y una fila con celdas de más tampoco se traga en silencio', () => {
    // El otro lado del mismo problema: sobran datos que no tienen columna donde ir.
    const larga = normalizeTable(JSON.stringify({
      columns: ['maquina', 'estado'],
      rows: [['zeus', 'activa', 'sobra']],
    }));
    expect(validateBody('table', larga)?.message).toContain('3 celdas');
  });
});

describe('la llave que no vimos, y la puerta por la que volvía', () => {
  it('`headers` es la lista de columnas, y se guarda como `columns`', () => {
    // Visto en producción, artifact `tf31jtvjt6r8zotyn`: `headers` con filas posicionales. No es un
    // caso raro, es **el** caso: así se escribe una tabla cuando no tienes el esquema delante.
    const natural = JSON.stringify({
      headers: ['Máquina', 'Disco'],
      rows: [['zeus', '900G'], ['goro2', '120G']],
    });
    expect(resolveKind('markdown', natural)).toBe('table');

    const canonica = JSON.parse(normalizeTable(natural)) as Record<string, unknown>;
    expect(canonica['columns']).toEqual([
      { key: 'Máquina', label: 'Máquina' }, { key: 'Disco', label: 'Disco' },
    ]);
    // Y no se queda la llave original al lado, que dejaría dos fuentes para lo mismo.
    expect(canonica['headers']).toBeUndefined();
    expect(validateBody('table', normalizeTable(natural))).toBeNull();
  });

  it('un markdown que es JSON se rechaza, se llame como se llame la llave', () => {
    /*
     * Esto es lo que cierra la familia y no la lista de sinónimos. `columns` se arregló al verlo y
     * `headers` estaba a un sinónimo; `cols`, `fields` o `data` están a otro. Sin esta comprobación,
     * cada llave nueva volvía a guardar el JSON crudo y a pintarlo como párrafo, con `ok: true`.
     */
    for (const llave of ['cols', 'fields', 'data', 'columnas']) {
      const cuerpo = JSON.stringify({ [llave]: ['a'], rows: [['x']] });
      const fallo = validateBody('markdown', cuerpo);
      expect(fallo?.code, `con la llave \`${llave}\``).toBe('BAD_INPUT');
      expect(fallo?.hint).toContain('kind: "table"');
    }
  });

  it('pero un markdown de verdad no se toca, ni con JSON dentro de una valla', () => {
    // Un fragmento dentro de markdown va en una valla y no parsea, así que esto no se lleva por
    // delante lo bueno.
    expect(validateBody('markdown', '# Disco\n\n```json\n{"a":1}\n```')).toBeNull();
    expect(validateBody('markdown', 'zeus tiene 40G libres.')).toBeNull();
    // Un número o una cadena sueltos parsean como JSON y siguen siendo texto: no se rechazan.
    expect(validateBody('markdown', '42')).toBeNull();
  });
});

describe('un gráfico escrito en el dialecto que existe en el mundo', () => {
  const valida = (cuerpo: string): ReturnType<typeof validateBody> =>
    validateBody('chart', normalizeChart(cuerpo));

  it('Chart.js se traduce en vez de rechazarse cuatro veces', () => {
    // El primer intento medido en producción, literal. Le costó cuatro vueltas llegar a `slices`,
    // y la última se quedó sin margen para redactar la respuesta.
    const chartjs = JSON.stringify({
      type: 'pie',
      data: { labels: ['zeus', 'goro2'], datasets: [{ data: [5, 3] }] },
      options: { responsive: true },
    });
    const traducido = JSON.parse(normalizeChart(chartjs)) as Record<string, unknown>;

    expect(traducido['shape']).toBe('donut');
    expect(traducido['slices']).toEqual([
      { key: 'zeus', label: 'zeus', value: 5 }, { key: 'goro2', label: 'goro2', value: 3 },
    ]);
    expect(valida(chartjs)).toBeNull();
  });

  it('las barras también, y `bar` es `bars`', () => {
    const chartjs = JSON.stringify({
      type: 'bar', data: { labels: ['a', 'b'], datasets: [{ data: [1, 2] }] },
    });
    expect(JSON.parse(normalizeChart(chartjs))).toMatchObject({ shape: 'bars' });
    expect(valida(chartjs)).toBeNull();
  });

  it('las porciones metidas un nivel adentro se sacan: sabía la palabra, no dónde iba', () => {
    // El tercer intento medido: `slices` dentro de `data`.
    const dentro = JSON.stringify({
      shape: 'donut', data: { labels: ['zeus'], slices: [{ label: 'zeus', value: 5 }] },
    });
    expect(valida(dentro)).toBeNull();
  });

  it('lo que ya venía bien no se toca', () => {
    const bueno = JSON.stringify({ shape: 'meter', label: 'Disco', value: 60, max: 100 });
    expect(JSON.parse(normalizeChart(bueno))).toEqual(JSON.parse(bueno));
    expect(valida(bueno)).toBeNull();
  });
});
