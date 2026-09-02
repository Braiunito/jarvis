/**
 * El modelo del Assistant.
 *
 * El modelo **propone**; el estado lo posee el core. Por eso la interfaz no es un tool loop
 * abierto sino una decisión por turno: leer el contexto que el core arma, mirar lo que haga falta
 * con las herramientas cortas, devolver la siguiente acción, y volver a casa. Un plan que espera
 * cuatro horas a que termine un run no mantiene nada abierto mientras tanto.
 *
 * Dentro de un turno sí hay un bucle, y es corto a propósito: las lecturas se resuelven en el
 * momento (índice, transcript, salud, trabajos) y la primera herramienta que decide lo cierra. El
 * presupuesto de lecturas es del core, no del modelo.
 *
 * La credencial vive aquí, en el core: el navegador no la ve nunca (ADR-001).
 */
import type {
  AssistantDecision, AssistantModel, AssistantToolbox, PlanContext, ToolDefinition,
} from './types.js';

export * from './types.js';

/**
 * Quién es y qué puede hacer.
 *
 * La parte de «ofrecer el siguiente paso» viene del asistente del stack anterior, donde se ganó a
 * base de uso: encontrar una sesión no le sirve de nada a nadie si no se ofrece además seguir
 * trabajando en ella, porque quien pregunta no sabe qué hay detrás de la interfaz y acaba copiando
 * identificadores a mano para pedir lo que se podía hacer en el mismo turno.
 */
export const SYSTEM_PROMPT = `Eres el coordinador de Jarvis, una consola de agentes de código sobre un bastión.

Cómo funciona esto:
· Tú propones un paso; el servidor lo ejecuta, lo persiste y te despierta con el resultado.
· Un trabajo puede durar horas y sobrevivir a reinicios. No esperes: encárgalo y cierra el turno.
· El destino y el permiso son parte de la acción, no un detalle: lo que se aprueba es exactamente
  lo que dice el resumen que se enseñó.

Cómo trabajar:
· Lee antes de tocar. Empieza en solo lectura y sube el permiso sólo cuando haga falta y esté
  aprobado.
· Usa las herramientas de consulta antes de suponer: el transcript de la sesión, los trabajos
  anteriores, la salud de la máquina. Suponer sale caro cuando al otro lado hay un servidor.
· Un paso por turno, con un motivo que se entienda. Nada de encadenar cinco acciones a ciegas.
· Cita la evidencia por su identificador de trabajo. No copies salidas enteras: la interfaz enlaza
  a lo completo y el contexto no es un sitio donde guardar buffers.
· Si una herramienta falla, di qué te faltó y propón cómo seguir, en vez de declarar que no puedes.

Al cerrar:
· La síntesis dice qué se hizo, qué se encontró y qué queda, en español y sin adornos.
· Ofrece el siguiente paso concreto, sacado de lo que de verdad puedes hacer ahora: continuar el
  trabajo en esa sesión, o dejar preparada una terminal viva para mirarlo en directo. Dos opciones,
  no un menú, y sólo las que puedas cumplir.`;

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

  async decide(context: PlanContext, toolbox?: AssistantToolbox): Promise<AssistantDecision> {
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

    // Un guion también sirve para ejercitar las herramientas: `@@tools` hace que el plan mire el
    // contexto de la sesión y deje ofrecida una terminal, sin red ni credencial.
    if (context.objective.includes('@@tools') && toolbox) {
      await toolbox.invoke('get_session_context', { last: 3 });
      await toolbox.invoke('open_terminal_offer', { reason: 'conviene mirarlo en vivo' });
    }

    // `@@ask` ejercita el camino humano: preguntar, dormir, y seguir con lo que contestaron. La
    // respuesta tiene que llegar al paso siguiente; si no llega, el plan pregunta al vacío.
    if (context.objective.includes('@@ask') && !context.history.some((step) => step.kind === 'input')) {
      return { kind: 'ask', title: 'Dónde se aplica', question: '¿lo aplico en staging o en producción?' };
    }

    if (runs.length >= this.#maxSteps) {
      return {
        kind: 'finish',
        summary: `Objetivo trabajado en ${runs.length} pasos: ${runs.map((step) => step.title).join('; ')}.`,
        evidenceRunIds: runs.map((step) => step.runId).filter((id): id is string => id !== null),
      };
    }

    return {
      kind: 'run',
      title: context.pendingInput
        ? `Trabajar en ${context.pendingInput}`
        : runs.length === 0 ? 'Reunir contexto' : 'Proponer el arreglo',
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
  id?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface AnthropicModelOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Tope de lecturas por turno. Un coordinador que investiga sin fin no coordina nada. */
  maxToolCalls?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

/**
 * El modelo de verdad, contra la Messages API.
 *
 * Las herramientas que se le ofrecen son exactamente las que el core sabe ejecutar: el modelo no
 * puede inventarse una acción que aquí no exista. Cuando se le acaba el presupuesto de lecturas se
 * le vuelve a preguntar sólo con las que deciden, así que un turno siempre termina en un
 * checkpoint y nunca en un bucle.
 */
export class AnthropicModel implements AssistantModel {
  readonly id: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #maxToolCalls: number;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;

  constructor(options: AnthropicModelOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#model = options.model;
    this.#maxToolCalls = options.maxToolCalls ?? 6;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#fetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.id = options.model;
  }

  async decide(context: PlanContext, toolbox: AssistantToolbox): Promise<AssistantDecision> {
    const messages: AnthropicMessage[] = [{ role: 'user', content: renderContext(context) }];

    for (let call = 0; call <= this.#maxToolCalls; call += 1) {
      // En la última vuelta sólo quedan las herramientas que cierran: el turno acaba en decisión.
      const decisionsOnly = call === this.#maxToolCalls;
      const tools = toolbox.definitions({ decisionsOnly });
      const body = await this.#ask(messages, tools);
      const blocks = body.content ?? [];
      const use = blocks.find((block) => block.type === 'tool_use');

      if (!use?.name) {
        // Sin llamada a herramienta no hay decisión que persistir; lo dicho se cierra como síntesis.
        const text = blocks.find((block) => block.type === 'text')?.text ?? 'el modelo no propuso ningún paso';
        return { kind: 'finish', summary: text.slice(0, 4000) };
      }

      const outcome = await toolbox.invoke(use.name, use.input ?? {});
      if (outcome.type === 'decision') return outcome.decision;

      // Una observación: se le devuelve al modelo tal cual y se sigue dentro del mismo turno.
      messages.push({ role: 'assistant', content: blocks as unknown as Array<Record<string, unknown>> });
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: use.id ?? '',
          content: JSON.stringify(outcome.content).slice(0, 60_000),
        }],
      });
    }

    // Inalcanzable con el bucle de arriba, pero un plan nunca se queda sin salida por un `for`.
    return { kind: 'finish', summary: 'se agotó el presupuesto de consultas de este turno' };
  }

  async #ask(messages: AnthropicMessage[], tools: ToolDefinition[]): Promise<{ content?: AnthropicContentBlock[] }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.#baseUrl}/v1/messages`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.#apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.#model,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
          // Siempre una herramienta: lo que no es una acción del core no es una decisión.
          tool_choice: { type: 'any' },
          messages,
        }),
      });
      if (!response.ok) {
        throw new Error(`the model answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
      }
      return await response.json() as { content?: AnthropicContentBlock[] };
    } finally {
      clearTimeout(timer);
    }
  }
}

interface OpenAiToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

/**
 * El mismo coordinador, contra un endpoint compatible con OpenAI.
 *
 * Existe porque el proveedor no es una preferencia estética: es la credencial que hay en la casa.
 * Este despliegue heredó una de OpenAI del stack anterior —que es con la que el Assistant llevaba
 * meses funcionando— y un core que sólo hablase con Anthropic lo dejaba apagado por un motivo que
 * no tiene nada que ver con el producto.
 *
 * La forma del turno es idéntica a la de Anthropic y por el mismo motivo: se ofrecen las mismas
 * herramientas, las lecturas se resuelven en el momento y la primera que decide cierra. Lo único
 * que cambia es la forma del sobre: aquí las llamadas vienen en `tool_calls` con los argumentos
 * como texto JSON, y sus resultados vuelven como mensajes de rol `tool`.
 */
export class OpenAiCompatibleModel implements AssistantModel {
  readonly id: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #maxToolCalls: number;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;

  constructor(options: AnthropicModelOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#model = options.model;
    this.#maxToolCalls = options.maxToolCalls ?? 6;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#fetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.id = options.model;
  }

  async decide(context: PlanContext, toolbox: AssistantToolbox): Promise<AssistantDecision> {
    const messages: OpenAiMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: renderContext(context) },
    ];

    for (let call = 0; call <= this.#maxToolCalls; call += 1) {
      const decisionsOnly = call === this.#maxToolCalls;
      const tools = toolbox.definitions({ decisionsOnly });
      const message = await this.#ask(messages, tools);
      const calls = message.tool_calls ?? [];

      if (!calls.length || !calls[0]?.function?.name) {
        const text = message.content ?? 'el modelo no propuso ningún paso';
        return { kind: 'finish', summary: text.slice(0, 4000) };
      }

      /**
       * Se responden **todas** las llamadas del mensaje, no sólo la primera.
       *
       * La API lo exige —«an assistant message with tool_calls must be followed by tool messages
       * responding to each tool_call_id»— y devuelve 400 si falta alguna: el plan moría en el
       * primer turno en que el modelo pedía dos lecturas a la vez, que es lo normal cuando quiere
       * mirar dos cosas antes de decidir.
       *
       * Si una de ellas decide, el turno acaba ahí: lo que se ejecutó antes eran lecturas, y la
       * conversación de este turno no vuelve a usarse.
       */
      const answers: OpenAiMessage[] = [];
      for (const call of calls) {
        const name = call.function?.name;
        if (!name) continue;
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(call.function?.arguments || '{}') as Record<string, unknown>;
        } catch {
          // Argumentos que no son JSON: se trata como una llamada sin datos y la herramienta se
          // queja con su propio mensaje, que es más útil que un fallo genérico del turno.
        }
        const outcome = await toolbox.invoke(name, input);
        if (outcome.type === 'decision') return outcome.decision;
        answers.push({
          role: 'tool',
          tool_call_id: call.id ?? '',
          content: JSON.stringify(outcome.content).slice(0, 60_000),
        });
      }

      messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: calls });
      messages.push(...answers);
    }

    return { kind: 'finish', summary: 'se agotó el presupuesto de consultas de este turno' };
  }

  async #ask(messages: OpenAiMessage[], tools: ToolDefinition[]): Promise<OpenAiMessage> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.#baseUrl}/v1/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#apiKey}` },
        body: JSON.stringify({
          model: this.#model,
          messages,
          tools: tools.map((tool) => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
          })),
          // Siempre una herramienta: lo que no es una acción del core no es una decisión.
          tool_choice: 'required',
        }),
      });
      if (!response.ok) {
        throw new Error(`the model answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
      }
      const body = await response.json() as { choices?: Array<{ message?: OpenAiMessage }> };
      return body.choices?.[0]?.message ?? { role: 'assistant', content: null };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * El contexto, en prosa breve y con lo justo.
 *
 * Va como texto y no como un volcado del objeto porque lo que hace falta subrayar —qué se espera
 * de este turno, qué límites hay— se pierde dentro de un JSON plano.
 */
export function renderContext(context: PlanContext): string {
  const lines = [
    `Objetivo: ${context.objective}`,
    '',
    `Sesión de trabajo: ${context.workspace.provider} en ${context.workspace.host}`
      + ` (sesión ${context.workspace.sessionId}${context.workspace.cwd ? `, cwd ${context.workspace.cwd}` : ''}).`,
  ];
  if (context.workspace.title) lines.push(`El workspace se llama «${context.workspace.title}».`);

  lines.push('', context.history.length
    ? `Pasos dados (${context.history.length}):`
    : 'Todavía no se ha dado ningún paso.');
  for (const step of context.history) {
    const evidence = step.runId ? ` · trabajo ${step.runId}` : '';
    const failure = step.errorCode ? ` · error ${step.errorCode}` : '';
    lines.push(`${step.ordinal + 1}. [${step.kind}/${step.status}] ${step.title}${evidence}${failure}`
      + (step.summary ? `\n   ${step.summary}` : ''));
  }

  if (context.pendingInput) {
    lines.push('', `La persona respondió a tu pregunta: «${context.pendingInput}». Sigue desde ahí.`);
  }
  if (context.pendingApprovals.length) {
    lines.push('', 'Aprobaciones ya pedidas y aún sin resolver (no las repitas):');
    for (const approval of context.pendingApprovals) {
      lines.push(`· ${approval.summary} (caduca ${approval.expiresAt})`);
    }
  }

  lines.push('',
    `Llevas ${context.limits.stepsUsed} de ${context.limits.maxSteps} pasos y puedes hacer hasta`
    + ` ${context.limits.maxToolCalls} consultas en este turno. Decide un solo paso.`);
  return lines.join('\n');
}
