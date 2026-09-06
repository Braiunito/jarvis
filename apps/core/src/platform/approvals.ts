/**
 * La huella de una aprobación: lo único que ata lo que se leyó a lo que se ejecuta.
 *
 * `docs/security.md` promete que «cambiar cualquier parte la invalida». Se calculaba en los tres
 * sitios que crean aprobaciones y **no se comprobaba en ninguno**: alterar `target_json` de una fila
 * pendiente y autorizarla ejecutaba lo alterado, con el digest original intacto al lado. La promesa
 * estaba escrita, la huella estaba guardada, y nadie las juntaba.
 *
 * Vive aquí y no en cada servicio porque una huella que se calcula de dos maneras no es una huella:
 * basta con que un sitio serialice distinto para que la comprobación falle siempre o no falle nunca.
 */
import { createHash } from 'node:crypto';

/**
 * Serialización estable: las claves ordenadas, en profundidad.
 *
 * `JSON.stringify` conserva el orden de inserción, así que `{a,b}` y `{b,a}` —el mismo destino
 * construido en dos sitios distintos— darían huellas distintas. Hoy no ocurre porque al comprobar
 * se re-serializa lo que se leyó de la base, pero eso es una propiedad del código de al lado, no de
 * la huella. Una comprobación de seguridad no puede depender de que nadie reordene un objeto.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/** La huella de una acción y su destino. Se calcula al crear y **se comprueba al consumir**. */
export function approvalDigest(actionType: string, target: unknown): string {
  return createHash('sha256').update(canonical({ actionType, target })).digest('hex');
}

/**
 * La huella tal como se calculaba antes de que se ordenaran las claves.
 *
 * Existe sólo para las aprobaciones que ya estaban pendientes al desplegar esto: si se rechazaran
 * todas, alguien vería «alguien manipuló esto» sobre una tarjeta suya y legítima, que es el peor
 * error posible en este sitio. Las aprobaciones caducan en media hora, así que **esta rama se puede
 * borrar a partir del 2026-09-07** y conviene hacerlo: una comprobación con dos formas válidas es
 * más débil que una con una.
 */
function legacyDigest(actionType: string, target: unknown): string {
  return createHash('sha256').update(JSON.stringify({ actionType, target })).digest('hex');
}

/** Si la huella guardada corresponde a lo que hay ahora en la fila. */
export function digestMatches(stored: string, actionType: string, target: unknown): boolean {
  return stored === approvalDigest(actionType, target)
    || stored === legacyDigest(actionType, target);
}
