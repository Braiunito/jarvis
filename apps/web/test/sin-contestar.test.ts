/**
 * Cuándo una conversación es una pregunta que nadie contestó.
 *
 * Existe porque en producción eso **no se veía**: un turno se encola como trabajo y puede agotar
 * sus intentos sin que la conversación pase a `failed`. Medido el 2026-09-06: la salud avisaba de
 * dos turnos perdidos en 24 h mientras la única conversación marcada como fallida era del día 4.
 * En la pantalla, un hilo así se quedaba en reposo con la última palabra siendo tuya —igual que
 * uno terminado— y lo único que lo decía era un `/api/health` que no mira nadie.
 */
import { describe, expect, it } from 'vitest';
import { sinContestar } from '../src/screens/assistant.jsx';

const mensaje = (role: string): { role: string } => ({ role });

describe('una pregunta sin contestar', () => {
  it('en reposo y con la última palabra tuya, nadie contestó', () => {
    expect(sinContestar('idle', mensaje('user'))).toBe(true);
  });

  it('un turno que murió a mitad tampoco contestó, aunque dejara trazas', () => {
    // Se quedó una observación de herramienta como último mensaje: hubo trabajo y no hubo respuesta.
    expect(sinContestar('idle', mensaje('tool'))).toBe(true);
  });

  it('un evento del hilo no cuenta, porque los buenos y los malos comparten rol', () => {
    /*
     * «No pude contestar y me quedé sin intentos» y «Plan corregido: …» son los dos `event`. El
     * primero es esto y el segundo es un turno que acabó bien, así que desde el rol no se
     * distinguen — y el que muere ya se explica solo con sus palabras en el hilo.
     */
    expect(sinContestar('idle', mensaje('event'))).toBe(false);
  });

  it('si el asistente habló el último, está contestada', () => {
    expect(sinContestar('idle', mensaje('assistant'))).toBe(false);
  });

  it('esperar permiso no es quedarse sin contestar: espera algo tuyo', () => {
    expect(sinContestar('waiting_approval', mensaje('user'))).toBe(false);
  });

  it('mientras piensa, tampoco: todavía está en ello', () => {
    expect(sinContestar('thinking', mensaje('user'))).toBe(false);
  });

  it('una conversación vacía no es una pregunta sin contestar', () => {
    expect(sinContestar('idle', null)).toBe(false);
  });
});
