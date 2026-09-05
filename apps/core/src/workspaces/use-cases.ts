import { randomUUID } from 'node:crypto';
import type {
  Draft, OpenWorkspaceRequest, Provider, SessionRef, UserIdentity, Workspace,
} from '@jarvis/contracts';
import { JarvisError } from '@jarvis/contracts';
import type { Clock } from '../platform/clock.js';
import { newWorkspaceId } from '../platform/ids.js';
import type { AuditLog } from '../platform/audit.js';
import type { WorkspaceRepository } from './repository.js';

export interface WorkspaceServiceDeps {
  repository: WorkspaceRepository;
  clock: Clock;
  audit: AuditLog;
  bastionHost: string;
}

export class WorkspaceService {
  readonly #repository: WorkspaceRepository;
  readonly #clock: Clock;
  readonly #audit: AuditLog;
  readonly #bastionHost: string;

  constructor({ repository, clock, audit, bastionHost }: WorkspaceServiceDeps) {
    this.#repository = repository;
    this.#clock = clock;
    this.#audit = audit;
    this.#bastionHost = bastionHost;
  }

  /**
   * Abrir un workspace es idempotente: la misma `SessionRef` devuelve siempre el mismo workspace.
   *
   * Eso es lo que hace que elegir otra sesión sea una transición atómica y que dos clics rápidos
   * no dejen media interfaz en A y media en B.
   */
  /**
   * Estrenar una sesión: la conversación no existe todavía en la máquina.
   *
   * El identificador lo pone Jarvis. Claude lo acepta tal cual (`--session-id`), así que ahí la
   * sesión nace con su nombre definitivo; Codex y OpenCode generan el suyo y lo dicen al arrancar,
   * y hasta entonces el workspace queda marcado como pendiente para poder adoptarlo una vez.
   */
  startSession(
    { host, provider, cwd, permissionProfile: _permissionProfile }: {
      host: string; provider: Provider; cwd?: string | null; permissionProfile?: string;
    },
    user: UserIdentity,
  ): Workspace {
    const resolvedHost = !host || host === 'local' ? this.#bastionHost : host;
    const at = this.#clock.nowIso();
    const workspace: Workspace = {
      id: newWorkspaceId(),
      ref: { host: resolvedHost, provider, sessionId: randomUUID() },
      cwd: cwd ?? null,
      // La carpeta la eligió quien creó la sesión: ninguna deducción posterior la pisa.
      cwdSource: cwd ? 'user' : null,
      sourceRoot: null,
      title: null,
      createdBy: user.username,
      createdAt: at,
      updatedAt: at,
      lastOpenedAt: at,
      provenance: 'jarvis',
      // Claude respeta el id que se le da; los otros dos lo dirán ellos.
      sessionPending: provider !== 'claude',
      // Todavía no existe al otro lado: existirá cuando arranque su primer trabajo.
      sessionLaunched: false,
    };
    this.#repository.insert(workspace);
    this.#audit.record({
      actorUser: user.username,
      eventType: 'workspace.session_started',
      workspaceId: workspace.id,
      host: resolvedHost,
      payload: { provider, sessionId: workspace.ref.sessionId, pending: workspace.sessionPending },
    });
    return workspace;
  }

  /** Fija el directorio de trabajo, diciendo de dónde salió. Devuelve si llegó a escribirse. */
  setCwd(workspaceId: string, cwd: string, source: 'index' | 'derived' | 'user'): boolean {
    return this.#repository.setCwd(workspaceId, cwd, source, this.#clock.nowIso());
  }

  /** El agente dijo su identificador: se adopta si el workspace lo estaba esperando. */
  adoptSession(workspaceId: string, sessionId: string): void {
    this.#repository.adoptSession(workspaceId, sessionId, this.#clock.nowIso());
  }

  /** La conversación ya existe al otro lado: el siguiente trabajo la continúa. */
  markSessionLaunched(workspaceId: string): void {
    this.#repository.markSessionLaunched(workspaceId);
  }

  open(request: OpenWorkspaceRequest, user: UserIdentity): { workspace: Workspace; created: boolean } {
    const host = !request.ref.host || request.ref.host === 'local' ? this.#bastionHost : request.ref.host;
    const ref = { ...request.ref, host };
    if (!ref.sessionId) throw new JarvisError('BAD_REQUEST', 'a session id is required');

    const existing = this.#repository.findByRef(ref);
    const at = this.#clock.nowIso();
    if (existing) {
      this.#repository.touch(existing.id, at, {
        cwd: request.cwd ?? null,
        sourceRoot: request.sourceRoot ?? null,
        title: request.title ?? null,
      });
      return { workspace: this.#repository.findById(existing.id) as Workspace, created: false };
    }

    const workspace: Workspace = {
      id: newWorkspaceId(),
      ref,
      cwd: request.cwd ?? null,
      sourceRoot: request.sourceRoot ?? null,
      title: request.title ?? null,
      createdBy: user.username,
      createdAt: at,
      updatedAt: at,
      lastOpenedAt: at,
      provenance: 'jarvis',
    };
    this.#repository.insert(workspace);
    this.#audit.record({
      actorUser: user.username,
      eventType: 'workspace.opened',
      workspaceId: workspace.id,
      host: ref.host,
      payload: { provider: ref.provider, sessionId: ref.sessionId },
    });
    return { workspace, created: true };
  }

  /** El workspace de una sesión, si alguien la abrió alguna vez. Es lo que hace `open` idempotente. */
  findByRef(ref: SessionRef): Workspace | null {
    return this.#repository.findByRef(ref);
  }

  /** El workspace, o nada. Para quien pregunta por uno que puede haberse borrado. */
  find(workspaceId: string): Workspace | null {
    return this.#repository.findById(workspaceId) ?? null;
  }

  require(workspaceId: string): Workspace {
    const workspace = this.#repository.findById(workspaceId);
    if (!workspace) throw new JarvisError('NOT_FOUND', `unknown workspace ${workspaceId}`, { scope: { workspaceId } });
    return workspace;
  }

  recent(limit?: number): Workspace[] {
    return this.#repository.recent(limit);
  }

  draft(workspaceId: string, user: UserIdentity): Draft {
    this.require(workspaceId);
    return this.#repository.getDraft(workspaceId, user.userId)
      ?? { workspaceId, body: '', version: 0, updatedAt: this.#clock.nowIso() };
  }

  putDraft(workspaceId: string, user: UserIdentity, body: string, expectedVersion: number): Draft {
    this.require(workspaceId);
    const saved = this.#repository.putDraft(workspaceId, user.userId, body, expectedVersion, this.#clock.nowIso());
    if (!saved) {
      const current = this.#repository.getDraft(workspaceId, user.userId);
      throw new JarvisError('DRAFT_VERSION_CONFLICT',
        `the draft moved on: the server has version ${current?.version ?? 0}`,
        { scope: { workspaceId } });
    }
    return saved;
  }
}
