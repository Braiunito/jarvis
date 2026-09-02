/**
 * El modelo del Assistant.
 *
 * El modelo **propone**; el estado lo posee el core. Por eso la interfaz no es un tool loop
 * abierto sino una decisión por turno: leer el contexto que el core arma, devolver la siguiente
 * acción, y volver a casa. Un plan que espera cuatro horas a que termine un run no mantiene nada
 * abierto mientras tanto.
 *
 * La credencial vive aquí, en el core: el navegador no la ve nunca (ADR-001).
 */
import type { PermissionProfile } from '@jarvis/contracts';

export interface PlanContext {
  objective: string;
  workspace: { id: string; host: string; provider: string; sessionId: string; cwd: string | null };
  /** Resúmenes de lo ya hecho, nunca los buffers enteros. */
  history: Array<{ ordinal: number; kind: string; title: string; status: string; summary: string | null }>;
  /** Lo que dijo la persona cuando se le preguntó algo. */
  pendingInput: string | null;
}

export type AssistantDecision =
  | { kind: 'run'; title: string; prompt: string; permissionProfile: PermissionProfile; rationale: string }
  | { kind: 'approval'; title: string; actionType: string; summary: string; permissionProfile: PermissionProfile; prompt: string }
  | { kind: 'ask'; title: string; question: string }
  | { kind: 'finish'; summary: string };

export interface AssistantModel {
  readonly id: string;
  decide(context: PlanContext): Promise<AssistantDecision>;
}

/**
 * Un modelo guionizado, para desarrollo y para los tests.
 *
 * No pretende ser listo: pretende ser **determinista**, que es lo que hace falta para probar que
 * un plan sobrevive a un reinicio sin depender de la red ni de una factura.
 */
export class ScriptedModel implements AssistantModel {
  readonly id = 'scripted';
  readonly #maxSteps: number;

  constructor({ maxSteps = 2 }: { maxSteps?: number } = {}) {
    this.#maxSteps = maxSteps;
  }

  async decide(context: PlanContext): Promise<AssistantDecision> {
    const done = context.history.filter((step) => step.status === 'completed');
    const runs = done.filter((step) => step.kind === 'run');
    // Se mira todo el historial, no sólo lo completado: pedir permiso dos veces por lo mismo es
    // exactamente lo que convierte una aprobación en un trámite que la gente aprueba sin leer.
    const askedForApproval = context.history.some((step) => step.kind === 'approval');

    if (context.objective.includes('@@approval') && !askedForApproval) {
      return {
        kind: 'approval',
        title: 'Confirmar la acción con efectos',
        actionType: 'run',
        summary: `Ejecutar el objetivo con permiso de escritura: ${context.objective.slice(0, 120)}`,
        permissionProfile: 'auto',
        prompt: `${context.objective}\n\n[aprobado por el operador]`,
      };
    }

    if (runs.length >= this.#maxSteps) {
      return {
        kind: 'finish',
        summary: `Objetivo trabajado en ${runs.length} pasos: ${runs.map((step) => step.title).join('; ')}.`,
      };
    }

    return {
      kind: 'run',
      title: runs.length === 0 ? 'Reunir contexto' : 'Proponer el arreglo',
      prompt: runs.length === 0
        ? `${context.objective}\n\n[jarvis] Paso 1: mira el estado actual y resume lo que encuentres.`
        : `${context.objective}\n\n[jarvis] Paso 2: con lo anterior, propón el cambio concreto.`,
      permissionProfile: 'safe',
      rationale: runs.length === 0 ? 'hace falta leer antes de tocar' : 'ya hay contexto suficiente',
    };
  }
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/**
 * El modelo de verdad, contra la Messages API.
 *
 * Las herramientas que se le ofrecen son exactamente las decisiones que el core sabe ejecutar:
 * el modelo no puede inventarse una acción que aquí no exista.
 */
export class AnthropicModel implements AssistantModel {
  readonly id: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #model: string;

  constructor({ apiKey, baseUrl, model }: { apiKey: string; baseUrl: string; model: string }) {
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#model = model;
    this.id = model;
  }

  async decide(context: PlanContext): Promise<AssistantDecision> {
    const tools = [
      {
        name: 'create_run',
        description: 'Ejecuta un trabajo en el agente de la sesión y espera su resultado.',
        input_schema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            prompt: { type: 'string' },
            permission_profile: { type: 'string', enum: ['safe', 'auto'] },
            rationale: { type: 'string' },
          },
          required: ['title', 'prompt', 'permission_profile'],
        },
      },
      {
        name: 'request_approval',
        description: 'Pide permiso a la persona antes de una acción con efectos.',
        input_schema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            summary: { type: 'string' },
            prompt: { type: 'string' },
            permission_profile: { type: 'string', enum: ['auto', 'yolo'] },
          },
          required: ['title', 'summary', 'prompt', 'permission_profile'],
        },
      },
      {
        name: 'ask_human',
        description: 'Pregunta algo que sólo la persona puede decidir.',
        input_schema: {
          type: 'object',
          properties: { title: { type: 'string' }, question: { type: 'string' } },
          required: ['title', 'question'],
        },
      },
      {
        name: 'finish',
        description: 'Cierra el plan con una síntesis de lo hecho.',
        input_schema: {
          type: 'object',
          properties: { summary: { type: 'string' } },
          required: ['summary'],
        },
      },
    ];

    const response = await fetch(`${this.#baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.#apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.#model,
        max_tokens: 2048,
        tools,
        tool_choice: { type: 'any' },
        system: 'Eres el coordinador de Jarvis, una consola de agentes sobre un bastión. '
          + 'Propones el siguiente paso; el servidor lo ejecuta y guarda el estado. '
          + 'Prefiere leer antes de escribir y pide aprobación antes de cualquier acción con efectos.',
        messages: [{ role: 'user', content: JSON.stringify(context) }],
      }),
    });

    if (!response.ok) {
      throw new Error(`the model answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    const body = await response.json() as { content?: AnthropicContentBlock[] };
    const call = body.content?.find((block) => block.type === 'tool_use');
    if (!call?.name) {
      const text = body.content?.find((block) => block.type === 'text')?.text ?? 'sin respuesta';
      return { kind: 'finish', summary: text.slice(0, 2000) };
    }
    const input = (call.input ?? {}) as Record<string, string>;
    switch (call.name) {
      case 'create_run':
        return {
          kind: 'run',
          title: input['title'] ?? 'paso',
          prompt: input['prompt'] ?? '',
          permissionProfile: (input['permission_profile'] as PermissionProfile) ?? 'safe',
          rationale: input['rationale'] ?? '',
        };
      case 'request_approval':
        return {
          kind: 'approval',
          title: input['title'] ?? 'aprobación',
          actionType: 'run',
          summary: input['summary'] ?? '',
          permissionProfile: (input['permission_profile'] as PermissionProfile) ?? 'auto',
          prompt: input['prompt'] ?? '',
        };
      case 'ask_human':
        return { kind: 'ask', title: input['title'] ?? 'pregunta', question: input['question'] ?? '' };
      default:
        return { kind: 'finish', summary: input['summary'] ?? 'terminado' };
    }
  }
}
