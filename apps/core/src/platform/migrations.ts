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
  {
    version: 7,
    name: 'workspace_titled_at',
    sql: `
      -- Cuándo se puso el título. Es lo que sostiene la ventana de frescura: sin esta marca, entrar
      -- dos veces seguidas en un workspace costaba dos llamadas al modelo y podía cambiarle el
      -- nombre a alguien mientras lo estaba mirando.
      ALTER TABLE workspaces ADD COLUMN titled_at TEXT;
    `,
  },
  {
    version: 8,
    name: 'run_acknowledged',
    sql: `
      -- Cuándo alguien dio por visto un trabajo que pedía atención.
      --
      -- «Requieren atención» contaba todo lo que había fallado alguna vez, así que el aviso de la
      -- navegación no bajaba nunca: un fallo de hace tres días seguía pidiendo lo mismo que uno de
      -- hace un minuto. Un contador que no se puede vaciar deja de mirarse, y entonces no avisa de
      -- nada. Esto no borra nada: el trabajo y sus eventos siguen enteros, sólo deja de reclamar.
      ALTER TABLE runs ADD COLUMN acknowledged_at TEXT;
      ALTER TABLE runs ADD COLUMN acknowledged_by TEXT;
      CREATE INDEX idx_runs_attention ON runs (status, acknowledged_at);
    `,
  },
  {
    version: 9,
    name: 'workspace_session_pending',
    sql: `
      -- Una sesión que se estrena desde Jarvis y cuyo identificador todavía no ha confirmado el
      -- agente.
      --
      -- Claude deja fijar el suyo con --session-id, así que ahí nace ya definitivo. Codex y
      -- OpenCode generan el propio y lo dicen en su primer evento: hasta entonces el workspace
      -- lleva uno provisional, y esta marca es lo que permite sustituirlo **una vez** sin abrir la
      -- puerta a que la identidad de un workspace cambie porque sí (ADR-005).
      ALTER TABLE workspaces ADD COLUMN session_pending INTEGER NOT NULL DEFAULT 0;

      -- El trabajo que **estrena** la conversación en vez de continuarla. Lo sabe el run y no el
      -- workspace porque es una propiedad de esa ejecución: sólo el primero arranca sin reanudar,
      -- y los siguientes ya tienen algo que continuar.
      ALTER TABLE runs ADD COLUMN starts_session INTEGER NOT NULL DEFAULT 0;

      -- Si la conversación ya existe en la máquina. Una sesión creada desde Jarvis no existe allí
      -- hasta que arranca su primer trabajo, y eso permite crear el workspace vacío y escribir la
      -- primera tarea con calma en el compositor, como se hace con cualquier otra sesión.
      ALTER TABLE workspaces ADD COLUMN session_launched INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    version: 10,
    name: 'workspace_cwd_source',
    sql: `
      -- De dónde salió el directorio de trabajo del workspace.
      --
      -- Hasta ahora el \`cwd\` sólo podía venir del índice, así que no hacía falta distinguir. Con
      -- la derivación de TEC-11 el core puede **deducirlo** del nombre del directorio de proyecto
      -- de Claude Code y confirmarlo contra la máquina, y eso es un dato de otra clase: acertado
      -- casi siempre, adivinado al fin y al cabo. Marcarlo permite que la interfaz lo diga en vez
      -- de presentarlo como un hecho, y que un directorio escrito por una persona no lo pise
      -- nunca una deducción posterior.
      ALTER TABLE workspaces ADD COLUMN cwd_source TEXT;
    `,
  },
  {
    version: 11,
    name: 'conversations',
    sql: `
      -- La conversación con el asistente local (ADR-009).
      --
      -- No es un plan. Un plan es una lista de pasos con checkpoint que puede pasarse cuatro horas
      -- esperando a que termine un run; una conversación es un ida y vuelta que se lee de arriba
      -- abajo. Comparten lo que importa —herramientas, aprobaciones, auditoría— y por eso una
      -- conversación puede acabar creando un plan, pero meterlas en la misma tabla obligaría a que
      -- una de las dos fingiera ser la otra.
      --
      -- \`workspace_id\` admite NULL a propósito: preguntar por el servidor no exige haber abierto
      -- antes una sesión de agente. Y va con ON DELETE SET NULL y no CASCADE porque borrar un
      -- workspace no debe llevarse por delante lo que se habló: la conversación deja de estar
      -- atada a esa sesión, no deja de haber ocurrido.
      CREATE TABLE conversations (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        created_by      TEXT NOT NULL,
        workspace_id    TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
        autonomy        TEXT NOT NULL DEFAULT 'manual',
        status          TEXT NOT NULL DEFAULT 'idle',
        source          TEXT NOT NULL DEFAULT 'local',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        last_message_at TEXT
      );
      CREATE INDEX idx_conversations_updated ON conversations (updated_at DESC);
      CREATE INDEX idx_conversations_workspace ON conversations (workspace_id);

      -- Un mensaje. \`seq\` es identidad pública dentro de la conversación y no se reutiliza jamás:
      -- es lo que hace que reconectar el stream con Last-Event-ID devuelva exactamente lo que
      -- falta. El UNIQUE lo garantiza incluso si dos turnos entraran a la vez, que es justo el
      -- caso en el que un contador en memoria se equivoca.
      CREATE TABLE chat_messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        seq             INTEGER NOT NULL,
        role            TEXT NOT NULL,
        text            TEXT NOT NULL,
        tool_name       TEXT,
        tool_input      TEXT,
        tool_ok         INTEGER,
        source          TEXT,
        model_id        TEXT,
        approval_id     TEXT,
        run_ids         TEXT NOT NULL DEFAULT '[]',
        created_at      TEXT NOT NULL,
        UNIQUE (conversation_id, seq)
      );
      CREATE INDEX idx_chat_messages_conv ON chat_messages (conversation_id, seq);

      -- Una aprobación puede nacer en una conversación y no en un plan. Quien la resuelve necesita
      -- saber a dónde volver, y sobre todo: el motor que la ejecuta al aprobarla es distinto —un
      -- plan lanza un run, una conversación puede además ejecutar una capacidad MCP—.
      ALTER TABLE approvals ADD COLUMN conversation_id TEXT;
      CREATE INDEX idx_approvals_conversation ON approvals (conversation_id)
        WHERE conversation_id IS NOT NULL;

      -- Para qué paso se concedió salir a la nube.
      --
      -- Un número y no un booleano porque el permiso es **para un turno**, no para el plan: se
      -- guarda el ordinal del paso que puede pensarse fuera, y el siguiente vuelve a casa solo,
      -- sin que nadie tenga que acordarse de apagarlo. Un booleano "escalated = 1" se queda
      -- encendido para siempre y convierte una autorización puntual en una suscripción.
      ALTER TABLE plans ADD COLUMN escalate_for_step INTEGER;
    `,
  },
];
