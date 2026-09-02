/**
 * Decodificador CBOR mínimo — lo justo para WebAuthn, nada más.
 *
 * WebAuthn pone dos blobs CBOR en el cable: el attestation object (mapa fmt/attStmt/authData) y
 * la clave pública en formato COSE (mapa con claves enteras). Ambos caben en el subconjunto de
 * aquí: enteros con y sin signo, cadenas de bytes y de texto, arrays, mapas, tags y simples.
 *
 * Los items de longitud indefinida se rechazan en vez de soportarse a medias: los autenticadores
 * no los emiten, y malinterpretar bytes controlados por un atacante es peor que fallar alto.
 */
export class CborError extends Error {
  override name = 'CborError';
}

export type CborValue =
  | number | string | boolean | null | undefined | Buffer
  | CborValue[] | Map<number | string, CborValue>;

function need(buf: Buffer, offset: number, length: number): void {
  if (offset + length > buf.length) throw new CborError('CBOR: truncated input');
}

function readArgument(buf: Buffer, offset: number, info: number): { value: number; offset: number } {
  if (info < 24) return { value: info, offset };
  if (info === 24) { need(buf, offset, 1); return { value: buf.readUInt8(offset), offset: offset + 1 }; }
  if (info === 25) { need(buf, offset, 2); return { value: buf.readUInt16BE(offset), offset: offset + 2 }; }
  if (info === 26) { need(buf, offset, 4); return { value: buf.readUInt32BE(offset), offset: offset + 4 }; }
  if (info === 27) {
    need(buf, offset, 8);
    const big = buf.readBigUInt64BE(offset);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError('CBOR: integer too large');
    return { value: Number(big), offset: offset + 8 };
  }
  if (info === 31) throw new CborError('CBOR: indefinite-length items are not supported');
  throw new CborError(`CBOR: reserved additional information ${info}`);
}

/** Decodifica un item. Devuelve el offset justo después de él, que hace falta para el COSE key. */
export function decodeItem(buf: Buffer, offset = 0): { value: CborValue; offset: number } {
  need(buf, offset, 1);
  const initial = buf.readUInt8(offset);
  const major = initial >> 5;
  const info = initial & 0x1f;
  let cursor = offset + 1;

  switch (major) {
    case 0: {
      const r = readArgument(buf, cursor, info);
      return { value: r.value, offset: r.offset };
    }
    case 1: {
      const r = readArgument(buf, cursor, info);
      return { value: -1 - r.value, offset: r.offset };
    }
    case 2: {
      const r = readArgument(buf, cursor, info);
      need(buf, r.offset, r.value);
      return { value: buf.subarray(r.offset, r.offset + r.value), offset: r.offset + r.value };
    }
    case 3: {
      const r = readArgument(buf, cursor, info);
      need(buf, r.offset, r.value);
      return {
        value: buf.subarray(r.offset, r.offset + r.value).toString('utf8'),
        offset: r.offset + r.value,
      };
    }
    case 4: {
      const r = readArgument(buf, cursor, info);
      const items: CborValue[] = [];
      cursor = r.offset;
      for (let i = 0; i < r.value; i += 1) {
        const item = decodeItem(buf, cursor);
        items.push(item.value);
        cursor = item.offset;
      }
      return { value: items, offset: cursor };
    }
    case 5: {
      // Mapa: se conserva como Map porque las claves COSE son enteros, no cadenas.
      const r = readArgument(buf, cursor, info);
      const map = new Map<number | string, CborValue>();
      cursor = r.offset;
      for (let i = 0; i < r.value; i += 1) {
        const key = decodeItem(buf, cursor);
        const value = decodeItem(buf, key.offset);
        const mapKey = Buffer.isBuffer(key.value)
          ? key.value.toString('hex')
          : (key.value as number | string);
        map.set(mapKey, value.value);
        cursor = value.offset;
      }
      return { value: map, offset: cursor };
    }
    case 6: {
      const r = readArgument(buf, cursor, info);
      return decodeItem(buf, r.offset);
    }
    case 7: {
      if (info === 20) return { value: false, offset: cursor };
      if (info === 21) return { value: true, offset: cursor };
      if (info === 22) return { value: null, offset: cursor };
      if (info === 23) return { value: undefined, offset: cursor };
      throw new CborError(`CBOR: unsupported simple value ${info}`);
    }
    default:
      throw new CborError(`CBOR: unknown major type ${major}`);
  }
}

export function decode(buf: Buffer): CborValue {
  const { value, offset } = decodeItem(buf, 0);
  if (offset !== buf.length) throw new CborError('CBOR: trailing bytes after the top-level item');
  return value;
}
