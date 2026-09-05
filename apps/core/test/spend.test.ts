/**
 * El contador de gasto.
 *
 * Lo que se prueba es la aritmética y las tres formas de mentir que hay que evitar: contar dos
 * veces los tokens cacheados, inventar un precio para un modelo sin tarifa, y prometer un resto
 * sobre un presupuesto que nadie declaró.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/platform/clock.js';
import { migrate, openDatabase } from '../src/platform/db.js';
import { parseModelPrices, SpendService } from '../src/spend/service.js';

const NOW = '2026-09-05T12:00:00.000Z';
const PRECIOS = parseModelPrices('gpt-5-nano:0.05/0.005/0.40,gpt-5:1.25/0.125/10.00');

const build = (extra: Record<string, unknown> = {}): SpendService => {
  const db = openDatabase({ path: ':memory:' });
  migrate(db);
  return new SpendService({ db, clock: fixedClock(NOW), prices: PRECIOS, ...extra });
};

describe('las tarifas, tal como se escriben en el entorno', () => {
  it('lee modelo:entrada/caché/salida y aguanta la basura', () => {
    const precios = parseModelPrices(' gpt-5-nano:0.05/0.005/0.40 , roto , otro:1/2 , gpt-5:1.25/0.125/10 ');
    expect(precios.map((p) => p.model)).toEqual(['gpt-5-nano', 'gpt-5']);
    expect(precios[0]).toEqual({ model: 'gpt-5-nano', input: 0.05, cached: 0.005, output: 0.40 });
  });

  it('descarta lo que no son tres números, en vez de contar de menos', () => {
    expect(parseModelPrices('gpt-5-nano:0.05/x/0.40')).toEqual([]);
  });
});

describe('cuánto costó', () => {
  let spend: SpendService;
  beforeEach(() => { spend = build(); });

  it('los tokens cacheados se descuentan del prompt, no se suman aparte', () => {
    // 1000 de prompt de los cuales 800 venían de caché: se cobran 200 frescos y 800 cacheados.
    spend.record({ model: 'gpt-5-nano', source: 'local', promptTokens: 1000, cachedTokens: 800, completionTokens: 100 });
    const esperado = (200 * 0.05 + 800 * 0.005 + 100 * 0.40) / 1_000_000;
    expect(spend.summary().spentUsd).toBeCloseTo(esperado, 12);
  });

  it('sumarlos sin restar casi duplicaría la factura de una conversación', () => {
    // El catálogo de herramientas no cambia entre vueltas, así que la mayor parte del prompt viene
    // de caché. Contarlo dos veces es el error que hace que el gasto parezca el doble.
    spend.record({ model: 'gpt-5-nano', source: 'local', promptTokens: 4000, cachedTokens: 3800, completionTokens: 50 });
    const ingenuo = (4000 * 0.05 + 3800 * 0.005 + 50 * 0.40) / 1_000_000;
    expect(spend.summary().spentUsd).toBeLessThan(ingenuo);
  });

  it('escalar sale mucho más caro, y el desglose lo enseña', () => {
    spend.record({ model: 'gpt-5-nano', source: 'local', promptTokens: 4000, cachedTokens: 0, completionTokens: 300 });
    spend.record({ model: 'gpt-5', source: 'cloud', promptTokens: 4000, cachedTokens: 0, completionTokens: 300 });
    const [caro, barato] = spend.summary().byModel;

    expect(caro?.model).toBe('gpt-5');
    expect(barato?.model).toBe('gpt-5-nano');
    expect((caro?.usd as number) / (barato?.usd as number)).toBeGreaterThan(20);
  });

  it('un modelo sin tarifa no se cuenta como cero: se dice que falta', () => {
    spend.record({ model: 'modelo-raro', source: 'local', promptTokens: 1000, cachedTokens: 0, completionTokens: 100 });
    const resumen = spend.summary();
    // Inventarle un precio sería peor; darlo por gratis, también.
    expect(resumen.unpriced).toEqual(['modelo-raro']);
    expect(resumen.byModel[0]?.usd).toBeNull();
    expect(resumen.byModel[0]?.completionTokens).toBe(100);
  });
});

describe('cuánto queda', () => {
  const gastar = (spend: SpendService, veces: number): void => {
    for (let i = 0; i < veces; i += 1) {
      spend.record({ model: 'gpt-5-nano', source: 'local', promptTokens: 4000, cachedTokens: 0, completionTokens: 300 });
    }
  };

  it('sin presupuesto declarado no se promete ningún resto', () => {
    const spend = build();
    gastar(spend, 10);
    const resumen = spend.summary();
    // Un resto calculado sobre un presupuesto inventado es peor que no dar ninguno.
    expect(resumen.budgetUsd).toBeNull();
    expect(resumen.remainingUsd).toBeNull();
    expect(resumen.remainingTurns).toBeNull();
    expect(resumen.spentUsd).toBeGreaterThan(0);
  });

  it('con presupuesto, el resto sale de la media real de las vueltas', () => {
    const spend = build({ budgetUsd: 10 });
    gastar(spend, 10);
    const resumen = spend.summary();

    expect(resumen.turns).toBe(10);
    expect(resumen.avgTurnUsd).toBeCloseTo(resumen.spentUsd / 10, 12);
    expect(resumen.remainingUsd).toBeCloseTo(10 - resumen.spentUsd, 10);
    expect(resumen.remainingTurns).toBe(Math.floor((resumen.remainingUsd as number) / (resumen.avgTurnUsd as number)));
  });

  it('con dos vueltas medidas no se estima nada: sería un número inventado con aspecto de dato', () => {
    const spend = build({ budgetUsd: 10 });
    gastar(spend, 2);
    expect(spend.summary().avgTurnUsd).toBeNull();
    expect(spend.summary().remainingTurns).toBeNull();
  });

  it('el resto no baja de cero aunque se pase del presupuesto', () => {
    const spend = build({ budgetUsd: 0.000001 });
    gastar(spend, 10);
    expect(spend.summary().remainingUsd).toBe(0);
  });
});
