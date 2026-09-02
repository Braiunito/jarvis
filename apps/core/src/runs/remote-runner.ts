/**
 * El lado SSH de un run: preparar el spool, leerlo y pedirle que pare.
 *
 * Todo lo que decide *qué* comando se manda vive en `@jarvis/agent-adapters` y está cubierto por
 * fixtures; aquí sólo se ejecuta y se traducen los fallos a errores con código.
 */
import {
  buildCancelCommand, buildPollCommand, buildPrepareCommand, parsePollOutput, parsePrepareOutput,
  spoolLayout, sshExec, SshError, sshFailureReason, type PollResult, type PrepareOutcome,
  type RunnerMeta, type SpoolLayout, type SshConfig,
} from '@jarvis/agent-adapters';
import { JarvisError } from '@jarvis/contracts';

export interface RemoteRunnerDeps {
  sshConfig: SshConfig;
  spoolRoot: string;
  pollChunkBytes: number;
}

export class RemoteRunner {
  readonly #ssh: SshConfig;
  readonly #spoolRoot: string;
  readonly #chunkBytes: number;


  constructor({ sshConfig, spoolRoot, pollChunkBytes }: RemoteRunnerDeps) {
    this.#ssh = sshConfig;
    this.#spoolRoot = spoolRoot;
    this.#chunkBytes = pollChunkBytes;
  }

  get chunkBytes(): number { return this.#chunkBytes; }

  /**
   * El layout del spool.
   *
   * El root se puede pasar por llamada porque **depende del host**: un spool configurado bajo el
   * home del usuario no vale igual para `zeus` que para `root@vultr`. Cada run guarda el suyo, así
   * que leerlo o cancelarlo más tarde usa el que se decidió al crearlo, no el de la configuración
   * de hoy.
   */
  layout(runId: string, root: string = this.#spoolRoot): SpoolLayout {
    return spoolLayout(root, runId);
  }

  async #exec(host: string, command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
    try {
      return await sshExec({ host, command, config: this.#ssh }, { timeoutMs });
    } catch (error) {
      if (error instanceof SshError) {
        throw new JarvisError('HOST_UNREACHABLE', error.message, { scope: { host } });
      }
      throw error;
    }
  }

  async prepare({ host, runId, meta, agentCommand, cwd, spoolRoot }: {
    host: string; runId: string; meta: RunnerMeta; agentCommand: string; cwd: string | null; spoolRoot?: string;
  }): Promise<{ outcome: PrepareOutcome; layout: SpoolLayout }> {
    const layout = this.layout(runId, spoolRoot);
    const command = buildPrepareCommand({ layout, meta, agentCommand, cwd });
    const result = await this.#exec(host, command, 60_000);
    if (result.code !== 0) {
      const reason = sshFailureReason(result);
      if (/tmux: (command )?not found/i.test(`${result.stderr}${result.stdout}`)) {
        throw new JarvisError('TMUX_MISSING',
          `tmux is not installed on ${host}, so a durable run cannot be started there`,
          { scope: { host } });
      }
      throw new JarvisError('HOST_UNREACHABLE', `could not prepare the run on ${host}: ${reason}`, { scope: { host } });
    }
    return { outcome: parsePrepareOutput(result.stdout), layout };
  }

  async poll({ host, runId, offset, maxBytes, spoolRoot }: {
    host: string; runId: string; offset: number; maxBytes?: number; spoolRoot?: string;
  }): Promise<PollResult> {
    const layout = this.layout(runId, spoolRoot);
    const result = await this.#exec(
      host,
      buildPollCommand({ layout, offset, maxBytes: maxBytes ?? this.#chunkBytes }),
      45_000,
    );
    if (result.code !== 0) {
      throw new JarvisError('HOST_UNREACHABLE', `could not read the run spool on ${host}: ${sshFailureReason(result)}`, { scope: { host } });
    }
    return parsePollOutput(result.stdout);
  }

  async cancel({ host, runId, escalate = false, spoolRoot }: {
    host: string; runId: string; escalate?: boolean; spoolRoot?: string;
  }): Promise<void> {
    const layout = this.layout(runId, spoolRoot);
    const result = await this.#exec(host, buildCancelCommand(layout, { escalate }), 30_000);
    if (result.code !== 0) {
      throw new JarvisError('HOST_UNREACHABLE', `could not signal the run on ${host}: ${sshFailureReason(result)}`, { scope: { host } });
    }
  }
}
