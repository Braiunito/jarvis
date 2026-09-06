/**
 * La huella de una aprobación, que es lo único que ata lo que se leyó a lo que se ejecuta.
 *
 * `docs/security.md` promete que «cambiar cualquier parte la invalida». Se calculaba en los tres
 * sitios que crean aprobaciones y **no se comprobaba en ninguno**: alterar `target_json` de una
 * fila pendiente y autorizarla ejecutaba lo alterado, con el digest original intacto al lado.
 *
 * Lo que se fija aquí es esa promesa, y una segunda que es la que hace que sirva: que un destino
 * escrito en otro orden **siga siendo el mismo destino**. Un comprobador que fallara ahí produciría
 * «alguien manipuló esto» sobre tarjetas legítimas, y eso se apaga en una semana.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { approvalDigest, digestMatches } from '../src/platform/approvals.js';

describe('APPROVAL · la huella', () => {
  const target = { workspaceId: 'w1', host: 'zeus', permissionProfile: 'auto', prompt: 'borra el log' };

  it('cambiar cualquier parte del destino la invalida', () => {
    const huella = approvalDigest('run', target);

    expect(digestMatches(huella, 'run', target)).toBe(true);
    expect(digestMatches(huella, 'run', { ...target, prompt: 'borra la base' })).toBe(false);
    expect(digestMatches(huella, 'run', { ...target, permissionProfile: 'yolo' })).toBe(false);
    expect(digestMatches(huella, 'run', { ...target, host: 'goro2' })).toBe(false);
    // Y cambiar la acción también: el mismo destino con otra cosa que hacerle no es lo firmado.
    expect(digestMatches(huella, 'capability', target)).toBe(false);
  });

  it('el mismo destino escrito en otro orden es el mismo destino', () => {
    /*
     * `JSON.stringify` conserva el orden de inserción, así que sin ordenar las claves el mismo
     * objeto construido en dos sitios distintos daría huellas distintas — y la comprobación
     * rechazaría tarjetas buenas, que es peor que no comprobar: se aprende a ignorarla.
     */
    const alReves = {
      prompt: 'borra el log', permissionProfile: 'auto', host: 'zeus', workspaceId: 'w1',
    };
    expect(approvalDigest('run', alReves)).toBe(approvalDigest('run', target));
  });

  it('y en profundidad, no sólo en el primer nivel', () => {
    const a = { model: 'gpt-5', args: { top: 3, host: 'zeus' } };
    const b = { args: { host: 'zeus', top: 3 }, model: 'gpt-5' };
    expect(approvalDigest('capability', a)).toBe(approvalDigest('capability', b));
  });

  it('acepta la huella vieja mientras caduquen las que ya estaban pendientes', () => {
    // Rechazarlas todas al desplegar habría enseñado «alguien manipuló esto» sobre tarjetas
    // legítimas de alguien. Caducan en media hora; la rama se borra el 2026-09-07.
    const vieja = createHash('sha256')
      .update(JSON.stringify({ actionType: 'run', target })).digest('hex');
    expect(digestMatches(vieja, 'run', target)).toBe(true);
    expect(digestMatches(vieja, 'run', { ...target, prompt: 'otra cosa' })).toBe(false);
  });
});
