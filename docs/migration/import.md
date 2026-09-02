# Traer lo que valga la pena de LiteChat

Entra el vínculo con la sesión, los mensajes que se escribieron en Jarvis y el borrador. **No**
entran claves de proveedores, mods, el filesystem virtual ni los ajustes: si el fichero los trae,
el import se rechaza entero en vez de limpiarlos por detrás, para que quien exporta se entere de
que su volcado llevaba credenciales dentro.

## 1 · Exportar

Los datos de LiteChat viven en el IndexedDB del navegador, así que el export se hace desde ahí.
Con LiteChat abierto, en la consola del navegador:

```js
// Exporta al esquema litechat-export-v1 y descarga el fichero.
const db = await new Promise((ok, err) => {
  const request = indexedDB.open('LiteChatDatabase');
  request.onsuccess = () => ok(request.result);
  request.onerror = () => err(request.error);
});

const readAll = (store) => new Promise((ok, err) => {
  const request = db.transaction(store).objectStore(store).getAll();
  request.onsuccess = () => ok(request.result);
  request.onerror = () => err(request.error);
});

const conversations = await readAll('conversations');
const interactions = await readAll('interactions');

const payload = {
  schema: 'litechat-export-v1',
  exportedAt: new Date().toISOString(),
  // Identifica esta instalación: es la mitad de la clave que hace el import idempotente.
  sourceInstallationId: localStorage.getItem('litechat-installation-id')
    ?? `browser-${crypto.randomUUID()}`,
  conversations: conversations.map((conversation) => ({
    sourceConversationId: String(conversation.id),
    title: conversation.title ?? null,
    createdAt: conversation.createdAt ?? null,
    updatedAt: conversation.updatedAt ?? null,
    // Sólo las conversaciones atadas a una sesión de agente tienen sitio en Jarvis.
    link: conversation.jarvisLink
      ? {
        host: conversation.jarvisLink.host,
        provider: conversation.jarvisLink.provider,
        sessionId: conversation.jarvisLink.sessionId,
        cwd: conversation.jarvisLink.cwd ?? null,
      }
      : null,
    draft: conversation.draft ?? null,
    messages: interactions
      .filter((interaction) => String(interaction.conversationId) === String(conversation.id))
      .map((interaction) => ({
        sourceMessageId: String(interaction.id),
        role: interaction.type === 'user' ? 'user' : 'assistant',
        at: interaction.startedAt ?? null,
        text: String(interaction.response ?? interaction.prompt ?? ''),
      })),
  })),
};

console.log('conversaciones', payload.conversations.length,
  '· con vínculo', payload.conversations.filter((c) => c.link).length);

const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
const link = Object.assign(document.createElement('a'), {
  href: URL.createObjectURL(blob),
  download: 'litechat-export-v1.json',
});
link.click();
```

Antes de subirlo, **abrir el fichero y mirarlo**. Si contiene algo parecido a una clave, quitarlo:
el import lo rechazará, pero el fichero ya estaría en el disco.

## 2 · Importar

```bash
curl -X POST https://<host>/api/migrations/litechat \
  -H 'content-type: application/json' \
  -b cookies.txt \
  --data-binary @litechat-export-v1.json
```

Responde con el informe: cuántas entraron, cuántas se saltaron y qué falló en cada una.

## 3 · Comprobar

- Repetir el mismo import: `imported` debe ser 0. Es idempotente por
  `sourceInstallationId + sourceConversationId`.
- En la consola, los workspaces importados llevan procedencia `litechat-import` y sus mensajes se
  muestran aparte del transcript remoto: lo que escribió el agente en la máquina y lo que se
  importó del chat viejo no se mezclan nunca.
