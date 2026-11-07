/**
 * La configuración del core, leída desde un entorno que se pasa y no desde el global.
 *
 * Lo que se vigila aquí es que una errata en una variable no conceda nada: un booleano mal escrito
 * no puede encender un interruptor que da permisos, y sin hosts declarados el core no alcanza más
 * que el bastión.
 *
 * Las pruebas de la autonomía del asistente, sus interruptores y el plazo de sus tarjetas se
 * fueron con él (2026-11-07).
 */
import { describe, expect, it } from 'vitest';
import { buildConfig } from '../src/config.js';

const con = (env: Record<string, string> = {}) => buildConfig(env);

describe('CONFIG · una errata no puede abrir una puerta', () => {
  it('el perfil sin restricciones nace apagado', () => {
    expect(con().allowYolo).toBe(false);
  });

  it('un booleano escrito de cualquier manera razonable se entiende, y lo raro no enciende', () => {
    for (const si of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(con({ JARVIS_ALLOW_YOLO: si }).allowYolo, si).toBe(true);
    }
    for (const no of ['0', 'false', 'no', 'off', 'sí', 'verdadero', '']) {
      expect(con({ JARVIS_ALLOW_YOLO: no }).allowYolo, no).toBe(false);
    }
  });

  it('los plazos se pueden cambiar sin tocar código', () => {
    expect(con().runTimeoutMs).toBe(4 * 60 * 60 * 1000);
    expect(con({ JARVIS_RUN_TIMEOUT_MS: '600000' }).runTimeoutMs).toBe(600_000);
  });

  it('sin hosts declarados sólo se alcanza el bastión, nunca la flota entera', () => {
    expect(con().hosts).toEqual(['bastion']);
    expect(con({ JARVIS_BASTION_HOST: 'zeus' }).hosts).toEqual(['zeus']);
    expect(con({ JARVIS_HOSTS: 'zeus, goro1' }).hosts).toEqual(['zeus', 'goro1']);
  });

  it('leer la configuración no toca el entorno de nadie', () => {
    const antes = { ...process.env };
    con({ JARVIS_HOSTS: 'x', JARVIS_ALLOW_YOLO: '1' });
    expect(process.env).toEqual(antes);
  });
});
