/**
 * Migraciones: SQL versionado y monotónico.
 *
 * Van en TypeScript en vez de en ficheros `.sql` sueltos por una razón práctica: así el binario
 * compilado lleva el esquema dentro y no hay un paso de build que copiar ficheros ni una ruta que
 * resolver en tiempo de ejecución. El contenido sigue siendo SQL explícito, sin ORM ni DSL.
 *
 * Reglas: una migración aplicada no se edita nunca (el checksum lo impide) y no hay migraciones
 * destructivas mientras la ventana de rollback siga abierta.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core',
    sql: `
      -- Un workspace es la identidad estable de «esta sesión de agente, para Jarvis».
      -- UNIQUE sobre la SessionRef: abrir dos veces la misma sesión da el mismo workspace.
      CREATE TABLE workspaces (
        id                     TEXT PRIMARY KEY,
        session_host           TEXT NOT NULL,
        provider               TEXT NOT NULL,
        session_id             TEXT NOT NULL,
        cwd                    TEXT,
        source_root            TEXT,
        title                  TEXT,
        created_by             TEXT NOT NULL,
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL,
        last_opened_at         TEXT,
        provenance             TEXT NOT NULL DEFAULT 'jarvis',
        source_installation_id TEXT,
        source_conversation_id TEXT,
        UNIQUE (session_host, provider, session_id)
      );
      CREATE UNIQUE INDEX idx_workspaces_source
        ON workspaces (source_installation_id, source_conversation_id)
        WHERE source_installation_id IS NOT NULL AND source_conversation_id IS NOT NULL;
      CREATE INDEX idx_workspaces_opened ON workspaces (last_opened_at DESC);

      -- Borrador por workspace y usuario, con versión para compare-and-swap.
      CREATE TABLE drafts (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id      TEXT NOT NULL,
        body         TEXT NOT NULL,
        version      INTEGER NOT NULL,
        updated_at   TEXT NOT NULL,
        PRIMARY KEY (workspace_id, user_id)
      );

      -- Auditoría operacional: sólo se inserta, nunca se actualiza ni se borra.
      CREATE TABLE audit_events (
        id           TEXT PRIMARY KEY,
        at           TEXT NOT NULL,
        actor_user   TEXT NOT NULL,
        event_type   TEXT NOT NULL,
        request_id   TEXT,
        workspace_id TEXT,
        run_id       TEXT,
        host         TEXT,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX idx_audit_at ON audit_events (at DESC);
      CREATE INDEX idx_audit_run ON audit_events (run_id);

      -- Último snapshot bueno conocido de cuenta/cuota por proveedor y host de ejecución.
      CREATE TABLE usage_snapshots (
        provider       TEXT NOT NULL,
        execution_host TEXT NOT NULL,
        account_json   TEXT,
        limits_json    TEXT NOT NULL,
        fetched_at     TEXT NOT NULL,
        refresh_error  TEXT,
        PRIMARY KEY (provider, execution_host)
      );

      -- Capacidades por host, conservadas para poder seguir sirviendo con la sonda caída.
      CREATE TABLE host_capabilities (
        host          TEXT PRIMARY KEY,
        binaries_json TEXT NOT NULL,
        providers_json TEXT NOT NULL,
        tmux          INTEGER NOT NULL,
        probed_at     TEXT NOT NULL,
        error         TEXT
      );
    `,
  },
  {
    version: 2,
    name: 'runs',
    sql: `
      -- Un run: la intención, el destino efectivo (snapshot) y su estado confirmado.
      CREATE TABLE runs (
        id                  TEXT PRIMARY KEY,
        workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        created_by          TEXT NOT NULL,
        provider            TEXT NOT NULL,
        session_id          TEXT,
        prompt              TEXT NOT NULL,
        work_host           TEXT NOT NULL,
        execution_host      TEXT NOT NULL,
        strategy            TEXT NOT NULL,
        strategy_reason     TEXT,
        cwd                 TEXT,
        permission_profile  TEXT NOT NULL,
        model               TEXT,
        status              TEXT NOT NULL,
        attempt             INTEGER NOT NULL DEFAULT 1,
        parent_run_id       TEXT REFERENCES runs(id),
        remote_name         TEXT,
        remote_spool_dir    TEXT,
        remote_cursor_bytes INTEGER NOT NULL DEFAULT 0,
        last_event_seq      INTEGER NOT NULL DEFAULT -1,
        created_at          TEXT NOT NULL,
        started_at          TEXT,
        finished_at         TEXT,
        cancel_requested_at TEXT,
        deadline_at         TEXT,
        exit_code           INTEGER,
        error_code          TEXT,
        error_message       TEXT,
        result_ok           INTEGER,
        result_summary      TEXT
      );
      CREATE INDEX idx_runs_workspace ON runs (workspace_id, created_at DESC);
      CREATE INDEX idx_runs_status ON runs (status, created_at DESC);

      -- El event log. 'seq' es identidad pública: empieza en 0 por run y nunca se reutiliza.
      CREATE TABLE run_events (
        run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        seq           INTEGER NOT NULL,
        at            TEXT NOT NULL,
        type          TEXT NOT NULL,
        payload_json  TEXT NOT NULL,
        payload_bytes INTEGER NOT NULL,
        compacted     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, seq)
      );

      -- Repetir una mutación con la misma clave devuelve el mismo recurso, no otro.
      CREATE TABLE idempotency_keys (
        scope         TEXT NOT NULL,
        key           TEXT NOT NULL,
        request_hash  TEXT NOT NULL,
        resource_type TEXT,
        resource_id   TEXT,
        response_json TEXT,
        created_at    TEXT NOT NULL,
        expires_at    TEXT NOT NULL,
        PRIMARY KEY (scope, key)
      );

      -- Trabajo interno corto. No representa el proceso remoto: sólo lo que el core debe hacer.
      CREATE TABLE jobs (
        id            TEXT PRIMARY KEY,
        kind          TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id   TEXT NOT NULL,
        status        TEXT NOT NULL,
        available_at  TEXT NOT NULL,
        attempts      INTEGER NOT NULL DEFAULT 0,
        max_attempts  INTEGER NOT NULL DEFAULT 5,
        last_error    TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX idx_jobs_ready ON jobs (status, available_at);

      -- Un lease corto y recuperable. Nunca se mantiene mientras el agente trabaja.
      CREATE TABLE leases (
        resource_type TEXT NOT NULL,
        resource_id   TEXT NOT NULL,
        owner_id      TEXT NOT NULL,
        acquired_at   TEXT NOT NULL,
        expires_at    TEXT NOT NULL,
        PRIMARY KEY (resource_type, resource_id)
      );

      -- Metadata de adjuntos: el contenido es efímero y remoto, esto es lo que permite limpiarlo.
      CREATE TABLE attachments (
        id              TEXT PRIMARY KEY,
        owner_user      TEXT NOT NULL,
        workspace_id    TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
        scope_id        TEXT NOT NULL,
        provider        TEXT NOT NULL,
        session_host    TEXT NOT NULL,
        execution_host  TEXT NOT NULL,
        strategy        TEXT NOT NULL,
        display_name    TEXT NOT NULL,
        mime_type       TEXT NOT NULL,
        size_bytes      INTEGER NOT NULL,
        remote_path     TEXT NOT NULL,
        state           TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        expires_at      TEXT NOT NULL,
        claimed_run_id  TEXT REFERENCES runs(id) ON DELETE SET NULL,
        released_at     TEXT
      );
      CREATE INDEX idx_attachments_state ON attachments (state, expires_at);
    `,
  },
  {
    version: 3,
    name: 'plans',
    sql: `
      -- Un plan del Assistant: lineal a propósito en el MVP.
      CREATE TABLE plans (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        created_by   TEXT NOT NULL,
        objective    TEXT NOT NULL,
        status       TEXT NOT NULL,
        current_step INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        finished_at  TEXT,
        summary      TEXT
      );
      CREATE INDEX idx_plans_status ON plans (status, updated_at DESC);

      CREATE TABLE plan_steps (
        id              TEXT PRIMARY KEY,
        plan_id         TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        ordinal         INTEGER NOT NULL,
        kind            TEXT NOT NULL,
        status          TEXT NOT NULL,
        title           TEXT NOT NULL,
        input_json      TEXT NOT NULL,
        output_json     TEXT,
        run_id          TEXT REFERENCES runs(id) ON DELETE SET NULL,
        approval_id     TEXT,
        idempotency_key TEXT NOT NULL,
        attempt         INTEGER NOT NULL DEFAULT 1,
        available_at    TEXT,
        started_at      TEXT,
        finished_at     TEXT,
        error_code      TEXT,
        UNIQUE (plan_id, ordinal)
      );

      -- Una aprobación es un objeto de dominio: acción, target, permiso y caducidad.
      CREATE TABLE approvals (
        id            TEXT PRIMARY KEY,
        plan_id       TEXT REFERENCES plans(id) ON DELETE CASCADE,
        run_id        TEXT REFERENCES runs(id) ON DELETE SET NULL,
        action_type   TEXT NOT NULL,
        target_json   TEXT NOT NULL,
        action_digest TEXT NOT NULL,
        summary       TEXT NOT NULL,
        requested_by  TEXT NOT NULL,
        requested_at  TEXT NOT NULL,
        expires_at    TEXT NOT NULL,
        status        TEXT NOT NULL,
        resolved_by   TEXT,
        resolved_at   TEXT,
        consumed_at   TEXT
      );
      CREATE INDEX idx_approvals_status ON approvals (status, expires_at);
    `,
  },
  {
    version: 4,
    name: 'import_provenance',
    sql: `
      -- Mensajes traídos de LiteChat. Se guardan aparte del transcript remoto a propósito: lo
      -- importado nunca se atribuye a la sesión del agente.
      CREATE TABLE imported_messages (
        id                TEXT PRIMARY KEY,
        workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        source_message_id TEXT NOT NULL,
        role              TEXT NOT NULL,
        at                TEXT,
        text              TEXT NOT NULL,
        imported_at       TEXT NOT NULL,
        UNIQUE (workspace_id, source_message_id)
      );
    `,
  },
  {
    version: 5,
    name: 'workspace_title_source',
    sql: `
      -- De dónde salió el título. Existe para una regla concreta: el que escribe una persona
      -- gana siempre y no se vuelve a tocar. En el stack anterior el título automático pisaba
      -- el que el usuario había puesto, y eso es de las cosas que más molestan.
      ALTER TABLE workspaces ADD COLUMN title_source TEXT NOT NULL DEFAULT 'index';
    `,
  },
  {
    version: 6,
    name: 'plan_step_position_is_unique',
    sql: `
      -- Dos pasos no pueden ocupar la misma posición de un plan. El motor ya serializa los turnos,
      -- pero esto es lo que hace que una carrera se convierta en un error visible en vez de en un
      -- plan con un paso que nadie pidió: la base sostiene la regla aunque el proceso se equivoque.
      CREATE UNIQUE INDEX plan_steps_plan_ordinal ON plan_steps (plan_id, ordinal);
    `,
  },
];
