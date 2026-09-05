/**
 * Las URLs que se escriben en más de una pantalla.
 *
 * La de la terminal estaba copiada a mano en seis sitios, y una ruta con cuatro parámetros
 * repetida seis veces son seis ocasiones de olvidar el `from` —y entonces la terminal se abre en
 * la máquina buena pero sin puerta de vuelta al workspace— o de concatenar un `sessionId` sin
 * escapar. Se construye una vez aquí y el resto la pide.
 *
 * Sólo viven aquí las rutas con partes variables que se arman en varios sitios: `/w/<id>` o
 * `/runs/<id>` son una interpolación de un identificador y envolverlas sería una capa que no
 * ahorra nada.
 */

export interface TerminalTarget {
  host: string;
  /** Sin proveedor ni sesión, la terminal abre en la máquina y no se adjunta a nada. */
  provider?: string | null;
  sessionId?: string | null;
  /** El workspace del que se salió: es lo único que permite volver sin usar el atrás. */
  from?: string | null;
}

/** La terminal, ya elegida. Lo que falte se omite en vez de viajar vacío. */
export function terminalHref({ host, provider, sessionId, from }: TerminalTarget): string {
  const query = new URLSearchParams({ host });
  if (provider) query.set('provider', provider);
  if (sessionId) query.set('sessionId', sessionId);
  if (from) query.set('from', from);
  return `/terminal?${query.toString()}`;
}
