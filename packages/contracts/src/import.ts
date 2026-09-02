import { Type, type Static } from '@sinclair/typebox';
import { Iso8601, Provider } from './common.js';

/**
 * `litechat-export-v1`: lo único que se importa del stack viejo.
 *
 * No entran API keys, mods, VFS ni settings genéricos: un fixture hostil lo demuestra
 * (`M5-07`). Lo importado se marca con procedencia y jamás se mezcla con el transcript remoto.
 */
export const LiteChatExport = Type.Object({
  schema: Type.Literal('litechat-export-v1'),
  exportedAt: Iso8601,
  sourceInstallationId: Type.String({ minLength: 8, maxLength: 128 }),
  conversations: Type.Array(Type.Object({
    sourceConversationId: Type.String(),
    title: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.Union([Iso8601, Type.Null()]),
    updatedAt: Type.Union([Iso8601, Type.Null()]),
    /** Vínculo Jarvis, si esa conversación estaba atada a una sesión de agente. */
    link: Type.Union([
      Type.Object({
        host: Type.String(),
        provider: Provider,
        sessionId: Type.String(),
        cwd: Type.Union([Type.String(), Type.Null()]),
      }),
      Type.Null(),
    ]),
    draft: Type.Union([Type.String(), Type.Null()]),
    messages: Type.Array(Type.Object({
      sourceMessageId: Type.String(),
      role: Type.Union([Type.Literal('user'), Type.Literal('assistant'), Type.Literal('system')]),
      at: Type.Union([Iso8601, Type.Null()]),
      text: Type.String(),
    })),
  })),
});
export type LiteChatExport = Static<typeof LiteChatExport>;

export const ImportReport = Type.Object({
  imported: Type.Integer(),
  skipped: Type.Integer(),
  errors: Type.Array(Type.Object({
    sourceConversationId: Type.String(),
    code: Type.String(),
    message: Type.String(),
  })),
  workspaceIds: Type.Array(Type.String()),
});
export type ImportReport = Static<typeof ImportReport>;
