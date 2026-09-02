/**
 * Importar lo útil de LiteChat, y sólo lo útil.
 *
 * Entra: el vínculo con la sesión, los mensajes que se escribieron en Jarvis y el borrador.
 * No entra: claves de proveedores, mods, VFS ni ajustes generales. No es una limitación técnica,
 * es la decisión de no arrastrar a la consola nueva la configuración que motivó la migración.
 *
 * El import es idempotente: repetirlo no duplica. Y lo importado se marca como tal, de forma que
 * jamás se confunde con lo que escribió el agente en la máquina remota.
 */
import { createHash } from 'node:crypto';
import type { Database as Db } from 'better-sqlite3';
import type { ImportReport, LiteChatExport, Provider, UserIdentity, Workspace } from '@jarvis/contracts';
import { JarvisError } from '@jarvis/contracts';
import type { Clock } from '../platform/clock.js';
import { newWorkspaceId, opaqueId } from '../platform/ids.js';
import type { AuditLog } from '../platform/audit.js';
import type { WorkspaceRepository } from '../workspaces/repository.js';

/** Lo que nunca entra, por mucho que venga en el fichero. */
const FORBIDDEN_KEYS = [
  'apiKeys', 'providers', 'mods', 'vfs', 'settings', 'secrets', 'credentials', 'tokens',
];

export interface ImportServiceDeps {
  db: Db;
  clock: Clock;
  workspaces: WorkspaceRepository;
  audit: AuditLog;
  bastionHost: string;
}

export class ImportService {
  readonly #deps: ImportServiceDeps;

  constructor(deps: ImportServiceDeps) {
    this.#deps = deps;
  }

  /**
   * Rechaza el fichero entero si trae algo que no debería.
   *
   * Filtrarlo en silencio sería peor: quien exporta tiene que enterarse de que su volcado llevaba
   * credenciales dentro, no que se las quitemos por detrás.
   */
  #assertClean(payload: unknown): void {
    const serialized = JSON.stringify(payload);
    for (const key of FORBIDDEN_KEYS) {
      if (new RegExp(`"${key}"\\s*:`).test(serialized)) {
        throw new JarvisError('BAD_REQUEST',
          `el export trae "${key}", que no se importa: quítalo del fichero y vuelve a intentarlo`);
      }
    }
  }

  import(payload: LiteChatExport, user: UserIdentity, requestId: string): ImportReport {
    if (payload?.schema !== 'litechat-export-v1') {
      throw new JarvisError('BAD_REQUEST', 'sólo se importa el esquema litechat-export-v1');
    }
    if (!payload.sourceInstallationId) {
      throw new JarvisError('BAD_REQUEST', 'falta sourceInstallationId: sin él no se puede deduplicar');
    }
    this.#assertClean(payload);

    const { db, clock, workspaces, bastionHost } = this.#deps;
    const report: ImportReport = { imported: 0, skipped: 0, errors: [], workspaceIds: [] };
    const at = clock.nowIso();

    for (const conversation of payload.conversations ?? []) {
      try {
        // Sin vínculo con una sesión no hay nada que importar: una conversación suelta de un chat
        // genérico no tiene sitio en una consola de agentes.
        if (!conversation.link) {
          report.skipped += 1;
          continue;
        }
        const host = !conversation.link.host || conversation.link.host === 'local'
          ? bastionHost
          : conversation.link.host;

        const existing = workspaces.findBySource(payload.sourceInstallationId, conversation.sourceConversationId);
        let workspace: Workspace;
        if (existing) {
          workspace = existing;
          report.skipped += 1;
        } else {
          const byRef = workspaces.findByRef({
            host, provider: conversation.link.provider as Provider, sessionId: conversation.link.sessionId,
          });
          if (byRef) {
            // Ya existe un workspace para esa sesión: se enlaza con el origen en vez de crear otro.
            db.prepare('UPDATE workspaces SET source_installation_id = ?, source_conversation_id = ? WHERE id = ?')
              .run(payload.sourceInstallationId, conversation.sourceConversationId, byRef.id);
            workspace = byRef;
          } else {
            workspace = {
              id: newWorkspaceId(),
              ref: { host, provider: conversation.link.provider as Provider, sessionId: conversation.link.sessionId },
              cwd: conversation.link.cwd ?? null,
              sourceRoot: null,
              title: conversation.title ?? null,
              createdBy: user.username,
              createdAt: conversation.createdAt ?? at,
              updatedAt: at,
              lastOpenedAt: null,
              // La procedencia viaja en la fila: en la interfaz se ve de dónde salió esto.
              provenance: 'litechat-import',
            };
            workspaces.insert(workspace, {
              installationId: payload.sourceInstallationId,
              conversationId: conversation.sourceConversationId,
            });
          }
          report.imported += 1;
        }
        report.workspaceIds.push(workspace.id);

        const insertMessage = db.prepare(`INSERT INTO imported_messages
          (id, workspace_id, source_message_id, role, at, text, imported_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (workspace_id, source_message_id) DO NOTHING`);
        for (const message of conversation.messages ?? []) {
          insertMessage.run(
            opaqueId('m'), workspace.id, message.sourceMessageId, message.role,
            message.at ?? null, message.text.slice(0, 100_000), at,
          );
        }

        // El borrador sólo se trae si aquí no hay uno: lo de esta consola manda.
        if (conversation.draft) {
          const current = workspaces.getDraft(workspace.id, user.userId);
          if (!current || !current.body) {
            workspaces.putDraft(workspace.id, user.userId, conversation.draft, current?.version ?? 0, at);
          }
        }
      } catch (error) {
        report.errors.push({
          sourceConversationId: conversation.sourceConversationId,
          code: error instanceof JarvisError ? error.code : 'INTERNAL',
          message: (error as Error).message,
        });
      }
    }

    this.#deps.audit.record({
      actorUser: user.username,
      eventType: 'import.litechat',
      requestId,
      payload: {
        sourceInstallationId: payload.sourceInstallationId,
        digest: createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16),
        imported: report.imported,
        skipped: report.skipped,
        errors: report.errors.length,
      },
    });
    return report;
  }

  /** Los mensajes importados de un workspace, siempre separados del transcript remoto. */
  messagesFor(workspaceId: string): Array<{ role: string; at: string | null; text: string }> {
    return this.#deps.db.prepare(
      'SELECT role, at, text FROM imported_messages WHERE workspace_id = ? ORDER BY COALESCE(at, imported_at)',
    ).all(workspaceId) as Array<{ role: string; at: string | null; text: string }>;
  }
}
