/**
 * La conversación en SQLite.
 *
 * Nada de lo que se ve en pantalla vive en memoria: el turno escribe cada mensaje según ocurre y
 * el stream es una proyección de lo escrito, igual que con los eventos de run. Es lo que hace que
 * recargar la página, reconectar o reiniciar el core no pierdan media respuesta.
 */
import type { Database as Db } from 'better-sqlite3';
import type {
  AutonomyMode, ChatMessage, ChatRef, ChatRole, Conversation, ConversationStatus, ModelSource,
} from '@jarvis/contracts';
import type { Clock } from '../platform/clock.js';
import { newChatMessageId, newConversationId } from '../platform/ids.js';

interface ConversationRow {
  id: string; title: string; created_by: string; workspace_id: string | null;
  autonomy: string; status: string; source: string;
  created_at: string; updated_at: string; last_message_at: string | null;
  message_count?: number;
}

interface MessageRow {
  id: string; conversation_id: string; seq: number; role: string; text: string;
  tool_name: string | null; tool_input: string | null; tool_ok: number | null;
  source: string | null; model_id: string | null; approval_id: string | null;
  run_ids: string; refs_json: string; created_at: string;
}

const toConversation = (row: ConversationRow): Conversation => ({
  id: row.id,
  title: row.title,
  createdBy: row.created_by,
  workspaceId: row.workspace_id,
  autonomy: row.autonomy as AutonomyMode,
  status: row.status as ConversationStatus,
  source: row.source as ModelSource,
  messageCount: row.message_count ?? 0,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastMessageAt: row.last_message_at,
});

const toMessage = (row: MessageRow): ChatMessage => ({
  id: row.id,
  conversationId: row.conversation_id,
  seq: row.seq,
  role: row.role as ChatRole,
  text: row.text,
  toolName: row.tool_name,
  toolInput: row.tool_input ? JSON.parse(row.tool_input) as unknown : null,
  toolOk: row.tool_ok === null ? null : row.tool_ok === 1,
  source: row.source as ModelSource | null,
  modelId: row.model_id,
  approvalId: row.approval_id,
  runIds: JSON.parse(row.run_ids) as string[],
  refs: (JSON.parse(row.refs_json ?? '[]') as ChatRef[]).map((ref) => (
    // Las referencias escritas antes de que `cwd` existiera no lo traen. Se completa al leer en
    // vez de reescribir el histórico: migrar datos para ganar un campo derivable es cambiar el
    // pasado por comodidad.
    ref.kind === 'session' ? { ...ref, cwd: ref.cwd ?? null } : ref
  )),
  createdAt: row.created_at,
});

export interface NewMessage {
  role: ChatRole;
  text: string;
  toolName?: string | null;
  toolInput?: unknown;
  toolOk?: boolean | null;
  source?: ModelSource | null;
  modelId?: string | null;
  approvalId?: string | null;
  runIds?: string[];
  /** Lo que se puede pulsar de este mensaje. Ver `ChatRef` en los contratos. */
  refs?: ChatRef[];
}

export class ChatRepository {
  readonly #db: Db;
  readonly #clock: Clock;

  constructor({ db, clock }: { db: Db; clock: Clock }) {
    this.#db = db;
    this.#clock = clock;
  }

  create({ title, workspaceId, autonomy, createdBy }: {
    title: string;
    workspaceId: string | null;
    autonomy: AutonomyMode;
    createdBy: string;
  }): Conversation {
    const at = this.#clock.nowIso();
    const id = newConversationId();
    this.#db.prepare(`INSERT INTO conversations
      (id, title, created_by, workspace_id, autonomy, status, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'idle', 'local', ?, ?)`)
      .run(id, title, createdBy, workspaceId, autonomy, at, at);
    return this.require(id);
  }

  find(id: string): Conversation | null {
    const row = this.#db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id) AS message_count
      FROM conversations c WHERE c.id = ?`).get(id) as ConversationRow | undefined;
    return row ? toConversation(row) : null;
  }

  require(id: string): Conversation {
    const conversation = this.find(id);
    if (!conversation) throw new Error(`unknown conversation ${id}`);
    return conversation;
  }

  list({ limit = 30, workspaceId }: { limit?: number; workspaceId?: string } = {}): Conversation[] {
    const rows = workspaceId
      ? this.#db.prepare(`
          SELECT c.*, (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id) AS message_count
          FROM conversations c WHERE c.workspace_id = ? ORDER BY c.updated_at DESC LIMIT ?`)
        .all(workspaceId, limit) as ConversationRow[]
      : this.#db.prepare(`
          SELECT c.*, (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id) AS message_count
          FROM conversations c ORDER BY c.updated_at DESC LIMIT ?`)
        .all(limit) as ConversationRow[];
    return rows.map(toConversation);
  }

  messages(conversationId: string, { afterSeq = -1, limit = 500 }: { afterSeq?: number; limit?: number } = {}): ChatMessage[] {
    return (this.#db.prepare(
      'SELECT * FROM chat_messages WHERE conversation_id = ? AND seq > ? ORDER BY seq LIMIT ?',
    ).all(conversationId, afterSeq, limit) as MessageRow[]).map(toMessage);
  }

  /** Los últimos N, en orden de lectura. Es lo que se le recuerda al modelo. */
  lastMessages(conversationId: string, count: number): ChatMessage[] {
    return (this.#db.prepare(
      'SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?',
    ).all(conversationId, count) as MessageRow[]).map(toMessage).reverse();
  }

  /**
   * Añade un mensaje y devuelve el que quedó escrito.
   *
   * El `seq` se calcula **dentro de la transacción** que inserta, no antes: dos turnos que
   * escribieran a la vez con un contador leído fuera se pisarían el número, y `seq` es la
   * identidad con la que el navegador reconecta. El UNIQUE de la tabla lo remata.
   */
  append(conversationId: string, message: NewMessage): ChatMessage {
    const at = this.#clock.nowIso();
    const id = newChatMessageId();
    const insert = this.#db.transaction((): MessageRow => {
      const next = this.#db.prepare(
        'SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM chat_messages WHERE conversation_id = ?',
      ).get(conversationId) as { seq: number };
      this.#db.prepare(`INSERT INTO chat_messages
        (id, conversation_id, seq, role, text, tool_name, tool_input, tool_ok, source, model_id,
         approval_id, run_ids, refs_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, conversationId, next.seq, message.role, message.text,
          message.toolName ?? null,
          message.toolInput === undefined ? null : JSON.stringify(message.toolInput),
          message.toolOk === undefined || message.toolOk === null ? null : (message.toolOk ? 1 : 0),
          message.source ?? null, message.modelId ?? null, message.approvalId ?? null,
          JSON.stringify(message.runIds ?? []), JSON.stringify(message.refs ?? []), at);
      this.#db.prepare('UPDATE conversations SET updated_at = ?, last_message_at = ? WHERE id = ?')
        .run(at, at, conversationId);
      return this.#db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id) as MessageRow;
    });
    return toMessage(insert());
  }

  setStatus(conversationId: string, status: ConversationStatus, source?: ModelSource): void {
    if (source) {
      this.#db.prepare('UPDATE conversations SET status = ?, source = ?, updated_at = ? WHERE id = ?')
        .run(status, source, this.#clock.nowIso(), conversationId);
      return;
    }
    this.#db.prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, this.#clock.nowIso(), conversationId);
  }

  setAutonomy(conversationId: string, autonomy: AutonomyMode): void {
    this.#db.prepare('UPDATE conversations SET autonomy = ?, updated_at = ? WHERE id = ?')
      .run(autonomy, this.#clock.nowIso(), conversationId);
  }

  setTitle(conversationId: string, title: string): void {
    this.#db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, conversationId);
  }

  delete(conversationId: string): void {
    this.#db.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId);
  }
}
