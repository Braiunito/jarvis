import type { AgentEvent, PermissionProfile, Provider } from '@jarvis/contracts';

export interface BuildRunOptions {
  sessionId?: string | null;
  prompt: string;
  permissionProfile: PermissionProfile;
  sourceRoot?: string | null;
  model?: string | null;
  resume?: boolean;
}

export interface BuildAttachOptions {
  sessionId?: string | null;
  permissionProfile: PermissionProfile;
}

export interface Invocation {
  argv: string[];
  env: Record<string, string>;
}

/**
 * Cada CLI emite su propio stream JSON. En vez de enseñar los tres al resto del sistema, cada
 * adapter normaliza a `AgentEvent`. Lo desconocido degrada a `raw` en lugar de lanzar: un run
 * jamás debe morir porque apareció un tipo de registro nuevo.
 */
export interface AgentAdapter {
  readonly id: Provider;
  readonly binary: string;
  /** Cómo se llama el modo de permiso en la CLI, para poder auditarlo tal cual se ejecutó. */
  permissionMode(profile: PermissionProfile): string;
  buildRun(options: BuildRunOptions): Invocation;
  buildAttach(options: BuildAttachOptions): Invocation;
  normalize(record: unknown): AgentEvent | AgentEvent[] | null;
}

export const rawEvent = (payload: unknown): AgentEvent => ({ type: 'raw', payload });
