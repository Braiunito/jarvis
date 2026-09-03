/**
 * Traducción de los errores del transporte al vocabulario que la consola entiende.
 *
 * `resolveTarget` y la sonda de capacidades hablan en excepciones propias —`TargetImpossibleError`,
 * `HostUnreachableError`— porque viven en un paquete que no conoce el contrato HTTP. Eso está
 * bien, pero alguien tiene que traducirlas: sin esto caen en el «error interno» del manejador
 * genérico, y **un 500 sin código es una pantalla que no puede ayudar**. La diferencia se ve en lo
 * que lee la persona: «error interno» frente a «claude no está instalado en goro1», que es un
 * mensaje que ya existía y que nadie llegaba a ver.
 *
 * Se traduce en un solo sitio, el manejador de errores, y no envolviendo cada llamada: las rutas
 * afectadas eran cinco y crecerán, y una traducción repartida se olvida en la sexta.
 */
import { HostUnreachableError, SshError, TargetImpossibleError } from '@jarvis/agent-adapters';
import { JarvisError } from '@jarvis/contracts';

/** Devuelve el error ya traducido, o `null` si no es de los que sabemos nombrar. */
export function toJarvisError(error: unknown): JarvisError | null {
  if (error instanceof JarvisError) return error;

  if (error instanceof TargetImpossibleError) {
    // `PROVIDER_MISSING` y `STRATEGY_IMPOSSIBLE` ya tienen su 409 en el contrato: son decisiones
    // sobre la máquina, no fallos del servidor, y quien las lee puede hacer algo con ellas.
    return new JarvisError(error.code, error.message, { retryable: false });
  }

  if (error instanceof HostUnreachableError) {
    return new JarvisError('HOST_UNREACHABLE', error.message, {
      // Un host caído suele volver: decir que se puede reintentar es información, no optimismo.
      retryable: true,
      scope: { host: error.host },
    });
  }

  if (error instanceof SshError) {
    // Un nombre de host fuera de la allowlist o un PATH con caracteres raros: es una petición
    // inaceptable, no una avería. Que salga como 500 invita a reintentarla igual.
    return new JarvisError('HOST_NOT_ALLOWED', error.message, { retryable: false });
  }

  return null;
}
