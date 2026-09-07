/**
 * Lo que de verdad ocupa el contexto en el prompt, medido donde se consume.
 *
 * `#house()`, el sobre y los pasos previstos se calculan en tres sitios distintos y se juntan en
 * una sola cadena: `renderContext`. Ahí es donde se paga, y por eso se mide ahí y no sumando los
 * objetos — que es lo que haría creer que un campo «pequeño» es barato cuando se repite doce veces.
 *
 * Los topes son holgados a propósito. No están para cazar que alguien reescriba una frase, sino
 * para que **duplicar el contexto no pase inadvertido**: es la clase de cambio que no rompe nada,
 * no sale en ninguna prueba, y se paga en cada turno de cada conversación.
 */
import { describe, expect, it } from 'vitest';
import { renderContext } from '../src/assistant/model.js';

const relleno = (n: number, letra: string): string => letra.repeat(n);

const casa = {
  // Las seis de esta casa: el peor caso incluye decirle qué máquinas alcanza, que es lo que no
  // puede deducir de ninguna consulta.
  hosts: ['bastion', 'vultr', 'bevrim', 'goro1', 'goro2', 'goro3'],
  workspaces: Array.from({ length: 4 }, (_, i) => ({
    id: `w${i}`.padEnd(17, 'x'), title: relleno(60, 'W'), host: 'zeus', provider: 'claude',
  })),
  runs: Array.from({ length: 4 }, (_, i) => ({
    runId: `r${i}`.padEnd(17, 'x'), status: 'running', title: relleno(80, 'R'),
  })),
  workflows: Array.from({ length: 4 }, (_, i) => ({
    planId: `p${i}`.padEnd(17, 'x'), status: 'running', objective: relleno(80, 'P'), step: 2, steps: 7,
  })),
};

const limites = { stepsUsed: 9, maxSteps: 12, maxToolCalls: 12, maxToolOutputBytes: 60_000 };

describe('CONTEXTO · el peor caso cabe, y crecer se nota', () => {
  it('una conversación llena ronda los 1.700 tokens, no los diez mil', () => {
    const rendered = renderContext({
      objective: relleno(200, 'O'),
      pendingInput: null,
      pendingApprovals: [],
      history: [],
      house: casa,
      limits: limites,
      messages: Array.from({ length: 12 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user', text: relleno(400, 'M'),
      })),
    } as never);

    // Medido: 6.759 caracteres con la casa llena y los doce mensajes del historial. El tope deja
    // sitio para crecer y salta si algo se duplica.
    expect(rendered.length).toBeLessThan(10_000);
    // Y los planes vivos **están dentro**: se calculaban y no se escribían, así que el asistente
    // proponía otro plan en vez de mirar el que ya corría.
    expect(rendered).toContain('plan p0');
  });

  it('un plan avanzado cabe, y los pasos ya dados no se cuentan dos veces', () => {
    const previstos = Array.from({ length: 12 }, (_, i) => ({
      ordinal: i,
      title: relleno(60, 'T'),
      intent: relleno(120, 'I'),
      expects: relleno(120, 'E'),
      unknowns: [relleno(80, 'U'), relleno(80, 'V')],
      writes: true,
      state: (i < 9 ? 'done' : i === 9 ? 'current' : 'pending') as 'done' | 'current' | 'pending',
    }));

    const rendered = renderContext({
      objective: relleno(200, 'O'),
      pendingInput: null,
      pendingApprovals: [],
      house: casa,
      limits: limites,
      envelope: {
        hosts: ['zeus', 'bastion', 'vultr', 'bevrim', 'goro1', 'goro2'],
        maxSteps: 12, maxRuns: 12, highestPermissionProfile: 'auto', writes: true,
        capabilities: Array.from({ length: 11 }, (_, i) => `zeus.capacidad_numero_${i}`),
      },
      plannedSteps: previstos,
      history: Array.from({ length: 12 }, (_, i) => ({
        ordinal: i, kind: 'run', status: 'completed', title: relleno(60, 'H'),
        runId: 'r'.padEnd(17, 'x'), summary: relleno(1200, 'S'),
      })),
    } as never);

    /*
     * Medido: 20.277 caracteres (~5.100 tokens). Lo domina el historial —doce resúmenes de 1.200,
     * que es `MAX_STEP_OUTPUT_CHARS`—, y ahí el recorte por paso aguanta. Lo que **no** hay es tope
     * al número de pasos: el techo lo pone `maxSteps`, no ningún presupuesto de contexto, así que
     * subir `maxSteps` hace crecer esto en línea recta y sin avisar.
     */
    expect(rendered.length).toBeLessThan(26_000);

    // El paso que toca va entero, con sus incógnitas: es lo que hay que atar.
    expect(rendered).toContain('→ 10.');
    expect(rendered).toContain('por decidir');
    /*
     * Y los ya dados van en una línea. No es ahorro: lo que planeaban ya no importa —lo que pasó
     * está en «Pasos dados»— y repetir sus incógnitas invita a resolver otra vez lo ya resuelto.
     * Medido, esto quita 664 tokens de los 1.655 que costaba enseñarlo todo en detalle.
     */
    expect(rendered).toContain('✓ 1.');
    expect(rendered.split('\n').filter((line) => line.startsWith('✓ '))).toHaveLength(9);

    // El perímetro firmado llega al prompt: el modelo tiene que saber dentro de qué se mueve antes
    // de proponer, no después de que el core le devuelva una tarjeta.
    expect(rendered).toContain('puede modificar');
    expect(rendered).toContain('zeus.capacidad_numero_0');

    /*
     * Y cuántos quedan por atar. Medido contra producción: el modelo ató el primer paso, escribió
     * en su propia síntesis cuál era el siguiente, y cerró el plan en el mismo turno. Sabía cuál
     * seguía; lo que no sabía es qué pasa al terminar.
     */
    expect(rendered).toContain('Quedan 3 de 12 pasos del plan firmado sin atar');
    expect(rendered).toContain('cierra el plan ENTERO');
  });

  it('y cuando no queda ninguno por atar, no se le avisa de nada', () => {
    const rendered = renderContext({
      objective: 'ya está', pendingInput: null, pendingApprovals: [], history: [], limits: limites,
      plannedSteps: [{
        ordinal: 0, title: 'Único', intent: 'i', expects: 'e', unknowns: [], writes: false,
        state: 'done' as const,
      }],
    } as never);

    // Un aviso que sale siempre deja de leerse. Éste sólo aparece cuando hay algo que perder.
    expect(rendered).not.toContain('sin atar');
  });
});
