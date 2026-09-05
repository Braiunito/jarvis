import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Ids opacos y seguros para usarlos como nombre de directorio y de sesión tmux.
 *
 * No son UUID con guiones porque acaban dentro de un nombre de tmux y de un path remoto: el
 * alfabeto se restringe aquí, una vez, en lugar de saneárselo a cada consumidor.
 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function opaqueId(prefix: string, length = 16): string {
  const bytes = randomBytes(length);
  let id = '';
  for (const byte of bytes) id += ALPHABET[byte % ALPHABET.length];
  return `${prefix}${id}`;
}

export const newRunId = (): string => opaqueId('r');
export const newWorkspaceId = (): string => opaqueId('w');
export const newPlanId = (): string => opaqueId('p');
export const newStepId = (): string => opaqueId('s');
export const newApprovalId = (): string => opaqueId('a');
export const newAttachmentId = (): string => opaqueId('f');
export const newJobId = (): string => opaqueId('j');
export const newAuditId = (): string => opaqueId('e');
export const newConversationId = (): string => opaqueId('c');
export const newChatMessageId = (): string => opaqueId('m');
export const newSpendId = (): string => opaqueId('g');
export const newRequestId = (): string => `req_${randomUUID()}`;
