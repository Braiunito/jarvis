/**
 * Un servidor WebSocket mínimo, sólo con node:crypto y node:http.
 *
 * Una terminal viva necesita que una pulsación llegue como una pulsación. SSE va en una sola
 * dirección y un POST por tecla convierte teclear en una ristra de idas y vueltas. WebSocket es
 * el transporte que esto pide, y la parte que hace falta —el handshake y desenmascarar frames—
 * es lo bastante pequeña como para escribirla y no arrastrar una dependencia.
 *
 * Implementado: handshake RFC 6455, frames de texto y binarios, continuación, ping/pong, close y
 * payloads de hasta 2^53. No implementado: extensiones, compresión, fragmentar lo que enviamos.
 *
 * Contrato TERM-WS-01.
 */
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * El frame más grande que se guarda en memoria esperando el resto.
 *
 * El tráfico de una terminal son pulsaciones y avisos de tamaño; cualquier cosa remotamente así
 * de grande es un error o un cliente intentando que el core se quede sin RAM.
 */
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

export function isWebSocketUpgrade(req: IncomingMessage): boolean {
  return (
    String(req.headers.upgrade ?? '').toLowerCase() === 'websocket'
    && String(req.headers.connection ?? '').toLowerCase().includes('upgrade')
    && Boolean(req.headers['sec-websocket-key'])
  );
}

const acceptValue = (key: string): string =>
  createHash('sha1').update(key + GUID).digest('base64');

/** Un frame. Lo que enviamos nunca va enmascarado: el servidor no debe enmascarar. */
function encodeFrame(opcode: number, payload: Buffer | string): Buffer {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const length = data.length;

  let header: Buffer;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode; // FIN: nunca fragmentamos lo nuestro
  return Buffer.concat([header, data]);
}

interface Frame { fin: boolean; opcode: number; payload: Buffer }

export class WebSocketConnection extends EventEmitter {
  readonly socket: Duplex;
  closed = false;
  #buffer = Buffer.alloc(0);
  #fragments: Buffer[] = [];
  #fragmentBytes = 0;
  #fragmentOpcode: number | null = null;

  constructor(socket: Duplex) {
    super();
    this.socket = socket;

    socket.on('data', (chunk: Buffer) => this.#onData(chunk));
    socket.on('close', () => this.#finish());
    socket.on('error', (error) => {
      /**
       * `error` es especial en EventEmitter: emitirlo sin oyentes lanza y termina el proceso. Un
       * móvil que desaparece entre un latido y un write es un EPIPE normal, no una razón para
       * llevarse por delante todos los runs y terminales del core.
       */
      if (this.listenerCount('error') > 0) this.emit('error', error);
      this.#finish();
    });
    // La latencia al teclear es justo el objetivo: no esperar para agrupar.
    (socket as unknown as { setNoDelay?: (value: boolean) => void }).setNoDelay?.(true);
  }

  #onData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const frame = this.#readFrame();
      if (!frame) return;
      this.#handleFrame(frame);
      if (this.closed) return;
    }
  }

  #readFrame(): Frame | null {
    if (this.#buffer.length < 2) return null;
    const first = this.#buffer[0] as number;
    const second = this.#buffer[1] as number;
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (this.#buffer.length < offset + 2) return null;
      length = this.#buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (this.#buffer.length < offset + 8) return null;
      const big = this.#buffer.readBigUInt64BE(offset);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.close(1009, 'message too large');
        return null;
      }
      length = Number(big);
      offset += 8;
    }
    // Se rechaza antes de esperar los bytes: si no, un frame anunciado de 4 GB se va acumulando
    // trozo a trozo y el que nunca se completa es el que termina con el proceso.
    if (length > MAX_FRAME_BYTES) {
      this.close(1009, 'message too large');
      return null;
    }

    let mask: Buffer | null = null;
    if (masked) {
      if (this.#buffer.length < offset + 4) return null;
      mask = this.#buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (this.#buffer.length < offset + length) return null;

    const payload = Buffer.from(this.#buffer.subarray(offset, offset + length));
    // Todo frame que manda un navegador va enmascarado; desenmascarar es un XOR con la clave.
    if (mask) {
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] = (payload[i] as number) ^ (mask[i % 4] as number);
      }
    }
    this.#buffer = this.#buffer.subarray(offset + length);
    return { fin, opcode, payload };
  }

  #handleFrame({ fin, opcode, payload }: Frame): void {
    if (opcode === OPCODE.CLOSE) {
      this.close(1000, '');
      return;
    }
    if (opcode === OPCODE.PING) {
      this.#send(OPCODE.PONG, payload);
      return;
    }
    if (opcode === OPCODE.PONG) return;

    if (opcode === OPCODE.CONTINUATION) {
      this.#fragments.push(payload);
      this.#fragmentBytes += payload.length;
    } else {
      this.#fragments = [payload];
      this.#fragmentBytes = payload.length;
      this.#fragmentOpcode = opcode;
    }
    // El tope por frame no bastaría: un mensaje puede partirse en tantas continuaciones como el
    // cliente quiera.
    if (this.#fragmentBytes > MAX_FRAME_BYTES) {
      this.#fragments = [];
      this.#fragmentBytes = 0;
      this.close(1009, 'message too large');
      return;
    }
    if (!fin) return;

    const message = Buffer.concat(this.#fragments);
    this.#fragments = [];
    this.#fragmentBytes = 0;
    this.emit('message', message, this.#fragmentOpcode === OPCODE.BINARY);
  }

  #send(opcode: number, payload: Buffer | string): boolean {
    if (this.closed || this.socket.destroyed) return false;
    try {
      this.socket.write(encodeFrame(opcode, payload));
      return true;
    } catch {
      this.#finish();
      return false;
    }
  }

  send(data: Buffer | string): boolean {
    return this.#send(Buffer.isBuffer(data) ? OPCODE.BINARY : OPCODE.TEXT, data);
  }

  ping(): boolean {
    return this.#send(OPCODE.PING, randomBytes(4));
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.#send(OPCODE.CLOSE, payload);
    this.#finish();
    try {
      this.socket.end();
    } catch {
      // Ya no estaba.
    }
  }

  #finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

/** Completa el handshake y devuelve la conexión, o null si la petición no era válida. */
export function accept(req: IncomingMessage, socket: Duplex, head: Buffer): WebSocketConnection | null {
  if (!isWebSocketUpgrade(req)) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const version = Number(req.headers['sec-websocket-version']);
  if (version !== 13) {
    socket.end('HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13\r\n\r\n');
    return null;
  }

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${acceptValue(req.headers['sec-websocket-key'] as string)}\r\n`
    + '\r\n',
  );

  const connection = new WebSocketConnection(socket);
  // Los bytes que llegaron con el upgrade son ya parte del stream.
  if (head?.length) socket.unshift(head);
  return connection;
}

export function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.end(`HTTP/1.1 ${status} ${message}\r\n\r\n`);
}
