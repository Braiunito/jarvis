/**
 * `RunService`: el único sitio donde un run cambia de estado.
 *
 * Ninguna ruta escribe `status` directamente. Una transición fuera de la tabla de
 * `RUN_TRANSITIONS` es un fallo de programación, no un «best effort», y se trata como tal.
 *
 * La regla que hace esto recuperable: el core confirma intención y estado en SQLite; el host
 * confirma proceso y salida en el spool. Ante duda sobre si un comando con efectos ocurrió,
 * fallar con evidencia es preferible a duplicarlo.
 */
import { createHash } from 'node:crypto';
import type {
  AgentEvent, CreateRunRequest, PermissionProfile, Run, RunEvent, RunEventType, RunStatus,
  TargetPlan, UserIdentity, Workspace,
} from '@jarvis/contracts';
import { canTransition, isTerminalStatus, JarvisError, PERMISSION_PROFILES } from '@jarvis/contracts';
import {
  getAdapter, remoteScript, resolveTarget, strategyPreamble, tmuxRunName,
  type CapabilityCache, type RunnerMeta, type SshConfig,
} from '@jarvis/agent-adapters';
import type { Clock } from '../platform/clock.js';
import { newRunId } from '../platform/ids.js';
import type { AuditLog } from '../platform/audit.js';
import type { WorkspaceService } from '../workspaces/use-cases.js';
import type { RunEventBus } from './events-bus.js';
import type { EventInput, RunRepository } from './repository.js';
import type { RemoteRunner } from './remote-runner.js';
import type { AttachmentService } from '../attachments/service.js';

export interface RunServiceDeps {
  repository: RunRepository;
  runner: RemoteRunner;
  workspaces: WorkspaceService;
  capabilities: CapabilityCache;
  bus: RunEventBus;
  audit: AuditLog;
  clock: Clock;
  sshConfig: SshConfig;
  attachments?: AttachmentService;
  limits: {
    maxConcurrentRuns: number;
    defaultPermissionProfile: PermissionProfile;
    allowYolo: boolean;
    runTimeoutMs: number;
    maxToolOutputBytes: number;
    maxEventTextBytes: number;
    remotePath: string;
  };
}

const TRUNCATED_PREFIX = '[earlier output omitted]\n';

/** Recorta por el final conservando lo último, que es lo que se estaba leyendo. */
function boundedTail(value: string, maxBytes: number): { text: string; truncated: boolean; originalBytes: number } {
  const originalBytes = Buffer.byteLength(value, 'utf8');
  if (originalBytes <= maxBytes) return { text: value, truncated: false, originalBytes };
  const room = Math.max(0, maxBytes - Buffer.byteLength(TRUNCATED_PREFIX, 'utf8'));
  let tail = value.slice(-room);
  while (tail && Buffer.byteLength(tail, 'utf8') > room) {
    tail = tail.slice(Math.max(1, Math.ceil(tail.length * 0.05)));
  }
  return { text: `${TRUNCATED_PREFIX}${tail}`, truncated: true, originalBytes };
}

export class RunService {
  readonly #deps: RunServiceDeps;

  /**
   * Qué hacer cuando un run llega a estado terminal.
   *
   * Es un gancho y no una dependencia porque lo que cuelga de aquí es accesorio —poner nombre al
   * workspace, por ejemplo—: si falla, el run ya terminó igual y nadie debería enterarse.
   */
  onRunFinished: ((run: Run, prompt: string) => void) | null = null;

  constructor(deps: RunServiceDeps) {
    this.#deps = deps;
  }

  get repository(): RunRepository { return this.#deps.repository; }
  get bus(): RunEventBus { return this.#deps.bus; }

  // ---- consulta -----------------------------------------------------------

  find(runId: string): Run | null { return this.#deps.repository.find(runId); }

  require(runId: string): Run {
    const run = this.find(runId);
    if (!run) throw new JarvisError('NOT_FOUND', `unknown run ${runId}`, { scope: { runId } });
    return run;
  }

  events(runId: string, afterSeq: number): RunEvent[] {
    return this.#deps.repository.events(runId, { afterSeq });
  }

  listRecent(limit?: number): Run[] { return this.#deps.repository.listRecent(limit); }
  listByWorkspace(workspaceId: string, limit?: number): Run[] {
    return this.#deps.repository.listByWorkspace(workspaceId, limit);
  }

  // ---- creación -----------------------------------------------------------

  /**
   * Resuelve el destino efectivo *antes* de crear nada: lo que se muestra en el composer es
   * exactamente lo que se guarda como snapshot y lo que la auditoría afirma después.
   */
  async planTarget(workspace: Workspace, request: { permissionProfile?: PermissionProfile; preferredStrategy?: 'auto' | 'A' | 'B' }): Promise<TargetPlan> {
    const permissionProfile = request.permissionProfile ?? this.#deps.limits.defaultPermissionProfile;
    if (!PERMISSION_PROFILES.includes(permissionProfile)) {
      throw new JarvisError('BAD_REQUEST', `unknown permission profile: ${permissionProfile}`);
    }
    if (permissionProfile === 'yolo' && !this.#deps.limits.allowYolo) {
      throw new JarvisError('PERMISSION_PROFILE_DISABLED',
        'the "yolo" profile is disabled here (set JARVIS_ALLOW_YOLO=1 only if you understand that '
        + 'the agent may run anything, unsandboxed)');
    }
    return resolveTarget({
      sessionHost: workspace.ref.host,
      provider: workspace.ref.provider,
      permissionProfile,
      cwd: workspace.cwd,
      preferred: request.preferredStrategy ?? 'auto',
      capabilities: this.#deps.capabilities,
      bastionHost: this.#deps.sshConfig.bastionHost,
    });
  }

  /**
   * Crea el run y devuelve enseguida: la ejecución larga no cuelga de esta petición.
   *
   * La clave de idempotencia protege el caso real del móvil — doble toque, reintento tras
   * reconectar — devolviendo el mismo run en vez de creando otro.
   */
  async create(request: CreateRunRequest, user: UserIdentity, requestId: string): Promise<{ run: Run; target: TargetPlan; replayed: boolean }> {
    const { repository, workspaces, clock, limits } = this.#deps;
    const workspace = workspaces.require(request.workspaceId);

    const hash = createHash('sha256').update(JSON.stringify({
      workspaceId: request.workspaceId,
      prompt: request.prompt,
      permissionProfile: request.permissionProfile ?? null,
      preferredStrategy: request.preferredStrategy ?? null,
      model: request.model ?? null,
      attachmentIds: request.attachmentIds ?? [],
      user: user.userId,
    })).digest('hex');

    if (request.idempotencyKey) {
      const previous = repository.findIdempotent('createRun', request.idempotencyKey);
      if (previous) {
        if (previous.requestHash !== hash) {
          throw new JarvisError('IDEMPOTENCY_CONFLICT',
            'that idempotency key was already used with a different request');
        }
        const run = previous.resourceId ? repository.find(previous.resourceId) : null;
        if (run) {
          return {
            run,
            target: JSON.parse(previous.responseJson ?? '{}') as TargetPlan,
            replayed: true,
          };
        }
      }
    }

    const prompt = String(request.prompt ?? '');
    const attachmentIds = request.attachmentIds ?? [];
    if (!prompt.trim() && attachmentIds.length === 0) {
      throw new JarvisError('BAD_REQUEST', 'a prompt or an attachment is required');
    }
    if (repository.countActive() >= limits.maxConcurrentRuns) {
      throw new JarvisError('RATE_LIMITED',
        `too many runs in flight (limit ${limits.maxConcurrentRuns}); cancel one or wait`);
    }

    const target = await this.planTarget(workspace, request);
    const runId = newRunId();
    const at = clock.nowIso();

    const insertRun = (): void => repository.insert({
      id: runId,
      workspaceId: workspace.id,
      createdBy: user.username,
      provider: workspace.ref.provider,
      sessionId: workspace.ref.sessionId,
      prompt,
      workHost: target.workHost,
      executionHost: target.executionHost,
      strategy: target.strategy,
      strategyReason: target.reason,
      cwd: target.cwd,
      permissionProfile: target.permissionProfile,
      model: request.model ?? null,
      attempt: 1,
      parentRunId: null,
      remoteName: tmuxRunName(runId),
      remoteSpoolDir: this.#deps.runner.layout(runId).dir,
      createdAt: at,
      deadlineAt: new Date(clock.nowMs() + limits.runTimeoutMs).toISOString(),
    });

    /**
     * Crear el run y reclamar sus adjuntos es una sola escritura.
     *
     * Si el adjunto es de otra persona o de otro host, no queda un run huérfano esperando a que
     * el supervisor lo prepare: la transacción entera se deshace y no ha existido nunca.
     */
    repository.db.transaction(() => {
      insertRun();
      if (attachmentIds.length && this.#deps.attachments) {
        this.#deps.attachments.claim(attachmentIds, { user, runId, executionHost: target.executionHost });
      }
    })();

    repository.appendBatch(runId, [{
      type: 'run.target',
      at,
      payload: { target, workspace: workspace.id, createdBy: user.username, attachmentIds },
    }]);

    this.#deps.audit.record({
      actorUser: user.username,
      eventType: 'run.created',
      requestId,
      workspaceId: workspace.id,
      runId,
      host: target.executionHost,
      // Se audita el destino y el permiso, nunca el texto del prompt.
      payload: {
        provider: workspace.ref.provider,
        strategy: target.strategy,
        workHost: target.workHost,
        permissionProfile: target.permissionProfile,
        promptBytes: Buffer.byteLength(prompt, 'utf8'),
        attachments: attachmentIds.length,
      },
    });

    if (request.idempotencyKey) {
      repository.saveIdempotent('createRun', request.idempotencyKey, hash,
        { type: 'run', id: runId }, JSON.stringify(target), at,
        new Date(clock.nowMs() + 24 * 3600 * 1000).toISOString());
    }

    const run = repository.find(runId) as Run;
    this.#deps.bus.notify(runId);
    return { run, target, replayed: false };
  }

  // ---- transiciones -------------------------------------------------------

  /**
   * Cambia el estado registrando el cambio como evento en la misma transacción.
   *
   * Un estado terminal es inmutable: llegar dos veces al mismo terminal es idempotente y llegar
   * a otro distinto es un error, no una corrección.
   */
  transition(runId: string, to: RunStatus, patch: {
    reason?: string;
    exitCode?: number | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    resultOk?: boolean | null;
    resultSummary?: string | null;
    extraEvents?: EventInput[];
  } = {}): Run {
    const { repository, clock } = this.#deps;
    const row = repository.row(runId);
    if (!row) throw new JarvisError('NOT_FOUND', `unknown run ${runId}`, { scope: { runId } });
    const from = row.status as RunStatus;
    if (from === to) return repository.find(runId) as Run;

    if (isTerminalStatus(from)) {
      throw new JarvisError('INVALID_TRANSITION',
        `run ${runId} is already ${from} and cannot become ${to}`, { scope: { runId } });
    }
    if (!canTransition(from, to)) {
      throw new JarvisError('INVALID_TRANSITION',
        `run ${runId} cannot go from ${from} to ${to}`, { scope: { runId } });
    }

    const at = clock.nowIso();
    const events: EventInput[] = [
      ...(patch.extraEvents ?? []),
      { type: 'run.status', at, payload: { from, to, reason: patch.reason ?? null } },
    ];

    repository.appendBatch(runId, events, {
      status: to,
      ...(to === 'running' && !row.started_at ? { startedAt: at } : {}),
      ...(isTerminalStatus(to) ? { finishedAt: at } : {}),
      ...(patch.exitCode !== undefined ? { exitCode: patch.exitCode } : {}),
      ...(patch.errorCode !== undefined ? { errorCode: patch.errorCode } : {}),
      ...(patch.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {}),
      ...(patch.resultOk !== undefined ? { resultOk: patch.resultOk } : {}),
      ...(patch.resultSummary !== undefined ? { resultSummary: patch.resultSummary } : {}),
    });

    if (isTerminalStatus(to) && this.#deps.attachments) {
      // Los adjuntos de un run terminado ya no le hacen falta a nadie.
      void this.#deps.attachments.releaseForRun(runId);
    }

    this.#deps.bus.notify(runId);
    const updated = repository.find(runId) as Run;
    if (isTerminalStatus(to) && this.onRunFinished) {
      try {
        this.onRunFinished(updated, row.prompt);
      } catch {
        // Lo accesorio no puede estropear una transición que ya está confirmada.
      }
    }
    return updated;
  }

  // ---- preparación remota -------------------------------------------------

  /** Construye el comando del agente con el preámbulo de estrategia y el contexto de adjuntos. */
  buildAgentCommand(run: Run, prompt: string, attachmentContext: string | null): string {
    const adapter = getAdapter(run.provider);
    const preamble = strategyPreamble({
      strategy: run.strategy,
      workHost: run.workHost,
      cwd: run.cwd,
      provider: run.provider,
      sessionId: run.sessionId,
    });
    const finalPrompt = [preamble, attachmentContext, prompt].filter(Boolean).join('\n\n');

    // Bajo estrategia A el agente corre en el bastión y la sesión pertenece a otra máquina: su
    // transcript no está aquí, así que `--resume` fallaría y `sourceRoot` apuntaría a un path del
    // host de trabajo que aquí no existe.
    const sessionIsLocal = run.strategy !== 'A';
    const { argv, env } = adapter.buildRun({
      sessionId: sessionIsLocal ? run.sessionId : null,
      prompt: finalPrompt,
      permissionProfile: run.permissionProfile,
      model: run.model,
      resume: sessionIsLocal,
    });
    return remoteScript({
      argv,
      cwd: run.cwd,
      env,
      pathExtra: this.#deps.limits.remotePath,
      stdinFromNull: true,
    });
  }

  async prepare(runId: string): Promise<Run> {
    const { repository, runner, clock } = this.#deps;
    const row = repository.row(runId);
    if (!row) throw new JarvisError('NOT_FOUND', `unknown run ${runId}`, { scope: { runId } });
    const run = this.require(runId);
    if (run.status !== 'queued') return run;

    this.transition(runId, 'preparing');

    const attachmentContext = this.#deps.attachments?.promptFor(runId) ?? null;
    const agentCommand = this.buildAgentCommand(run, row.prompt, attachmentContext);
    const meta: RunnerMeta = {
      version: 1,
      runId,
      provider: run.provider,
      target: {
        workHost: run.workHost,
        executionHost: run.executionHost,
        strategy: run.strategy,
        reason: run.strategyReason,
        cwd: run.cwd,
        provider: run.provider,
        permissionProfile: run.permissionProfile,
      },
      createdAt: run.createdAt,
      createdBy: run.createdBy,
      wrapper: 'v1',
    };

    try {
      const { outcome } = await runner.prepare({
        host: run.executionHost, runId, meta, agentCommand, cwd: run.cwd,
      });
      // `already-running` no es un error: es exactamente lo que la idempotencia debe producir si
      // el core murió entre mandar el comando y confirmarlo.
      if (outcome === 'already-finished' || outcome === 'already-running' || outcome === 'started') {
        return this.transition(runId, 'running', { reason: outcome });
      }
      return this.require(runId);
    } catch (error) {
      const failure = error instanceof JarvisError ? error : new JarvisError('INTERNAL', (error as Error).message);
      return this.transition(runId, 'failed', {
        reason: 'prepare failed',
        errorCode: failure.code,
        errorMessage: failure.message,
        extraEvents: [{ type: 'agent.error', at: clock.nowIso(), payload: { message: failure.message, code: failure.code } }],
      });
    }
  }

  // ---- ingesta ------------------------------------------------------------

  /**
   * Normaliza un trozo del spool y lo confirma.
   *
   * Sólo se consumen líneas completas: el resto de bytes se relee en el próximo poll, que es
   * la razón por la que un corte a mitad de línea no produce un evento inventado.
   */
  ingest(runId: string, chunk: string, offsetBefore: number): { consumedBytes: number; events: number } {
    if (!chunk) return { consumedBytes: 0, events: 0 };
    const lastNewline = chunk.lastIndexOf('\n');
    if (lastNewline === -1) return { consumedBytes: 0, events: 0 };
    const usable = chunk.slice(0, lastNewline + 1);
    const consumedBytes = Buffer.byteLength(usable, 'utf8');

    const run = this.require(runId);
    const adapter = getAdapter(run.provider);
    const at = this.#deps.clock.nowIso();
    const events: EventInput[] = [];
    let sessionId: string | null | undefined;
    let resultOk: boolean | null | undefined;
    let resultSummary: string | null | undefined;

    for (const line of usable.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // No toda línea es JSON: banners y prints sueltos pasan. Se conservan visibles.
        events.push({ type: 'agent.raw', at, payload: { text: line.slice(0, 4000) } });
        continue;
      }
      const normalized = adapter.normalize(parsed);
      for (const event of Array.isArray(normalized) ? normalized : [normalized]) {
        if (!event) continue;
        const bounded = this.#bound(event);
        events.push({ type: `agent.${event.type}` as RunEventType, at, payload: bounded });
        if ('sessionId' in event && event.sessionId) sessionId = event.sessionId;
        if (event.type === 'result') {
          resultOk = event.ok;
          resultSummary = typeof event.text === 'string' ? event.text.slice(0, 4000) : null;
        }
      }
    }

    if (!events.length) {
      this.#deps.repository.updateCursor(runId, offsetBefore + consumedBytes);
      return { consumedBytes, events: 0 };
    }

    this.#deps.repository.appendBatch(runId, events, {
      cursorBytes: offsetBefore + consumedBytes,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(resultOk !== undefined ? { resultOk } : {}),
      ...(resultSummary !== undefined ? { resultSummary } : {}),
    });
    this.#deps.bus.notify(runId);
    return { consumedBytes, events: events.length };
  }

  /** Aplica los presupuestos por evento. Nada se recorta en silencio: va marcado y con tamaño. */
  #bound(event: AgentEvent): AgentEvent {
    const { maxToolOutputBytes, maxEventTextBytes } = this.#deps.limits;
    if (event.type === 'text' || event.type === 'reasoning') {
      const bounded = boundedTail(event.text, maxEventTextBytes);
      if (!bounded.truncated) return event;
      return { ...event, text: bounded.text };
    }
    if (event.type === 'tool') {
      const tool = { ...event.tool };
      if (typeof tool.output === 'string') {
        const bounded = boundedTail(tool.output, maxToolOutputBytes);
        if (bounded.truncated) {
          tool.output = bounded.text;
          tool.truncated = true;
          tool.originalBytes = bounded.originalBytes;
        }
      }
      if (tool.input !== undefined) {
        const serialized = JSON.stringify(tool.input) ?? '';
        if (Buffer.byteLength(serialized, 'utf8') > maxToolOutputBytes) {
          tool.input = { truncated: true, preview: boundedTail(serialized, maxToolOutputBytes).text };
          tool.truncated = true;
          tool.originalBytes = Buffer.byteLength(serialized, 'utf8');
        }
      }
      return { ...event, tool };
    }
    return event;
  }

  // ---- cancelación --------------------------------------------------------

  /**
   * Pide parar. Es idempotente y **no** marca `cancelled` hasta observar que el proceso remoto
   * terminó o que quedó inequívocamente ausente: decir «parado» antes de tiempo es mentir.
   */
  async cancel(runId: string, user: UserIdentity, requestId: string): Promise<Run> {
    const run = this.require(runId);
    if (isTerminalStatus(run.status)) return run;

    const at = this.#deps.clock.nowIso();
    if (run.status !== 'cancelling') {
      this.#deps.repository.appendBatch(runId, [
        { type: 'run.cancel_requested', at, payload: { by: user.username } },
      ], { cancelRequestedAt: at });
      this.transition(runId, 'cancelling', { reason: 'operator interrupt' });
    }

    this.#deps.audit.record({
      actorUser: user.username, eventType: 'run.cancel_requested', requestId,
      runId, workspaceId: run.workspaceId, host: run.executionHost,
    });

    try {
      await this.#deps.runner.cancel({ host: run.executionHost, runId });
    } catch (error) {
      // No se pudo hablar con el host: el run se queda en `cancelling` y Health lo enseña. No se
      // finge una cancelación que no se ha podido confirmar.
      this.#deps.repository.appendBatch(runId, [{
        type: 'agent.error', at: this.#deps.clock.nowIso(),
        payload: { message: `could not signal the runner: ${(error as Error).message}`, code: 'HOST_UNREACHABLE' },
      }]);
      this.#deps.bus.notify(runId);
    }
    return this.require(runId);
  }

  /** Segundo intento, más duro, cuando el agente ignoró la señal amable. */
  async escalateCancel(runId: string): Promise<void> {
    const run = this.require(runId);
    if (isTerminalStatus(run.status)) return;
    await this.#deps.runner.cancel({ host: run.executionHost, runId, escalate: true });
  }

  /** Reintentar es un run nuevo enlazado al anterior: nunca se rebobina el original. */
  async retry(runId: string, user: UserIdentity, requestId: string): Promise<{ run: Run; target: TargetPlan; replayed: boolean }> {
    const previous = this.require(runId);
    if (!isTerminalStatus(previous.status)) {
      throw new JarvisError('CONFLICT', 'the run has not finished yet', { scope: { runId } });
    }
    const row = this.#deps.repository.row(runId);
    const created = await this.create({
      workspaceId: previous.workspaceId,
      prompt: row?.prompt ?? '',
      permissionProfile: previous.permissionProfile,
      model: previous.model,
    }, user, requestId);
    this.#deps.repository.db.prepare('UPDATE runs SET parent_run_id = ?, attempt = ? WHERE id = ?')
      .run(previous.id, previous.attempt + 1, created.run.id);
    return { ...created, run: this.require(created.run.id) };
  }
}
