/**
 * El supervisor: lo que hace que un run siga existiendo cuando el core no.
 *
 * Al arrancar reconcilia lo que quedó a medias contra lo que realmente hay en los hosts, y
 * después vigila los runs vivos leyendo su spool por cursor de bytes.
 *
 * Regla que gobierna todo el fichero: **reconciliar no es reejecutar**. Ante duda sobre si un
 * comando con efectos ocurrió, se falla con evidencia antes que duplicarlo.
 */
import type { Run, RunStatus } from '@jarvis/contracts';
import { isTerminalStatus, JarvisError } from '@jarvis/contracts';
import { statusToRunStatus, type PollResult } from '@jarvis/agent-adapters';
import type { Clock } from '../platform/clock.js';
import type { RunRepository } from './repository.js';
import type { RemoteRunner } from './remote-runner.js';
import type { RunService } from './service.js';

export interface SupervisorDeps {
  runs: RunService;
  repository: RunRepository;
  runner: RemoteRunner;
  clock: Clock;
  pollIntervalMs: number;
  interruptGraceMs: number;
  /** Tope de lectura para una sola línea del spool antes de darla por imposible. */
  maxLineBytes?: number;
  /** Cuánto se espera antes de dar por perdido un runner que no aparece por ninguna parte. */
  lostGraceMs?: number;
  onError?: (error: Error, runId: string) => void;
}

const ACTIVE: RunStatus[] = ['queued', 'preparing', 'running', 'waiting', 'cancelling'];

export class RunSupervisor {
  readonly #deps: SupervisorDeps;
  readonly #missingSince = new Map<string, number>();
  readonly #cancelSentAt = new Map<string, number>();
  readonly #inFlight = new Set<string>();
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(deps: SupervisorDeps) {
    this.#deps = deps;
  }

  /** Reconcilia y arranca la vigilancia. Se llama antes de aceptar escrituras nuevas. */
  async start(): Promise<void> {
    this.#stopped = false;
    await this.reconcile();
    this.#schedule();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      void this.tick().finally(() => this.#schedule());
    }, this.#deps.pollIntervalMs);
    this.#timer.unref?.();
  }

  /**
   * Reconciliación de arranque.
   *
   * | estado en DB | remoto            | acción                                   |
   * |--------------|-------------------|------------------------------------------|
   * | queued       | nada              | volver a preparar                        |
   * | preparing    | tmux viva         | adoptar como running                     |
   * | preparing    | status terminal   | importar el spool y terminar             |
   * | running      | tmux viva         | reanudar el tail desde el cursor         |
   * | running      | status terminal   | importar el resto y terminar             |
   * | running      | ni tmux ni status | esperar el grace y fallar RUNNER_LOST    |
   * | cancelling   | tmux viva         | repetir la señal                         |
   * | cancelling   | ausente/terminal  | confirmar el estado real                 |
   */
  async reconcile(): Promise<{ examined: number; adopted: number; finished: number; lost: number }> {
    const runs = this.#deps.repository.listByStatus(ACTIVE);
    let adopted = 0;
    let finished = 0;
    let lost = 0;

    for (const run of runs) {
      try {
        if (run.status === 'queued') continue; // el tick lo prepara

        const poll = await this.#pollRun(run);
        if (!poll) continue;

        const before = run.status;
        await this.#applyPoll(run, poll, { reconciling: true });
        const after = this.#deps.repository.find(run.id)?.status;
        if (after && isTerminalStatus(after) && !isTerminalStatus(before)) finished += 1;
        else if (after === 'running' && before === 'preparing') adopted += 1;
        else if (after === 'failed') lost += 1;
      } catch (error) {
        this.#deps.onError?.(error as Error, run.id);
      }
    }

    return { examined: runs.length, adopted, finished, lost };
  }

  /** Un ciclo: preparar lo encolado, leer lo vivo y aplicar plazos. */
  async tick(): Promise<void> {
    const runs = this.#deps.repository.listByStatus(ACTIVE);
    await Promise.all(runs.map(async (run) => {
      if (this.#inFlight.has(run.id)) return;
      this.#inFlight.add(run.id);
      try {
        if (run.status === 'queued') {
          await this.#deps.runs.prepare(run.id);
          return;
        }
        const poll = await this.#pollRun(run);
        if (poll) await this.#applyPoll(run, poll, { reconciling: false });
      } catch (error) {
        this.#deps.onError?.(error as Error, run.id);
      } finally {
        this.#inFlight.delete(run.id);
      }
    }));
  }

  /**
   * Lee un trozo del spool, agrandando la lectura si hace falta.
   *
   * Una sola línea puede ser mayor que el trozo por defecto —la salida de una tool que vuelca un
   * fichero entero, por ejemplo—. Sin esta escalada, esa línea nunca llegaría completa, la ingesta
   * no avanzaría el cursor y el run se quedaría inmóvil para siempre.
   */
  async #pollRun(run: Run): Promise<PollResult | null> {
    const row = this.#deps.repository.row(run.id);
    if (!row) return null;
    try {
      const base = this.#deps.runner.chunkBytes;
      const hardMax = this.#deps.maxLineBytes ?? 8 * 1024 * 1024;
      let maxBytes = base;
      for (;;) {
        const poll = await this.#deps.runner.poll({
          host: run.executionHost, runId: run.id, offset: row.remote_cursor_bytes, maxBytes,
        });
        const readBytes = Buffer.byteLength(poll.chunk, 'utf8');
        const complete = poll.chunk.includes('\n');
        // Sólo se agranda si de verdad se llenó la lectura: si el fichero da menos, es que la
        // línea sigue escribiéndose y hay que esperar, no leer más.
        if (complete || readBytes < maxBytes || maxBytes >= hardMax) {
          if (!complete && readBytes >= hardMax) this.#dropOversizedLine(run.id, readBytes);
          return poll;
        }
        maxBytes = Math.min(maxBytes * 4, hardMax);
      }
    } catch (error) {
      // Un host que no responde no cambia el estado del run: sólo se anota y se reintenta. La
      // ejecución sigue viva al otro lado aunque nosotros no podamos verla.
      if (error instanceof JarvisError && error.code === 'HOST_UNREACHABLE') {
        this.#deps.onError?.(error, run.id);
        return null;
      }
      throw error;
    }
  }

  /**
   * Una línea que supera el tope se anota y se salta.
   *
   * Se deja constancia explícita: perder salida está mal, pero perderla en silencio es peor, y
   * bloquear el run para siempre es lo peor de todo.
   */
  #dropOversizedLine(runId: string, bytes: number): void {
    const row = this.#deps.repository.row(runId);
    if (!row) return;
    this.#deps.repository.appendBatch(runId, [{
      type: 'agent.raw',
      at: this.#deps.clock.nowIso(),
      payload: { text: '[a single output line exceeded the read limit and was skipped]', truncated: true, originalBytes: bytes },
    }], { cursorBytes: row.remote_cursor_bytes + bytes });
    this.#deps.runs.bus.notify(runId);
  }

  async #applyPoll(run: Run, poll: PollResult, { reconciling }: { reconciling: boolean }): Promise<void> {
    const { runs, repository, clock } = this.#deps;
    const row = repository.row(run.id);
    if (!row) return;

    if (poll.chunk) {
      runs.ingest(run.id, poll.chunk, row.remote_cursor_bytes);
    }

    const current = repository.find(run.id) as Run;
    if (isTerminalStatus(current.status)) return;

    const remoteState = poll.status?.state ?? null;
    const cursorRow = repository.row(run.id);
    const drained = cursorRow ? cursorRow.remote_cursor_bytes >= poll.size : false;

    // Adoptar: hay proceso vivo o spool con estado, y en la base seguía «preparándose».
    if (current.status === 'preparing' && (poll.alive || remoteState)) {
      runs.transition(run.id, 'running', { reason: reconciling ? 'adopted on boot' : 'runner confirmed' });
    }

    if (remoteState && remoteState !== 'running') {
      // No se concluye hasta haber leído todo lo que el spool tenía: el resultado suele ser la
      // última línea, y terminar antes perdería justo la parte que importa.
      if (!drained) return;
      await this.#finishFromRemote(run.id, remoteState, poll);
      return;
    }

    // Cancelación pedida: primero la señal amable, luego la insistencia.
    if (current.status === 'cancelling') {
      const sentAt = this.#cancelSentAt.get(run.id) ?? Date.parse(current.cancelRequestedAt ?? clock.nowIso());
      this.#cancelSentAt.set(run.id, sentAt);
      // Sin sesión tmux no hay proceso: eso es «inequívocamente ausente». El `status.json` puede
      // haberse quedado en `running` justamente porque al wrapper lo mataron antes de publicar,
      // así que esperar a que él lo diga sería esperar para siempre.
      if (!poll.alive) {
        runs.transition(run.id, current.errorCode === 'TIMEOUT' ? 'timed_out' : 'cancelled', {
          reason: 'the runner is gone',
        });
        return;
      }
      if (clock.nowMs() - sentAt > this.#deps.interruptGraceMs) {
        await runs.escalateCancel(run.id);
      }
      return;
    }

    // Plazo agotado: se pide parar y se concluye `timed_out` cuando el remoto confirme.
    const deadline = row.deadline_at ? Date.parse(row.deadline_at) : null;
    if (deadline && clock.nowMs() > deadline && current.status === 'running') {
      repository.appendBatch(run.id, [{
        type: 'agent.error', at: clock.nowIso(),
        payload: { message: 'the run exceeded its time budget and is being stopped', code: 'TIMEOUT' },
      }]);
      runs.transition(run.id, 'cancelling', { reason: 'timeout' });
      await this.#deps.runner.cancel({ host: run.executionHost, runId: run.id }).catch(() => undefined);
      repository.db.prepare("UPDATE runs SET error_code = 'TIMEOUT' WHERE id = ?").run(run.id);
      return;
    }

    // Ni proceso, ni estado publicado, ni nada nuevo que leer: puede ser un arranque a medias.
    // Se le da un margen antes de declararlo perdido, y nunca se relanza.
    if (!poll.alive && !remoteState) {
      const since = this.#missingSince.get(run.id) ?? clock.nowMs();
      this.#missingSince.set(run.id, since);
      const grace = this.#deps.lostGraceMs ?? 15_000;
      if (clock.nowMs() - since > grace) {
        runs.transition(run.id, 'failed', {
          reason: 'runner lost',
          errorCode: 'RUNNER_LOST',
          errorMessage: `no tmux session and no status file for run ${run.id} on ${run.executionHost}`,
        });
        this.#missingSince.delete(run.id);
      }
      return;
    }
    this.#missingSince.delete(run.id);
  }

  async #finishFromRemote(runId: string, remoteState: NonNullable<PollResult['status']>['state'], poll: PollResult): Promise<void> {
    const { runs, repository, clock } = this.#deps;
    const current = repository.find(runId) as Run;
    let status = statusToRunStatus(remoteState);

    // Si se pidió cancelar y el proceso acabó por su cuenta con error, el estado honesto es
    // `cancelled`: lo que ocurrió es que lo paramos.
    if (current.status === 'cancelling' && (status === 'failed' || status === 'cancelled')) {
      status = current.errorCode === 'TIMEOUT' ? 'timed_out' : 'cancelled';
    }

    const exitCode = poll.status?.exitCode ?? null;
    const failed = status === 'failed';
    // Un fallo que ocurre antes del primer evento —un cwd que no existe, un binario que no está—
    // sólo deja rastro en stderr. Sin esto, el operador recibe «salió con código 2» y a buscarse
    // la vida.
    const stderrTail = poll.stderr.trim().split('\n').filter(Boolean).at(-1) ?? null;
    const extraEvents = failed && stderrTail
      ? [{ type: 'agent.error' as const, at: clock.nowIso(), payload: { message: stderrTail, code: 'AGENT_FAILED' } }]
      : [];
    runs.transition(runId, status, {
      reason: `runner reported ${remoteState}`,
      exitCode,
      ...(extraEvents.length ? { extraEvents } : {}),
      ...(failed ? {
        errorCode: current.errorCode ?? 'AGENT_FAILED',
        errorMessage: current.errorMessage ?? stderrTail ?? `the agent exited with code ${String(exitCode)}`,
      } : {}),
      ...(current.resultOk === null && status === 'completed' ? { resultOk: true } : {}),
    });
    this.#missingSince.delete(runId);
    this.#cancelSentAt.delete(runId);
  }
}
