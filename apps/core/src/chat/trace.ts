/**
 * La traza de una conversación: qué hizo el asistente, en qué orden y qué le falló.
 *
 * No instrumenta nada. Todo lo que hace falta ya está en `chat_messages` desde siempre —`toolName`,
 * `toolInput`, `toolOk`, `modelId`, `createdAt`— y el problema nunca fue no tener el dato: era que
 * **no había dónde mirarlo**. Para diagnosticar una conversación de dieciocho minutos hubo que
 * bajarse el JSON crudo y escribir un script; con la vista delante, el diagnóstico salió en cinco
 * minutos.
 *
 * Se escribe puro y aparte a propósito: recibe los mensajes y devuelve el resumen, así que se
 * prueba sin base de datos y no obliga a tocar `ChatService`, que es de los ficheros que más manos
 * tiene encima.
 */
import type { ChatMessage } from '@jarvis/contracts';

/** Una llamada a herramienta, con lo que costó y por qué falló si falló. */
export interface TraceTool {
  seq: number;
  name: string;
  ok: boolean;
  at: string;
  /** Desde la llamada anterior del turno, o desde que empezó. Es lo que se nota esperando. */
  ms: number;
  /** El código cuando el error es del core (`NOT_FOUND`, `BAD_INPUT`), null cuando viene del MCP. */
  errorCode: string | null;
  /** La frase del fallo, venga del core o del servidor de al lado. */
  error: string | null;
}

/** Un turno: lo que se preguntó, lo que se contestó y lo que se hizo en medio. */
export interface TraceTurn {
  seq: number;
  at: string;
  /** Lo que tardó el turno entero. Es el número que mira quien estuvo esperando. */
  ms: number;
  model: string | null;
  ask: string;
  answer: string;
  tools: TraceTool[];
  failed: number;
}

export interface ConversationTrace {
  turns: TraceTurn[];
  totals: {
    turns: number;
    tools: number;
    failed: number;
    ms: number;
    /** Cuántas veces falló cada herramienta. Lo primero que se mira cuando algo va mal. */
    byTool: Record<string, number>;
    /** Y por qué. Cinco `NOT_FOUND` seguidos no son cinco problemas, son uno. */
    byError: Record<string, number>;
  };
}

const CLIP = 160;

const clip = (text: string): string =>
  text.length <= CLIP ? text : `${text.slice(0, CLIP)}…`;

/**
 * De dónde sale la frase del fallo, que **no está en el mismo sitio según quién falle**.
 *
 * El core contesta `{ok:false, error:{code,message}}` y el MCP `{ok:false, content:"Error calling
 * tool …"}`. Mirar sólo `error.code` deja fuera justo los fallos de la máquina de al lado —los de
 * allowlist y permisos—, que en la conversación que motivó esto eran la mitad.
 */
function failureOf(text: string): { code: string | null; message: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { code: null, message: null };
  }
  const body = (parsed ?? {}) as { error?: { code?: string; message?: string }; content?: unknown };
  if (body.error?.code) {
    return { code: body.error.code, message: body.error.message ?? null };
  }
  if (typeof body.content === 'string') return { code: null, message: clip(body.content) };
  return { code: null, message: null };
}

const millis = (from: string, to: string): number =>
  Math.max(0, Date.parse(to) - Date.parse(from));

/**
 * Agrupa los mensajes en turnos.
 *
 * Un turno empieza cuando habla la persona y termina cuando el asistente contesta; lo que hay en
 * medio son sus herramientas. Los mensajes de evento cierran turno igual que una respuesta: un
 * turno que se perdió en un reinicio también se estuvo esperando.
 */
export function traceOf(messages: readonly ChatMessage[]): ConversationTrace {
  const turns: TraceTurn[] = [];
  const byTool: Record<string, number> = {};
  const byError: Record<string, number> = {};
  let current: TraceTurn | null = null;
  let lastAt: string | null = null;

  for (const message of messages) {
    if (message.role === 'user') {
      current = {
        seq: message.seq,
        at: message.createdAt,
        ms: 0,
        model: null,
        ask: clip(message.text ?? ''),
        answer: '',
        tools: [],
        failed: 0,
      };
      turns.push(current);
      lastAt = message.createdAt;
      continue;
    }
    // Una herramienta o una respuesta sin pregunta delante existe: un turno reanudado tras un
    // reinicio, o un evento del sistema. Se le abre turno propio en vez de perderlo.
    if (!current) {
      current = {
        seq: message.seq, at: message.createdAt, ms: 0, model: null,
        ask: '(sin pregunta: turno reanudado o evento del sistema)', answer: '', tools: [], failed: 0,
      };
      turns.push(current);
      lastAt = message.createdAt;
    }

    if (message.role === 'tool') {
      const name = message.toolName ?? '(sin nombre)';
      const ok = message.toolOk !== false;
      const failure = ok ? { code: null, message: null } : failureOf(message.text ?? '');
      current.tools.push({
        seq: message.seq,
        name,
        ok,
        at: message.createdAt,
        ms: millis(lastAt ?? message.createdAt, message.createdAt),
        errorCode: failure.code,
        error: failure.message,
      });
      if (!ok) {
        current.failed += 1;
        byTool[name] = (byTool[name] ?? 0) + 1;
        const clave = failure.code ?? 'DEL_SERVIDOR';
        byError[clave] = (byError[clave] ?? 0) + 1;
      }
      lastAt = message.createdAt;
      continue;
    }

    // `assistant` o `event`: cierra el turno.
    current.answer = clip(message.text ?? '');
    current.model = message.modelId ?? null;
    current.ms = millis(current.at, message.createdAt);
    current = null;
  }

  return {
    turns,
    totals: {
      turns: turns.length,
      tools: turns.reduce((n, turn) => n + turn.tools.length, 0),
      failed: turns.reduce((n, turn) => n + turn.failed, 0),
      ms: turns.reduce((n, turn) => n + turn.ms, 0),
      byTool,
      byError,
    },
  };
}
