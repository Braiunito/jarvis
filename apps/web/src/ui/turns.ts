/**
 * Una conversación, en turnos.
 *
 * Un turno es lo que pidió la persona y todo lo que vino después hasta que volvió a pedir algo.
 * Es la unidad que se pliega: plegado se lee «lo que pedí → lo último que contestó», y desplegado
 * es el hilo entero como siempre.
 *
 * Hay dos fuentes y se funden en una sola lista:
 *
 *  · el **transcript** de la sesión, que es lo que guarda la máquina: incluye lo que se habló
 *    desde la terminal sin pasar por Jarvis, pero sólo texto;
 *  · los **trabajos** lanzados desde Jarvis, que traen además la línea de eventos con lo que hizo
 *    el agente paso a paso.
 *
 * Un trabajo de Jarvis acaba también en el transcript —escribe en la misma sesión—, así que
 * pintarlos los dos sería ver cada turno dos veces. Cuando un turno del transcript es el de un
 * trabajo, gana el trabajo: dice lo mismo y además enseña el proceso.
 *
 * Sin React a propósito: es una función de datos a datos y se prueba sin navegador.
 */
import type { Run, TranscriptMessage } from '@jarvis/contracts';

export type Turn =
  | {
    kind: 'run';
    key: string;
    at: string;
    prompt: string | null;
    answer: string | null;
    run: Run;
  }
  | {
    kind: 'transcript';
    key: string;
    at: string | null;
    prompt: string | null;
    answer: string | null;
    messages: TranscriptMessage[];
  };

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** Lo que la persona escribió de verdad: no un `/comando` ni su salida. */
const isPrompt = (message: TranscriptMessage): boolean =>
  message.role === 'user' && message.kind === 'text' && message.text.trim().length > 0;

const isAnswer = (message: TranscriptMessage): boolean =>
  message.role === 'assistant' && message.kind === 'text' && message.text.trim().length > 0;

/** Parte el transcript en turnos. Lo que hay antes del primer mensaje propio es un turno sin pregunta. */
export function transcriptTurns(messages: TranscriptMessage[]): Array<Extract<Turn, { kind: 'transcript' }>> {
  const turns: Array<Extract<Turn, { kind: 'transcript' }>> = [];
  let current: TranscriptMessage[] = [];

  const close = (): void => {
    if (current.length === 0) return;
    const first = current[0] as TranscriptMessage;
    const prompt = isPrompt(first) ? first.text : null;
    const answer = [...current].reverse().find(isAnswer)?.text ?? null;
    const at = current.find((message) => message.at)?.at ?? null;
    turns.push({ kind: 'transcript', key: `t${turns.length}:${at ?? ''}`, at, prompt, answer, messages: current });
    current = [];
  };

  for (const message of messages) {
    if (isPrompt(message)) close();
    current.push(message);
  }
  close();
  return turns;
}

/**
 * ¿Este turno del transcript es el de este trabajo?
 *
 * Por el texto, que es lo que de verdad los une: el trabajo guarda el principio de lo que se pidió
 * y el transcript lo guarda entero. Se compara el principio normalizado —espacios y mayúsculas
 * fuera— y se exige que el turno no sea anterior al trabajo, para que dos peticiones iguales en
 * días distintos no se crucen.
 */
function matches(turn: Extract<Turn, { kind: 'transcript' }>, run: Run): boolean {
  if (!turn.prompt || !run.promptPreview) return false;
  const a = normalize(turn.prompt);
  const b = normalize(run.promptPreview);
  const probe = Math.min(80, a.length, b.length);
  if (probe < 4 || a.slice(0, probe) !== b.slice(0, probe)) return false;
  if (!turn.at) return true;
  // Un minuto de margen: el reloj de la máquina y el del core no son el mismo.
  return Date.parse(turn.at) >= Date.parse(run.createdAt) - 60_000;
}

const runAnswer = (run: Run): string | null =>
  run.resultSummary ?? run.errorMessage ?? (run.errorCode ? `Error ${run.errorCode}` : null);

/**
 * Los turnos de una sesión, del más antiguo al más reciente.
 *
 * `runs` puede venir en cualquier orden; el transcript, en el suyo, que es el cronológico.
 */
export function buildTurns(messages: TranscriptMessage[], runs: Run[]): Turn[] {
  const fromTranscript = transcriptTurns(messages);
  const used = new Set<number>();
  const result: Array<{ turn: Turn; time: number; order: number }> = [];

  const ordered = [...runs].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const runTurns = new Map<number, Run>();
  const loose: Run[] = [];
  for (const run of ordered) {
    const index = fromTranscript.findIndex((turn, position) => !used.has(position) && matches(turn, run));
    if (index >= 0) {
      used.add(index);
      runTurns.set(index, run);
    } else {
      loose.push(run);
    }
  }

  // El transcript marca el orden; un turno sin hora hereda la del anterior.
  let lastTime = 0;
  fromTranscript.forEach((turn, index) => {
    const time = turn.at ? Date.parse(turn.at) : lastTime;
    lastTime = time;
    const run = runTurns.get(index);
    const entry: Turn = run
      ? {
        kind: 'run', key: `r${run.id}`, at: run.createdAt, prompt: run.promptPreview ?? turn.prompt,
        answer: runAnswer(run) ?? turn.answer, run,
      }
      : turn;
    result.push({ turn: entry, time, order: index });
  });

  for (const run of loose) {
    result.push({
      turn: { kind: 'run', key: `r${run.id}`, at: run.createdAt, prompt: run.promptPreview, answer: runAnswer(run), run },
      time: Date.parse(run.createdAt),
      order: Number.MAX_SAFE_INTEGER,
    });
  }

  return result
    .sort((a, b) => (a.time - b.time) || (a.order - b.order))
    .map((entry) => entry.turn);
}

/**
 * Una línea de texto, sin saltos ni espacios de más, para las tarjetas plegadas.
 *
 * Quita también lo más visible del markdown —comillas de código, negritas, almohadillas de
 * encabezado—: plegado se lee como frase, y los signos sueltos estorbaban más que ayudaban.
 */
export function oneLine(text: string | null | undefined, max = 220): string {
  const flat = (text ?? '')
    .replace(/```[a-z0-9+#._-]*\n?/gi, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}
