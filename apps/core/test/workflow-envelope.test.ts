/**
 * El sobre: lo que se puede firmar y lo que no cabe dentro de lo firmado.
 *
 * `plans/workflow.ts` se escribió puro justamente para poder probarlo sin levantar nada, y luego
 * no se probó. Lo encontró jarvis-f9 aplicando el método de buscar por conducta y no por nombre:
 * hay pruebas de integración que lo ejercitan de paso, y ninguna unitaria que lo mire de frente.
 *
 * Por qué importa más que una cobertura normal: **`buildEnvelope` decide qué perímetro se puede
 * firmar**. Si concede de más, todo lo que hay detrás —`outsideEnvelope`, el digest, la tarjeta que
 * lee una persona— comprueba correctamente contra un sobre que no debía existir. Es la clase de
 * fallo en que la maquinaria entera funciona y aun así se ejecuta lo que nadie autorizó.
 */
import { describe, expect, it } from 'vitest';
import type { WorkflowEnvelope } from '@jarvis/contracts';
import {
  buildEnvelope, digestOf, outsideEnvelope,
  type DraftWorkflow, type EnvelopeLimits,
} from '../src/plans/workflow.js';

const LIMITES: EnvelopeLimits = { allowedHosts: ['zeus', 'bastion'], maxSteps: 8 };

const borrador = (extra: Partial<DraftWorkflow> = {}): DraftWorkflow => ({
  objective: 'averiguar por qué se llena el disco',
  steps: [{ title: 'Mirar el disco', intent: 'ver qué ocupa', expects: 'las rutas más grandes' }],
  highestPermissionProfile: 'safe',
  ...extra,
});

/** Lo que devuelve `buildEnvelope` cuando dice que no. */
const rechazo = (result: ReturnType<typeof buildEnvelope>): { message: string; hint?: string } => {
  expect(result.ok).toBe(false);
  return result as { ok: false; message: string; hint?: string };
};

const firmado = (result: ReturnType<typeof buildEnvelope>): WorkflowEnvelope => {
  expect(result.ok).toBe(true);
  return (result as { ok: true; envelope: WorkflowEnvelope }).envelope;
};

describe('SOBRE · lo que la casa deja firmar', () => {
  it('una máquina que no está en la lista de la casa no se firma, y se dicen cuáles hay', () => {
    const error = rechazo(buildEnvelope(borrador({ hosts: ['zeus', 'la-de-un-cliente'] }), LIMITES));

    /*
     * Rechaza, **no recorta**. Recortar en silencio sería peor que fallar: el modelo pidió tocar
     * una máquina, la persona firmaría un sobre que no la menciona, y nadie sabría que la petición
     * original era más ancha que lo autorizado.
     */
    expect(error.message).toContain('la-de-un-cliente');
    expect(error.message).not.toContain('zeus,');
    expect(error.hint).toContain('zeus');
    expect(error.hint).toContain('bastion');
  });

  it('`yolo` no se firma nunca, por muchos pasos que traiga el borrador', () => {
    const error = rechazo(buildEnvelope(borrador({ highestPermissionProfile: 'yolo' }), LIMITES));

    // No es prudencia genérica: lo que aporta la ruta de aprobación no es el perfil, es la tarjeta
    // que enseña qué se va a ejecutar y caduca. Un sobre firmado una vez no concede eso para media
    // hora de pasos que todavía no existen.
    expect(error.message).toContain('sin restricciones');
    expect(error.hint).toContain('safe');
  });

  it('más pasos de los que el motor admite no se firman, y se dicen los dos números', () => {
    const steps = Array.from({ length: 9 }, (_, i) => ({
      title: `Paso ${i}`, intent: 'algo', expects: 'algo',
    }));

    const error = rechazo(buildEnvelope(borrador({ steps }), LIMITES));

    expect(error.message).toContain('9');
    expect(error.message).toContain('8');
  });

  it('sin objetivo o sin pasos no hay plan que firmar', () => {
    expect(rechazo(buildEnvelope(borrador({ objective: '   ' }), LIMITES)).message).toContain('objetivo');
    expect(rechazo(buildEnvelope(borrador({ steps: [] }), LIMITES)).message).toContain('sin pasos');
  });

  it('un paso que escribe convierte el sobre en un sobre que escribe, aunque el perfil sea `safe`', () => {
    const envelope = firmado(buildEnvelope(borrador({
      highestPermissionProfile: 'safe',
      steps: [
        { title: 'Mirar', intent: 'ver', expects: 'lo que hay' },
        { title: 'Rotar el log', intent: 'liberar espacio', expects: 'sitio libre', writes: true },
      ],
    }), LIMITES));

    /*
     * Es la mitad que se olvida: declarar `safe` y luego traer un paso que modifica es exactamente
     * la forma en que un perímetro se queda corto sin que nadie lo note. Se toma el máximo de las
     * dos señales, así que basta con una para que la tarjeta diga que esto toca la máquina.
     */
    expect(envelope.writes).toBe(true);
  });

  it('los hosts y las capacidades repetidos se firman una sola vez', () => {
    const envelope = firmado(buildEnvelope(borrador({
      hosts: ['zeus', 'zeus', 'bastion'],
      capabilities: ['zeus.disk_usage', 'zeus.disk_usage'],
    }), LIMITES));

    expect(envelope.hosts).toEqual(['zeus', 'bastion']);
    expect(envelope.capabilities).toEqual(['zeus.disk_usage']);
  });
});

/**
 * La rama de capacidades de `outsideEnvelope`, que hasta hoy no la ejercitaba nada.
 *
 * Las pruebas del motor sólo la alcanzan con `run`, porque el motor rechaza las capacidades antes
 * de llegar aquí. O sea que estaba escrita y **nunca se había ejecutado**: eso no es cobertura que
 * falta, es código del que no se sabe si funciona. El día que un workflow pueda usar capacidades,
 * se estrena sin red.
 */
describe('SOBRE · una capacidad que no se firmó no pasa', () => {
  const envelope: WorkflowEnvelope = {
    hosts: ['zeus'],
    maxSteps: 4,
    maxRuns: 2,
    highestPermissionProfile: 'safe',
    writes: false,
    capabilities: ['zeus.disk_usage'],
  };

  it('la firmada cabe', () => {
    const fuera = outsideEnvelope(envelope, { kind: 'capability', capability: 'zeus.disk_usage' },
      { steps: 1, runs: 0 });

    expect(fuera).toBeNull();
  });

  it('una que no se firmó se explica diciendo cuál se pidió y cuáles se autorizaron', () => {
    const fuera = outsideEnvelope(envelope, { kind: 'capability', capability: 'zeus.stop_service' },
      { steps: 1, runs: 0 });

    // Lo que devuelve es la frase que va a leer una persona, no un código: quien mire la tarjeta
    // tiene que entender de un vistazo qué pidió el asistente y qué autorizó él.
    expect(fuera).toContain('zeus.stop_service');
    expect(fuera).toContain('zeus.disk_usage');
  });

  it('y si no se autorizó ninguna, se dice así en vez de enseñar una lista vacía', () => {
    const fuera = outsideEnvelope({ ...envelope, capabilities: [] },
      { kind: 'capability', capability: 'zeus.disk_usage' }, { steps: 1, runs: 0 });

    expect(fuera).toContain('no autorizaste ninguna capacidad');
  });

  it('el tope de pasos corta también una capacidad, no sólo un trabajo', () => {
    const fuera = outsideEnvelope(envelope, { kind: 'capability', capability: 'zeus.disk_usage' },
      { steps: 4, runs: 0 });

    // El tope se comprueba **antes** de mirar de qué tipo es la acción. Si estuviera dentro de la
    // rama de `run`, un workflow podría gastar pasos ilimitados mientras fueran capacidades.
    expect(fuera).toContain('paso 5');
    expect(fuera).toContain('4');
  });

  /*
   * El nombre tiene que ser **el mismo a los dos lados**, y hoy es fácil que no lo sea.
   *
   * Las capacidades reales son `servidor.herramienta` (`qualifiedToolName`), pero el sobre se
   * construye con lo que escribió el modelo, y a éste se le pedía «por su nombre» a secas: en
   * producción firmó `disk_usage` cuando la real es `zeus.disk_usage`. Hoy no rompe nada porque
   * esta rama no la alcanza el motor, y por eso mismo es una trampa: el día que se cablee,
   * rechazaría **todas** las capacidades del propio sobre que se acaba de firmar.
   *
   * Se fija el desajuste en vez de hacerlo tolerante a propósito. Aceptar el nombre corto haría que
   * un `otro-servidor.disk_usage` pasara por un `disk_usage` firmado, que es peor que el fallo.
   * Lo que se arregla es el origen: el esquema ahora pide el nombre completo.
   */
  it('el nombre corto no vale por el completo: se firma y se comprueba lo mismo', () => {
    const conCorto = { ...envelope, capabilities: ['disk_usage'] };

    expect(outsideEnvelope(conCorto, { kind: 'capability', capability: 'zeus.disk_usage' },
      { steps: 1, runs: 0 })).toContain('zeus.disk_usage');

    // Y al revés: firmado el completo, se acepta el completo. Es la pareja que tiene que cuadrar.
    expect(outsideEnvelope(envelope, { kind: 'capability', capability: 'zeus.disk_usage' },
      { steps: 1, runs: 0 })).toBeNull();
  });

  it('sin sobre no se comprueba nada, y eso es deliberado', () => {
    // Los planes anteriores a los workflows no tienen perímetro firmado. Aplicarles esto o pasaría
    // todo —y entonces no comprueba nada— o bloquearía todo. Lo que decide si hay comprobación es
    // tener sobre, no ser un plan.
    expect(outsideEnvelope(null, { kind: 'capability', capability: 'lo-que-sea' },
      { steps: 99, runs: 99 })).toBeNull();
  });
});

describe('SOBRE · la huella no cambia sola', () => {
  const base = {
    planId: 'p1',
    objective: 'averiguar por qué se llena el disco',
    envelope: {
      hosts: ['zeus'], maxSteps: 4, maxRuns: 2,
      highestPermissionProfile: 'safe' as const, writes: false,
      capabilities: ['zeus.disk_usage'],
    },
  };

  it('subir el permiso cambia la firma: es otro perímetro', () => {
    expect(digestOf({ ...base, envelope: { ...base.envelope, highestPermissionProfile: 'auto' } }))
      .not.toBe(digestOf(base));
  });

  it('añadir una máquina cambia la firma', () => {
    expect(digestOf({ ...base, envelope: { ...base.envelope, hosts: ['zeus', 'bastion'] } }))
      .not.toBe(digestOf(base));
  });

  it('calcularla dos veces sobre lo mismo da lo mismo', () => {
    // Un digest que cambia solo invalida su propia aprobación y hace pedir permiso otra vez sin
    // que nada haya cambiado, que es la forma de enseñar a la gente a firmar sin leer.
    expect(digestOf({ ...base, envelope: { ...base.envelope } })).toBe(digestOf(base));
  });
});
