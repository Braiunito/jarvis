/**
 * Adapter de OpenCode.
 *
 * Invocación auto-mode (verificada contra opencode 1.17):
 *   opencode run --session <sid> --format json --agent <agente> <prompt>
 *
 * OpenCode expresa los niveles de permiso como *agentes* en vez de flags: `plan` es su persona de
 * sólo lectura, `build` la que edita.
 *
 * Contrato: ADAPT-OPENCODE-01.
 */
import type { AgentEvent, PermissionProfile } from '@jarvis/contracts';
import { rawEvent, type AgentAdapter, type BuildAttachOptions, type BuildRunOptions, type Invocation } from './types.js';

const AGENT: Record<PermissionProfile, string> = {
  safe: 'plan',
  auto: 'build',
  yolo: 'build',
};

interface OpencodePart {
  id?: string;
  text?: string;
  tool?: string;
  state?: { input?: unknown; output?: string; status?: 'started' | 'completed' | 'error' };
  reason?: string;
  tokens?: unknown;
  cost?: number;
}

interface OpencodeRecord {
  type?: string;
  sessionID?: string;
  part?: OpencodePart;
  message?: string;
}

export const opencodeAdapter: AgentAdapter = {
  id: 'opencode',
  binary: 'opencode',

  permissionMode(profile) {
    return AGENT[profile] ?? AGENT.safe;
  },

  buildRun({ sessionId, prompt, permissionProfile, sourceRoot, model, resume = true }: BuildRunOptions): Invocation {
    const argv = ['opencode', 'run', '--format', 'json', '--agent', AGENT[permissionProfile] ?? AGENT.safe];
    if (resume && sessionId) argv.push('--session', sessionId);
    if (model) argv.push('-m', model);
    argv.push(prompt);

    const env: Record<string, string> = {};
    if (sourceRoot && !sourceRoot.endsWith('/opencode')) env['OPENCODE_DATA_DIR'] = sourceRoot;
    return { argv, env };
  },

  buildAttach({ sessionId, permissionProfile }: BuildAttachOptions): Invocation {
    const argv = ['opencode'];
    if (sessionId) argv.push('--session', sessionId);
    argv.push('--agent', AGENT[permissionProfile] ?? AGENT.safe);
    return { argv, env: {} };
  },

  normalize(input: unknown): AgentEvent | AgentEvent[] | null {
    const record = input as OpencodeRecord;
    const sessionId = record?.sessionID;
    const part = record?.part ?? {};

    switch (record?.type) {
      case 'step_start':
        return { type: 'started', ...(sessionId ? { sessionId } : {}) };

      case 'text':
        return part.text ? { type: 'text', text: part.text, ...(sessionId ? { sessionId } : {}) } : rawEvent(record);

      case 'reasoning':
        return part.text ? { type: 'reasoning', text: part.text, ...(sessionId ? { sessionId } : {}) } : rawEvent(record);

      case 'tool':
        return {
          type: 'tool',
          ...(sessionId ? { sessionId } : {}),
          tool: {
            ...(part.id ? { id: part.id } : {}),
            ...(part.tool ? { name: part.tool } : {}),
            input: part.state?.input,
            output: part.state?.output,
            status: part.state?.status ?? 'started',
          },
        };

      case 'step_finish':
        return {
          type: 'result',
          ok: part.reason === 'stop',
          ...(sessionId ? { sessionId } : {}),
          usage: part.tokens,
          costUsd: part.cost ?? null,
          ...(part.reason ? { stopReason: part.reason } : {}),
        };

      case 'error':
        return { type: 'error', message: record.message ?? 'opencode reported an error' };

      default:
        return rawEvent(record);
    }
  },
};
