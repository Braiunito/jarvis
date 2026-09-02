/**
 * Persistencia de workspaces y borradores. SQL explícito: el contrato real está a la vista.
 */
import type { Database as Db } from 'better-sqlite3';
import type { Draft, Provider, SessionRef, Workspace } from '@jarvis/contracts';

export interface WorkspaceRow {
  id: string;
  session_host: string;
  provider: string;
  session_id: string;
  cwd: string | null;
  source_root: string | null;
  title: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  last_opened_at: string | null;
  provenance: string;
  source_installation_id: string | null;
  source_conversation_id: string | null;
}

export const toWorkspace = (row: WorkspaceRow): Workspace => ({
  id: row.id,
  ref: { host: row.session_host, provider: row.provider as Provider, sessionId: row.session_id },
  cwd: row.cwd,
  sourceRoot: row.source_root,
  title: row.title,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastOpenedAt: row.last_opened_at,
  provenance: row.provenance as Workspace['provenance'],
});

export class WorkspaceRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  findById(id: string): Workspace | null {
    const row = this.#db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined;
    return row ? toWorkspace(row) : null;
  }

  findByRef(ref: SessionRef): Workspace | null {
    const row = this.#db.prepare(
      'SELECT * FROM workspaces WHERE session_host = ? AND provider = ? AND session_id = ?',
    ).get(ref.host, ref.provider, ref.sessionId) as WorkspaceRow | undefined;
    return row ? toWorkspace(row) : null;
  }

  findBySource(installationId: string, conversationId: string): Workspace | null {
    const row = this.#db.prepare(
      'SELECT * FROM workspaces WHERE source_installation_id = ? AND source_conversation_id = ?',
    ).get(installationId, conversationId) as WorkspaceRow | undefined;
    return row ? toWorkspace(row) : null;
  }

  insert(workspace: Workspace, source?: { installationId: string; conversationId: string }): void {
    this.#db.prepare(`INSERT INTO workspaces
      (id, session_host, provider, session_id, cwd, source_root, title, created_by, created_at,
       updated_at, last_opened_at, provenance, source_installation_id, source_conversation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      workspace.id, workspace.ref.host, workspace.ref.provider, workspace.ref.sessionId,
      workspace.cwd, workspace.sourceRoot, workspace.title, workspace.createdBy,
      workspace.createdAt, workspace.updatedAt, workspace.lastOpenedAt, workspace.provenance,
      source?.installationId ?? null, source?.conversationId ?? null,
    );
  }

  /**
   * Reabrir una sesión refresca lo que el índice sabe: dónde trabaja y cómo se llama.
   *
   * Con una excepción que no es negociable: **el título que escribió una persona no se toca**. El
   * explorador manda el título del índice en cada apertura, así que sin esta condición volver a
   * pulsar la misma sesión deshacía el nombre que alguien puso a mano — la misma regresión que el
   * stack anterior tenía con el título automático, entrando por otra puerta.
   */
  touch(id: string, at: string, patch: { cwd?: string | null; sourceRoot?: string | null; title?: string | null } = {}): void {
    this.#db.prepare(`UPDATE workspaces SET
        last_opened_at = ?,
        updated_at = ?,
        cwd = COALESCE(?, cwd),
        source_root = COALESCE(?, source_root),
        title = CASE WHEN title_source = 'user' THEN title ELSE COALESCE(?, title) END
      WHERE id = ?`).run(at, at, patch.cwd ?? null, patch.sourceRoot ?? null, patch.title ?? null, id);
  }

  recent(limit = 20): Workspace[] {
    const rows = this.#db.prepare(
      'SELECT * FROM workspaces ORDER BY COALESCE(last_opened_at, updated_at) DESC LIMIT ?',
    ).all(limit) as WorkspaceRow[];
    return rows.map(toWorkspace);
  }

  all(): Workspace[] {
    return (this.#db.prepare('SELECT * FROM workspaces').all() as WorkspaceRow[]).map(toWorkspace);
  }

  // ---- borradores ---------------------------------------------------------

  getDraft(workspaceId: string, userId: string): Draft | null {
    const row = this.#db.prepare(
      'SELECT workspace_id, body, version, updated_at FROM drafts WHERE workspace_id = ? AND user_id = ?',
    ).get(workspaceId, userId) as { workspace_id: string; body: string; version: number; updated_at: string } | undefined;
    if (!row) return null;
    return { workspaceId: row.workspace_id, body: row.body, version: row.version, updatedAt: row.updated_at };
  }

  /**
   * Escritura con compare-and-swap.
   *
   * Devuelve null cuando la versión esperada no es la que hay: dos pestañas no pueden perderse
   * el trabajo la una a la otra en silencio.
   */
  putDraft(workspaceId: string, userId: string, body: string, expectedVersion: number, at: string): Draft | null {
    return this.#db.transaction((): Draft | null => {
      const current = this.getDraft(workspaceId, userId);
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== expectedVersion) return null;
      const nextVersion = currentVersion + 1;
      this.#db.prepare(`INSERT INTO drafts (workspace_id, user_id, body, version, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, user_id) DO UPDATE SET body = excluded.body,
          version = excluded.version, updated_at = excluded.updated_at`)
        .run(workspaceId, userId, body, nextVersion, at);
      return { workspaceId, body, version: nextVersion, updatedAt: at };
    })();
  }

  clearDraft(workspaceId: string, userId: string, at: string): void {
    const current = this.getDraft(workspaceId, userId);
    if (!current) return;
    this.#db.prepare('UPDATE drafts SET body = ?, version = ?, updated_at = ? WHERE workspace_id = ? AND user_id = ?')
      .run('', current.version + 1, at, workspaceId, userId);
  }
}
