/**
 * Cómo se declaran los servidores MCP en el entorno.
 *
 * Va aparte de `config.ts` porque tiene decisiones dentro —qué se deniega por defecto, cómo se
 * reparten los tokens— y eso se prueba. La configuración declara; esto interpreta.
 *
 * El formato es deliberadamente pobre. Un JSON en una variable de Compose se escapa mal, se lee
 * peor y el día que alguien se deje una coma el core arranca sin MCP y sin decir por qué:
 *
 *   JARVIS_MCP_SERVERS=zeus=http://host.docker.internal:8765/mcp
 *   JARVIS_MCP_TOKENS=zeus=un-token-largo
 *   JARVIS_MCP_WRITE_SERVERS=          (vacío: nadie escribe)
 *   JARVIS_MCP_DENY=zeus.reboot_server,zeus.poweroff_server
 */
import type { McpServerConfig } from './service.js';

/**
 * Lo que no se ejecuta jamás, venga de donde venga.
 *
 * Son las cuatro que no tienen vuelta atrás desde una conversación: apagar o reiniciar la máquina
 * que sostiene todo esto, e instalar paquetes en ella. Ninguna aprobación las abre desde aquí,
 * porque una aprobación es una tarjeta que se lee en diez segundos y esto merece una sesión de
 * terminal y una persona mirando. Se puede quitar de la lista a mano, y hay que escribirlo.
 */
export const DEFAULT_DENIED_TOOLS = [
  'reboot_server', 'poweroff_server', 'apt_install', 'apt_update_cache',
] as const;

/** `nombre=valor,nombre=valor` → mapa. Tolera espacios y entradas a medias sin reventar. */
export function parsePairs(raw: string | undefined): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (name && value) pairs.set(name, value);
  }
  return pairs;
}

export interface McpEnv {
  servers?: string | undefined;
  tokens?: string | undefined;
  writeServers?: string | undefined;
  allow?: string | undefined;
  deny?: string | undefined;
}

/**
 * Los servidores declarados, ya con su política.
 *
 * `readOnly` es la posición de reposo: un servidor sólo escribe si alguien escribió su nombre en
 * `JARVIS_MCP_WRITE_SERVERS`. Y las denegadas por defecto se añaden a las que ponga el operador en
 * vez de sustituirlas, porque una lista de denegación que se pisa al añadirle algo es una trampa.
 */
export function parseMcpServers(env: McpEnv): McpServerConfig[] {
  const tokens = parsePairs(env.tokens);
  const writers = new Set((env.writeServers ?? '').split(',').map((name) => name.trim()).filter(Boolean));
  const allow = qualifiedNames(env.allow);
  const deny = qualifiedNames(env.deny);

  return [...parsePairs(env.servers).entries()].map(([name, url]) => {
    const token = tokens.get(name);
    return {
      name,
      url,
      ...(token ? { token } : {}),
      readOnly: !writers.has(name),
      allow: allow.forServer(name),
      deny: [...new Set([...deny.forServer(name), ...DEFAULT_DENIED_TOOLS])],
    };
  });
}

/**
 * `servidor.herramienta,otra` → consulta por servidor.
 *
 * Un nombre sin servidor se aplica a todos: quien escribe `poweroff_server` quiere que no se
 * ejecute en ninguna parte, no en una concreta. Por eso esto devuelve una función y no un mapa —un
 * mapa sólo contesta por las claves que alguien mencionó, y los globales valen para todas,
 * incluidos los servidores que no aparecen en la lista.
 */
interface QualifiedNames {
  forServer(server: string): string[];
}

function qualifiedNames(raw: string | undefined): QualifiedNames {
  const byServer = new Map<string, string[]>();
  const global: string[] = [];

  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const dot = trimmed.indexOf('.');
    if (dot <= 0) {
      global.push(trimmed);
      continue;
    }
    byServer.set(trimmed.slice(0, dot), [...(byServer.get(trimmed.slice(0, dot)) ?? []), trimmed.slice(dot + 1)]);
  }

  return {
    forServer: (server) => [...new Set([...(byServer.get(server) ?? []), ...global])],
  };
}
