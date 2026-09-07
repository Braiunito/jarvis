/**
 * No se cierra un plan firmado que va por la mitad.
 *
 * Un workflow se firma entero: siete pasos, un sobre y una tarjeta. Lo que el motor no tenía era
 * una condición para acabar — `finish` no es una herramienta que se pueda retirar del catálogo,
 * es lo que pasa cuando el modelo contesta con texto en vez de llamar a nada, así que lo único
 * que se puede hacer es no aceptarla a la primera.
 *
 * Medido en producción el 2026-09-07, plan `poamjnrb2pmzraiba`: un workflow de siete pasos hizo el
 * primero —inventario de `/var/log` en zeus, datos buenos—, escribió en su propia síntesis
 * «Siguiente paso recomendado: 2. Auditar tareas nocturnas» y cerró el plan con seis pasos sin
 * tocar. Tenía el plan delante en el prompt. No faltaba el dato: faltaba la condición.
 *
 * La economía es la misma que la del desmentido del «mostrado», que es de donde sale la forma:
 * **una sola vuelta**, y si insiste se cierra con lo que dijo. Un plan a medias es mejor que un
 * bucle.
 */
import { describe, expect, it } from 'vitest';
import type {
  AssistantToolbox, ChatRef, PlanContext, ToolDefinition, ToolOutcome,
} from '../src/assistant/types.js';
import { OpenAiCompatibleModel, type FetchLike } from '../src/assistant/model.js';

/** Un toolbox que no ofrece nada: aquí sólo se mira qué hace el modelo cuando contesta con texto. */
class ToolboxMudo implements AssistantToolbox {
  readonly terminalOffer = null;
  readonly refs: ChatRef[] = [];
  readonly repeats = 0;
  readonly presented = 0;
  readonly observations = 0;
  readonly spent = false;

  definitions(): ToolDefinition[] {
    return [];
  }

  async invoke(): Promise<ToolOutcome> {
    return { type: 'observation', content: 'nada' };
  }
}

/** Habla por turnos: cada respuesta es texto puro, que es como el modelo pide terminar. */
const conModelo = (respuestas: string[]): { model: OpenAiCompatibleModel; vueltas: () => number } => {
  let n = 0;
  const fetchImpl: FetchLike = async () => {
    const content = respuestas[Math.min(n, respuestas.length - 1)] ?? '';
    n += 1;
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return {
    model: new OpenAiCompatibleModel({
      apiKey: 'k', baseUrl: 'https://api.test', model: 'nano', fetchImpl, maxToolCalls: 3,
    }),
    vueltas: () => n,
  };
};

/** Un plan de tres pasos con los que se digan ya dados. */
const contexto = (dados: number): PlanContext => ({
  objective: 'averiguar por qué se llena el disco',
  history: [], pendingInput: null, pendingApprovals: [],
  limits: { stepsUsed: dados, maxSteps: 3, maxToolCalls: 3, maxToolOutputBytes: 1000 },
  envelope: {
    hosts: ['bastion'], maxSteps: 3, maxRuns: 3,
    highestPermissionProfile: 'safe', writes: false, capabilities: [],
  },
  plannedSteps: [
    { ordinal: 0, title: 'Mirar el disco', intent: 'ver cuánto queda', expects: 'los bytes', unknowns: [], writes: false, state: dados > 0 ? 'done' : 'current' },
    { ordinal: 1, title: 'Auditar tareas nocturnas', intent: 'ver qué corre de noche', expects: 'la lista', unknowns: [], writes: false, state: dados > 1 ? 'done' : dados === 1 ? 'current' : 'pending' },
    { ordinal: 2, title: 'Proponer mitigaciones', intent: 'decidir qué hacer', expects: 'el plan', unknowns: [], writes: false, state: dados > 2 ? 'done' : dados === 2 ? 'current' : 'pending' },
  ],
});

describe('no se cierra un plan firmado que va por la mitad', () => {
  it('se le devuelve una vuelta diciendo cuántos quedan y cuál es el siguiente', async () => {
    const { model, vueltas } = conModelo([
      'Inventario del disco completo. Siguiente paso recomendado: 2. Auditar tareas nocturnas.',
      'Tareas nocturnas auditadas y mitigaciones propuestas: rotación de logs y retención.',
    ]);
    const decision = await model.decide(contexto(1), new ToolboxMudo());

    // Dos vueltas: la primera se le devolvió, la segunda se publica.
    expect(vueltas()).toBe(2);
    expect(decision).toMatchObject({ kind: 'finish' });
    expect((decision as { summary: string }).summary).toContain('mitigaciones');
  });

  it('y si insiste se cierra con lo que dijo: un plan a medias es mejor que un bucle', async () => {
    const { model, vueltas } = conModelo([
      'He terminado con el primer paso y no voy a seguir.',
    ]);
    const decision = await model.decide(contexto(1), new ToolboxMudo());

    // Dos vueltas y para: la guarda se gasta una vez, como la del «mostrado».
    expect(vueltas()).toBe(2);
    expect((decision as { summary: string }).summary).toContain('no voy a seguir');
  });

  it('cerrar el último paso no es dejar el plan a medias', async () => {
    /*
     * La otra mitad, y la que impide que la guarda se coma el final legítimo: cuando sólo queda un
     * paso por atar, el `finish` **es** ese paso — el plan termina atando su síntesis. Sin esta
     * distinción, ningún workflow podría acabar nunca.
     */
    const { model, vueltas } = conModelo(['Mitigaciones propuestas: rotación y retención.']);
    const decision = await model.decide(contexto(2), new ToolboxMudo());

    expect(vueltas()).toBe(1);
    expect((decision as { summary: string }).summary).toContain('Mitigaciones');
  });

  it('un plan sin sobre no se toca: los de siempre siguen cerrando cuando quieren', async () => {
    // Sin `plannedSteps` no hay plan firmado que proteger, y meter la guarda ahí sería inventarse
    // pasos que nadie escribió.
    const { model, vueltas } = conModelo(['Ya está: son cuatro repos y todos al día.']);
    const decision = await model.decide({
      objective: 'mira los repos', history: [], pendingInput: null, pendingApprovals: [],
      limits: { stepsUsed: 0, maxSteps: 3, maxToolCalls: 3, maxToolOutputBytes: 1000 },
    }, new ToolboxMudo());

    expect(vueltas()).toBe(1);
    expect((decision as { summary: string }).summary).toContain('cuatro repos');
  });
});
