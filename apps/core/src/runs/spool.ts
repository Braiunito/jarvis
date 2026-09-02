/**
 * Dónde vive el spool de un run, resuelto por máquina.
 *
 * La configuración lo escribe como `~/.local/state/jarvis/runs` porque cada usuario remoto tiene
 * el suyo: en el bastión es `/home/zeus/...`, en vultr `/root/...` y en bevrim
 * `/home/azureuser/...`. Ese path viaja dentro de comandos entrecomillados y no lo expande nadie,
 * así que se resuelve aquí, con el home que devolvió la sonda de capacidades de **ese** host.
 *
 * Vive en su propio fichero porque lo necesitan dos: quien crea el run y quien barre los spools
 * viejos, y una copia de esta regla en cada sitio es una forma segura de que se separen.
 */
import { JarvisError } from '@jarvis/contracts';

/** Un spool configurado con `~` o `$HOME` necesita el home real de la máquina que ejecuta. */
export const needsHome = (configured: string): boolean => /^(\$HOME|~)(\/|$)/.test(configured);

export function resolveSpoolRoot(configured: string, host: string, home: string | null | undefined): string {
  if (!needsHome(configured)) return configured;
  if (!home) {
    throw new JarvisError('HOST_UNREACHABLE',
      `no se pudo averiguar el home de ${host}, y el spool está configurado como ${configured}`,
      { scope: { host } });
  }
  return configured.replace(/^(\$HOME|~)/, home.replace(/\/+$/, ''));
}

/** La raíz con la que se creó un run, leída de su propio directorio y no de la configuración de hoy. */
export function spoolRootOf(remoteSpoolDir: string | null | undefined, runId: string): string | undefined {
  if (!remoteSpoolDir) return undefined;
  const suffix = `/${runId}`;
  return remoteSpoolDir.endsWith(suffix) ? remoteSpoolDir.slice(0, -suffix.length) : undefined;
}
