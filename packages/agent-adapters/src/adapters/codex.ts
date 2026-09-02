/**
 * Adapter de Codex.
 *
 * Invocación auto-mode (verificada contra codex-cli 0.149):
 *   codex exec resume <sid> <prompt> --json -c sandbox_mode=<modo>
 *
 * `codex exec resume` NO acepta `--sandbox` ni `-C`, a diferencia de `codex exec` a secas: el
 * sandbox viaja como override de configuración y el directorio de trabajo lo pone el shell antes
 * del comando. Equivocarse aquí da al agente permisos distintos de los que dice la etiqueta.
 *
 * Contrato: ADAPT-CODEX-01.
 */
import type { AgentEvent, PermissionProfile } from '@jarvis/contracts';
import { rawEvent, type AgentAdapter, type BuildAttachOptions, type BuildRunOptions, type Invocation } from './types.js';

/** Una sola tabla para todos los transportes: dos copias de un mapeo de permisos es una de más. */
const SANDBOX_MODE: Record<PermissionProfile, string> = {
  safe: 'read-only',
  auto: 'workspace-write',
  yolo: 'danger-full-access',
};

const sandboxFor = (profile: PermissionProfile): string => SANDBOX_MODE[profile] ?? SANDBOX_MODE.safe;
const isDefaultCodexHome = (sourceRoot: string | null | undefined): boolean =>
  /\/(?:\.codex|\.config\/codex)\/?$/.test(String(sourceRoot ?? ''));

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  summary?: string;
  command?: unknown;
  aggregated_output?: string;
  output?: string;
  exit_code?: number;
  changes?: unknown;
  path?: string;
}

interface CodexRecord {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: unknown;
  error?: { message?: string };
  message?: string;
}

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  binary: 'codex',

  permissionMode(profile) {
    return sandboxFor(profile);
  },

  buildRun({ sessionId, prompt, permissionProfile, sourceRoot, model, resume = true }: BuildRunOptions): Invocation {
    const argv = ['codex', 'exec'];
    if (resume && sessionId) argv.push('resume', sessionId);
    argv.push(prompt, '--json');
    // Codex se niega a correr fuera de un repositorio git salvo que se le diga otra cosa, y hay
    // sesiones reales en directorios que no son repos. Lo que nos protege es el sandbox, no esto.
    argv.push('--skip-git-repo-check');

    if (permissionProfile === 'yolo') {
      argv.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      argv.push('-c', `sandbox_mode=${sandboxFor(permissionProfile)}`);
    }
    if (model) argv.push('-m', model);

    const env: Record<string, string> = {};
    if (sourceRoot && !isDefaultCodexHome(sourceRoot)) env['CODEX_HOME'] = sourceRoot;
    return { argv, env };
  },

  /**
   * El sandbox viaja también aquí como override. Sin él, la CLI interactiva usa su propio
   * predeterminado —que puede escribir— mientras la UI seguiría diciendo «safe»: la etiqueta
   * tiene que ser la verdad, no una esperanza.
   */
  buildAttach({ sessionId, permissionProfile }: BuildAttachOptions): Invocation {
    const argv = ['codex'];
    if (sessionId) argv.push('resume', sessionId);
    argv.push('-c', `sandbox_mode=${sandboxFor(permissionProfile)}`);
    return { argv, env: {} };
  },

  normalize(input: unknown): AgentEvent | AgentEvent[] | null {
    const record = input as CodexRecord;
    switch (record?.type) {
      case 'thread.started':
        return { type: 'started', ...(record.thread_id ? { sessionId: record.thread_id } : {}) };

      case 'turn.started':
        return { type: 'raw', payload: record, note: 'turn started' };

      case 'item.completed': {
        const item = record.item ?? {};
        if (item.type === 'agent_message') return { type: 'text', text: item.text ?? '' };
        if (item.type === 'reasoning') return { type: 'reasoning', text: item.text ?? item.summary ?? '' };
        if (item.type === 'command_execution') {
          return {
            type: 'tool',
            tool: {
              ...(item.id ? { id: item.id } : {}),
              name: 'shell',
              input: item.command,
              output: item.aggregated_output ?? item.output,
              status: item.exit_code === 0 ? 'completed' : 'error',
            },
          };
        }
        if (item.type === 'file_change') {
          return {
            type: 'tool',
            tool: {
              ...(item.id ? { id: item.id } : {}),
              name: 'edit',
              input: item.changes ?? item.path,
              status: 'completed',
            },
          };
        }
        return rawEvent(record);
      }

      case 'turn.completed':
        return { type: 'result', ok: true, usage: record.usage };

      case 'turn.failed':
        return {
          type: 'error',
          message: record.error?.message ?? 'the Codex turn failed',
          payload: record.error,
        };

      case 'error':
        return { type: 'error', message: record.message ?? 'codex reported an error', payload: record };

      default:
        return rawEvent(record);
    }
  },
};
