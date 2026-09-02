/**
 * Adapter de Claude Code.
 *
 * Invocación auto-mode (verificada contra Claude Code 2.1.x):
 *   claude -p <prompt> --resume <sid> --output-format stream-json --verbose --permission-mode <m>
 *
 * `--verbose` no es decoración: sin él, `--output-format stream-json` se niega a emitir los
 * registros intermedios y sólo vuelve el resultado final.
 *
 * Contrato: ADAPT-CLAUDE-01.
 */
import type { AgentEvent, PermissionProfile } from '@jarvis/contracts';
import { rawEvent, type AgentAdapter, type BuildAttachOptions, type BuildRunOptions, type Invocation } from './types.js';

const PERMISSION_MODE: Record<PermissionProfile, string> = {
  // `plan` es la postura de sólo lectura de Claude Code: puede mirar, no puede cambiar nada.
  safe: 'plan',
  auto: 'acceptEdits',
  yolo: 'bypassPermissions',
};

interface ClaudeBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

interface ClaudeRecord {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  cwd?: string;
  permissionMode?: string;
  tools?: string[];
  message?: { content?: ClaudeBlock[] };
  is_error?: boolean;
  result?: string;
  errors?: unknown[];
  num_turns?: number;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: unknown;
}

/** Los motivos de un fallo, tal y como los lista el CLI. */
function errorText(errors: unknown[] | undefined): string | null {
  if (!Array.isArray(errors) || !errors.length) return null;
  const parts = errors.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)));
  return parts.join('; ') || null;
}

export const claudeAdapter: AgentAdapter = {
  id: 'claude',
  binary: 'claude',

  permissionMode(profile) {
    return PERMISSION_MODE[profile] ?? PERMISSION_MODE.safe;
  },

  buildRun({ sessionId, prompt, permissionProfile, sourceRoot, model, resume = true }: BuildRunOptions): Invocation {
    const argv = ['claude', '-p', prompt, '--output-format', 'stream-json', '--verbose'];
    if (resume && sessionId) argv.push('--resume', sessionId);
    /**
     * Una sesión que empieza de cero, con el identificador puesto por Jarvis.
     *
     * Claude Code deja fijarlo, y eso vale más que un id bonito: el workspace nace con su
     * identidad definitiva en vez de con una provisional que hay que sustituir cuando el agente
     * dice la suya. Los otros dos CLI no lo permiten, y ahí sí hay que adoptar la que reporten.
     */
    else if (!resume && sessionId) argv.push('--session-id', sessionId);
    argv.push('--permission-mode', PERMISSION_MODE[permissionProfile] ?? PERMISSION_MODE.safe);
    if (model) argv.push('--model', model);

    const env: Record<string, string> = {};
    // Sólo cuando el transcript vive fuera del store por defecto, igual que lo resuelve aiSessions.
    if (sourceRoot && !sourceRoot.endsWith('/.claude')) env['CLAUDE_CONFIG_DIR'] = sourceRoot;
    return { argv, env };
  },

  buildAttach({ sessionId, permissionProfile }: BuildAttachOptions): Invocation {
    const argv = ['claude'];
    if (sessionId) argv.push('--resume', sessionId);
    argv.push('--permission-mode', PERMISSION_MODE[permissionProfile] ?? PERMISSION_MODE.safe);
    return { argv, env: {} };
  },

  normalize(input: unknown): AgentEvent | AgentEvent[] | null {
    const record = input as ClaudeRecord;
    switch (record?.type) {
      case 'system':
        if (record.subtype === 'init') {
          return {
            type: 'started',
            ...(record.session_id ? { sessionId: record.session_id } : {}),
            ...(record.model ? { model: record.model } : {}),
            ...(record.cwd ? { cwd: record.cwd } : {}),
            ...(record.permissionMode ? { permissionMode: record.permissionMode } : {}),
            ...(record.tools ? { tools: record.tools } : {}),
          };
        }
        /**
         * `system/thinking_tokens` es un contador que sube mientras el modelo razona, y llega cada
         * pocos segundos. No se guarda.
         *
         * Guardarlo llenaba la línea de tiempo de tarjetas idénticas —«el modelo está pensando»,
         * cinco seguidas— que empujaban fuera de la pantalla lo único que se venía a leer: lo que
         * hizo y lo que respondió. Que sigue trabajando ya lo dice su estado.
         */
        if (record.subtype === 'thinking_tokens') return [];
        return rawEvent(record);

      case 'assistant': {
        const events: AgentEvent[] = [];
        for (const block of record.message?.content ?? []) {
          if (block.type === 'text' && block.text) {
            events.push({ type: 'text', text: block.text, ...(record.session_id ? { sessionId: record.session_id } : {}) });
          } else if (block.type === 'thinking' && block.thinking) {
            events.push({ type: 'reasoning', text: block.thinking, ...(record.session_id ? { sessionId: record.session_id } : {}) });
          } else if (block.type === 'tool_use') {
            events.push({
              type: 'tool',
              tool: {
                ...(block.name ? { name: block.name } : {}),
                ...(block.id ? { id: block.id } : {}),
                input: block.input,
                status: 'started',
              },
              ...(record.session_id ? { sessionId: record.session_id } : {}),
            });
          }
        }
        return events.length === 1 ? (events[0] as AgentEvent) : events;
      }

      case 'user': {
        // Claude reporta la salida de una tool como un turno de usuario sintético.
        const events: AgentEvent[] = [];
        for (const block of record.message?.content ?? []) {
          if (block.type === 'tool_result') {
            events.push({
              type: 'tool',
              tool: {
                ...(block.tool_use_id ? { id: block.tool_use_id } : {}),
                status: block.is_error ? 'error' : 'completed',
                output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
              },
              ...(record.session_id ? { sessionId: record.session_id } : {}),
            });
          }
        }
        return events.length ? events : rawEvent(record);
      }

      case 'result':
        return {
          type: 'result',
          ok: record.is_error !== true,
          /**
           * Un fallo trae su motivo en `errors` y deja `result` sin poner.
           *
           * Sin leerlo, un trabajo que muere porque no encuentra la conversación terminaba en
           * rojo y con el resultado en blanco: el único sitio donde estaba escrito qué había
           * pasado era una línea suelta de stderr, fuera del hilo de eventos.
           */
          text: record.result ?? errorText(record.errors) ?? null,
          ...(record.session_id ? { sessionId: record.session_id } : {}),
          turns: record.num_turns ?? null,
          costUsd: record.total_cost_usd ?? null,
          durationMs: record.duration_ms ?? null,
          usage: record.usage,
        };

      case 'rate_limit_event':
        // Trae la cuota de la cuenta en vivo (`unifiedWindows`), que es lo mismo que el sondeo caro
        // averigua abriendo un TTY. Hoy sólo se conserva; aprovecharla es TEC-09.
        return { type: 'raw', payload: record, note: 'estado de la cuota de la cuenta' };

      default:
        return rawEvent(record);
    }
  },
};
