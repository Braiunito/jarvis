/**
 * Qué es cada línea de un transcript.
 *
 * Una sesión de CLI no son sólo mensajes: dentro van los comandos que la persona teclea (`/model`,
 * `/clear`), su salida, y las notas que el propio agente inyecta. Todo eso llega con `role: "user"`
 * porque así lo guarda el fichero de sesión, y sin clasificarlo pasan dos cosas malas:
 *
 *   · en pantalla se lee `<command-name>/model</command-name>` como si fuera algo que alguien
 *     escribió, marcado además como «escrito en la máquina»;
 *   · el titulador se lo cree y acaba llamando a la sesión «/model model».
 *
 * Los patrones son los mismos que usa el índice para decidir si un turno sirve para titular
 * (`_TITLE_NOISE` en aisessions), y están aquí en un solo sitio para que la interfaz y el
 * titulador no puedan discrepar.
 */
export type MessageKind = 'text' | 'command' | 'command-output' | 'note';

export interface ClassifiedMessage {
  kind: MessageKind;
  /** Forma corta y legible para lo que no es texto de la persona. */
  label: string | null;
}

const tag = (text: string, name: string): string | null => {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(text);
  return match?.[1]?.trim() ?? null;
};

const squash = (text: string, max = 160): string => {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

export function classifyMessage(text: string): ClassifiedMessage {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { kind: 'note', label: null };

  // Un comando tecleado en la CLI. El nombre ya trae la barra; los argumentos, si los hay, dicen
  // qué se pidió exactamente.
  const name = tag(trimmed, 'command-name');
  if (name) {
    const args = tag(trimmed, 'command-args');
    return { kind: 'command', label: squash(args ? `${name} ${args}` : name, 80) };
  }

  const stdout = tag(trimmed, 'local-command-stdout');
  if (stdout !== null) {
    return { kind: 'command-output', label: stdout ? squash(stdout) : 'sin salida' };
  }
  if (/^<local-command-std/i.test(trimmed)) {
    return { kind: 'command-output', label: squash(trimmed.replace(/<[^>]*>/g, ' ')) };
  }

  // Lo que el propio agente inyecta en el hilo: avisos de la herramienta, no de la persona.
  if (/^Caveat:/i.test(trimmed)) return { kind: 'note', label: squash(trimmed) };
  if (/^\[Request interrupted/i.test(trimmed)) {
    return { kind: 'note', label: 'la persona interrumpió la petición' };
  }
  if (/^<[a-z-]+>/i.test(trimmed) && /<\/[a-z-]+>\s*$/i.test(trimmed)) {
    return { kind: 'note', label: squash(trimmed.replace(/<[^>]*>/g, ' ')) };
  }

  return { kind: 'text', label: null };
}

/** Lo que de verdad escribió una persona, que es lo único con lo que se puede titular. */
export const isSubstantive = (text: string): boolean => classifyMessage(text).kind === 'text';
