/**
 * Leer `text/event-stream` desde el lado del cliente.
 *
 * El core habla SSE en las dos direcciones y por motivos distintos: lo **sirve** para proyectar el
 * event log de un run hacia el navegador (`runs/sse.ts`), y lo **consume** aquí, porque los dos
 * sitios de los que ahora depende contestan así — un servidor MCP con transporte Streamable HTTP y
 * un `llama-server` generando token a token.
 *
 * Se lee incrementalmente y no con `response.text()` a propósito. Un POST a un servidor MCP suele
 * devolver un solo evento y cerrar, pero el protocolo no lo obliga: si el servidor deja el stream
 * abierto, `text()` se queda esperando hasta que salte el plazo y la respuesta que ya había
 * llegado se pierde. Consumir por eventos permite parar en cuanto está lo que se pedía.
 */

export interface SseEvent {
  /** El `event:` del protocolo. Sin él, SSE manda `message`, y eso es lo que se devuelve. */
  event: string;
  data: string;
  id: string | null;
}

/**
 * Los eventos de un cuerpo de respuesta, según van llegando.
 *
 * Quien la consume decide cuándo parar; al salir del bucle se cancela el stream, que es lo que
 * cierra el socket. Un `break` aquí no deja una conexión colgando.
 */
export async function* readSseEvents(
  body: ReadableStream<Uint8Array> | null,
  { maxBytes = 8 * 1024 * 1024 }: { maxBytes?: number } = {},
): AsyncGenerator<SseEvent> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let seen = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value?.byteLength ?? 0;
      if (seen > maxBytes) {
        throw new Error(`the stream sent more than ${maxBytes} bytes without ending`);
      }
      buffer += decoder.decode(value, { stream: true });

      /*
       * Un evento termina en línea en blanco. El separador puede ser `\n\n` o `\r\n\r\n` —los dos
       * son legales y algunos proxys imponen el segundo—, así que hay que consumir exactamente lo
       * que casó: dar por hecha una longitud deja un `\r` al principio del evento siguiente y su
       * primer campo pasa a llamarse «\revent», que no casa con nada y se descarta en silencio.
       */
      for (
        let match = /\r?\n\r?\n/.exec(buffer);
        match !== null;
        match = /\r?\n\r?\n/.exec(buffer)
      ) {
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const parsed = parseEvent(raw);
        if (parsed) yield parsed;
      }
    }
    // Lo que quedó sin línea en blanco final sigue siendo un evento: un servidor que cierra
    // justo después de escribir no está obligado a despedirse con dos saltos de línea.
    const tail = parseEvent(buffer);
    if (tail) yield tail;
  } finally {
    // Cancelar es lo que libera el socket cuando quien consume se va antes del final.
    await reader.cancel().catch(() => undefined);
  }
}

function parseEvent(raw: string): SseEvent | null {
  if (!raw.trim()) return null;
  let event = 'message';
  let id: string | null = null;
  const data: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    // Los comentarios (`: keepalive`) son latido del servidor, no contenido.
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // El espacio que sigue a los dos puntos es del formato, no del dato.
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
  }

  if (!data.length) return null;
  return { event, data: data.join('\n'), id };
}
