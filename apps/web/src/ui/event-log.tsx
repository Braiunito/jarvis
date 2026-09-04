/**
 * Lo que dijo el agente, legible.
 *
 * La regla es una sola: **el JSON no se enseña si se puede contar**. Los eventos que sabemos leer
 * —el destino, un cambio de estado, una respuesta, una herramienta, el resultado— se cuentan en
 * una línea. Los que no —el arranque del agente, lo que llega sin clasificar, lo que aún no
 * conocemos— se cuentan con chips, que es lo que un objeto plano es en realidad: pares de campo y
 * valor. Y el volcado crudo queda a un clic en todos, porque para depurar hace falta y para
 * trabajar estorba.
 *
 * El `seq` se conserva siempre: es la identidad durable de un evento —lo que permite reengancharse
 * a un stream sin repetir ni perder— y tiene que poder citarse.
 */
import type { JSX } from 'react';
import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { JsonView } from 'react-json-view-lite';
import type { PermissionProfile, RunEvent } from '@jarvis/contracts';
import { Empty } from './bits.jsx';
import { Segmented } from './primitives.jsx';
import { EVENT_KIND, PERMISSION, RUN_STATUS } from './labels.js';
import { ACTION_ICON, Glyph, RUN_STATUS_ICON, STATUS_ICON, type LucideIcon } from './icons.jsx';

type Tone = '' | 'ok' | 'warn' | 'danger' | 'running' | 'accent';

interface EventVisual {
  icon: LucideIcon;
  tone: Tone;
}

const VISUALS: Record<string, EventVisual> = {
  'run.target': { icon: ACTION_ICON.connect, tone: 'accent' },
  'run.status': { icon: STATUS_ICON.activity, tone: '' },
  'run.cancel_requested': { icon: ACTION_ICON.stop, tone: 'warn' },
  'runner.stderr': { icon: ACTION_ICON.error, tone: 'danger' },
  'agent.started': { icon: ACTION_ICON.go, tone: 'running' },
  'agent.text': { icon: ACTION_ICON.message, tone: 'running' },
  'agent.reasoning': { icon: ACTION_ICON.session, tone: '' },
  'agent.tool': { icon: ACTION_ICON.settings, tone: 'warn' },
  'agent.result': { icon: RUN_STATUS_ICON.completed, tone: 'ok' },
  'agent.error': { icon: ACTION_ICON.error, tone: 'danger' },
  'agent.raw': { icon: ACTION_ICON.copy, tone: '' },
};

/**
 * ¿Esto es el modelo razonando?
 *
 * Llega como `agent.raw` desde versiones del adaptador que no lo traducían, y en la línea de
 * tiempo se leía «salida sin clasificar» cinco veces seguidas. Se reconoce por lo que el propio
 * evento dice de sí mismo —su `subtype` o la nota del adaptador—, no por adivinar.
 */
function isThinking(event: RunEvent): boolean {
  if (event.type === 'agent.reasoning') return true;
  if (event.type !== 'agent.raw') return false;
  const payload = event.payload as Record<string, unknown>;
  const inner = payload['payload'] as Record<string, unknown> | undefined;
  if (typeof inner?.['subtype'] === 'string' && /thinking/i.test(inner['subtype'])) return true;
  return typeof payload['note'] === 'string' && /pensando|thinking|razon/i.test(payload['note']);
}

const visualOf = (type: string): EventVisual =>
  VISUALS[type] ?? { icon: STATUS_ICON.activity, tone: '' };

/** Lo que se enseña en el distintivo: el nombre del tipo, salvo que sepamos algo mejor. */
const kindLabel = (event: RunEvent): string =>
  (isThinking(event) ? 'razonando' : EVENT_KIND[event.type] ?? event.type);

/**
 * Lo que dijo el agente, frente a lo que hizo la máquina.
 *
 * Un trabajo largo son treinta líneas de fontanería —estados, herramientas, arranques— y dos o
 * tres de respuesta. Encontrar esas dos es lo que se viene a hacer, así que se marcan aparte y se
 * pueden aislar. El error entra en el grupo porque es la otra forma que tiene de contestar.
 */
const ANSWER_TYPES = new Set(['agent.text', 'agent.result', 'agent.error']);
const isAnswer = (event: RunEvent): boolean => ANSWER_TYPES.has(event.type);

export interface Fact {
  label: string;
  value: string;
  tone?: Tone;
  mono?: boolean;
}

/** Contado en palabras, o contado en chips. Nunca en JSON. */
type Rendered =
  | { kind: 'text'; headline?: string; body?: string; extra?: string }
  | { kind: 'facts'; facts: Fact[]; note?: string };

/** Un valor cualquiera dicho en una línea, para lo que no sabemos interpretar. */
function factsOf(payload: Record<string, unknown>): Fact[] {
  return Object.entries(payload)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .slice(0, 8)
    .map(([label, value]) => ({
      label,
      value: Array.isArray(value)
        ? value.map((item) => String(item)).join(', ')
        : typeof value === 'object'
          ? `${Object.keys(value as object).length} campos`
          : String(value),
      mono: typeof value !== 'number' && typeof value !== 'boolean',
    }));
}

/**
 * Qué pasó, en una línea.
 *
 * Si hay que abrir el detalle para saber si algo salió bien, esto no ha servido de nada.
 */
function describe(event: RunEvent): Rendered {
  const payload = event.payload as Record<string, unknown>;

  if (typeof payload['text'] === 'string' && event.type !== 'agent.raw') {
    return { kind: 'text', body: payload['text'] };
  }

  if (event.type === 'run.target') {
    const target = payload['target'] as {
      executionHost: string; workHost: string; strategy: string; cwd: string | null;
      provider: string; permissionProfile: PermissionProfile;
    } | undefined;
    if (!target) return { kind: 'facts', facts: factsOf(payload) };
    const where = target.strategy === 'A'
      ? `${target.provider} en ${target.executionHost}, trabajando sobre ${target.workHost}`
      : `${target.provider} en ${target.executionHost}`;
    const attachments = Array.isArray(payload['attachmentIds']) ? (payload['attachmentIds'] as unknown[]).length : 0;
    return {
      kind: 'text',
      headline: where,
      body: [
        PERMISSION[target.permissionProfile].name.toLowerCase(),
        target.cwd ?? 'sin directorio de trabajo',
        attachments ? `${attachments} adjunto${attachments === 1 ? '' : 's'}` : null,
      ].filter(Boolean).join(' · '),
    };
  }

  if (event.type === 'run.status') {
    const status = payload as { from: string; to: string; reason?: string | null };
    const name = (key: string): string => RUN_STATUS[key as keyof typeof RUN_STATUS]?.name ?? key;
    return {
      kind: 'text',
      headline: `${name(status.from)} → ${name(status.to)}`,
      ...(status.reason ? { extra: status.reason } : {}),
    };
  }

  // El arranque es un objeto plano: modelo, carpeta, modo y herramientas. Como chips se lee de un
  // vistazo; como JSON hay que descifrarlo, que es justo lo que pasaba antes.
  if (event.type === 'agent.started') {
    const started = payload as {
      model?: string; cwd?: string; permissionMode?: string; sessionId?: string; tools?: string[];
    };
    const facts: Fact[] = [];
    if (started.model) facts.push({ label: 'modelo', value: started.model, tone: 'running' });
    if (started.permissionMode) facts.push({ label: 'modo', value: started.permissionMode, tone: 'warn' });
    if (started.cwd) facts.push({ label: 'carpeta', value: started.cwd, mono: true });
    if (started.sessionId) facts.push({ label: 'sesión', value: started.sessionId, mono: true });
    if (started.tools?.length) {
      facts.push({ label: 'herramientas', value: started.tools.join(', ') });
    }
    return facts.length ? { kind: 'facts', facts } : { kind: 'facts', facts: factsOf(payload) };
  }

  if (event.type === 'agent.tool') {
    const tool = payload['tool'] as {
      name?: string; status?: string; input?: Record<string, unknown>; output?: string; truncated?: boolean;
    } | undefined;
    const command = tool?.input?.['command'] ?? tool?.input?.['file_path'] ?? tool?.input?.['pattern'];
    return {
      kind: 'text',
      headline: `${tool?.name ?? 'herramienta'}${tool?.status ? ` · ${tool.status}` : ''}`,
      ...(command || tool?.output ? { body: String(command ?? tool?.output) } : {}),
      ...(tool?.truncated ? { extra: 'salida recortada' } : {}),
    };
  }

  if (event.type === 'agent.result') {
    const result = payload as { ok?: boolean; text?: string; turns?: number; costUsd?: number; durationMs?: number };
    const extra = [
      result.turns ? `${result.turns} turnos` : null,
      result.durationMs ? `${Math.round(result.durationMs / 100) / 10} s` : null,
      typeof result.costUsd === 'number' ? `$${result.costUsd.toFixed(2)}` : null,
    ].filter(Boolean).join(' · ');
    return {
      kind: 'text',
      headline: result.ok ? 'terminado' : 'terminado con error',
      ...(result.text ? { body: result.text } : {}),
      ...(extra ? { extra } : {}),
    };
  }

  if (event.type === 'agent.error' || event.type === 'runner.stderr') {
    return { kind: 'text', body: String(payload['message'] ?? payload['text'] ?? 'error') };
  }

  // Lo que no conocemos: chips con lo que trae, y el crudo a un clic. Un tipo de evento nuevo no
  // puede romper la pantalla ni obligar a leer JSON.
  //
  // Si el adaptador supo decir qué era —aunque no supiera traducirlo—, esa nota vale más que
  // «sin traducir»: la CLI saca versiones nuevas cada semana y sus eventos nuevos aparecen aquí.
  const note = typeof payload['note'] === 'string' ? payload['note'] : 'evento sin traducir todavía';
  return { kind: 'facts', facts: factsOf(payload), note };
}

/**
 * El detalle en crudo.
 *
 * El árbol JSON es de librería (`react-json-view-lite`, 7 KiB): plegar, tipar y no morir con un
 * array de mil elementos es más trabajo del que parece. Los estilos sí son nuestros —se le pasan
 * las clases del producto— para que no traiga su propia paleta.
 */
const JSON_STYLES = {
  container: 'jsonview',
  basicChildStyle: 'json-row',
  label: 'json-label',
  clickableLabel: 'json-label clickable',
  nullValue: 'json-null',
  undefinedValue: 'json-null',
  numberValue: 'json-number',
  stringValue: 'json-string',
  booleanValue: 'json-bool',
  otherValue: 'json-other',
  punctuation: 'json-punct',
  expandIcon: 'json-toggle expand',
  collapseIcon: 'json-toggle collapse',
  collapsedContent: 'json-collapsed',
  childFieldsContainer: 'json-children',
  ariaLables: { collapseJson: 'plegar', expandJson: 'desplegar' },
  stringifyStringValues: false,
};

function EventDetail({ event, onClose }: { event: RunEvent; onClose: () => void }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const visual = visualOf(event.type);
  const data = event.payload as object;

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop" />
        <Dialog.Content className="modal" aria-describedby={undefined}>
          <header className="modal-head">
            <span className={`badge ${visual.tone}`}>
              <Glyph icon={visual.icon} />
              {EVENT_KIND[event.type] ?? event.type}
            </span>
            <Dialog.Title className="modal-title mono">#{event.seq}</Dialog.Title>
            <span className="tiny faint modal-date">{new Date(event.at).toLocaleString()}</span>
            <div className="after">
              <button type="button" className="btn small" onClick={() => {
                void navigator.clipboard.writeText(JSON.stringify(data, null, 2)).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 2000);
                });
              }}>
                <Glyph icon={copied ? ACTION_ICON.approve : ACTION_ICON.copy} />
                {copied ? 'Copiado' : 'Copiar JSON'}
              </button>
              <Dialog.Close asChild>
                <button type="button" className="btn small icon" aria-label="Cerrar el detalle">
                  <Glyph icon={ACTION_ICON.reject} />
                </button>
              </Dialog.Close>
            </div>
          </header>

          <div className="modal-body" tabIndex={0} role="region" aria-label="JSON del evento">
            <JsonView data={data} style={JSON_STYLES} shouldExpandNode={(level) => level < 2} />
          </div>

          <p className="tiny faint" style={{ margin: 0 }}>
            Tal y como llegó del agente. El <span className="mono">seq</span> es su identidad
            durable: citarlo sirve para volver a este punto exacto del stream.
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function EventCard({ event, onOpen, repeats = 1 }: {
  event: RunEvent;
  onOpen: () => void;
  /** Cuántas veces seguidas llegó lo mismo. Ver `cluster`. */
  repeats?: number;
}): JSX.Element {
  const visual = visualOf(event.type);
  const rendered = describe(event);
  const answer = isAnswer(event);

  return (
    <button type="button" className={`event-card ${visual.tone} ${answer ? 'answer' : ''}`}
      onClick={onOpen} title="Ver el evento tal y como llegó">
      <span className="event-head">
        <span className={`badge ${visual.tone}`}>
          <Glyph icon={isThinking(event) ? ACTION_ICON.session : visual.icon} />
          {kindLabel(event)}
        </span>
        {rendered.kind === 'text' && rendered.headline ? (
          <span className="event-headline truncate">{rendered.headline}</span>
        ) : null}
        {rendered.kind === 'text' && rendered.extra ? (
          <span className="tiny faint truncate">{rendered.extra}</span>
        ) : null}
        {rendered.kind === 'facts' && rendered.note ? (
          <span className="tiny faint truncate">{rendered.note}</span>
        ) : null}
        {repeats > 1 ? (
          <span className="badge neutral" title={`${repeats} eventos idénticos seguidos`}>
            ×{repeats}
          </span>
        ) : null}
        <span className="event-seq tiny faint mono">#{event.seq}</span>
        <Glyph icon={ACTION_ICON.expandJson} size={13} className="event-more" />
      </span>

      {rendered.kind === 'text' && rendered.body ? (
        <span className="event-body">
          {rendered.body.length > 600 ? `${rendered.body.slice(0, 600)}…` : rendered.body}
        </span>
      ) : null}

      {rendered.kind === 'facts' ? (
        <span className="facts">
          {rendered.facts.map((fact) => (
            <span key={fact.label} className={`fact ${fact.tone ?? ''}`}>
              <span className="fact-label">{fact.label}</span>
              <span className={`fact-value ${fact.mono ? 'mono' : ''}`} title={fact.value}>
                {fact.value}
              </span>
            </span>
          ))}
        </span>
      ) : null}
    </button>
  );
}

/**
 * Lo repetido se cuenta una vez, con su rango.
 *
 * Un agente que razona emite el mismo evento cada pocos segundos, y la línea de tiempo se llenaba
 * de cuatro tarjetas idénticas —«el modelo está pensando», cuatro veces— que empujaban fuera de la
 * pantalla lo único que se venía a leer. Se agrupa **sólo lo consecutivo e idéntico**: dos
 * respuestas distintas no se juntan nunca, aunque lleguen seguidas, porque cada una dice algo.
 *
 * La firma es lo que se pinta, no el payload: dos eventos que se leen igual son, para quien mira,
 * el mismo evento repetido.
 */
interface Cluster {
  event: RunEvent;
  count: number;
  from: string;
  to: string;
}

function signatureOf(event: RunEvent): string {
  const rendered = describe(event);
  const body = rendered.kind === 'text'
    ? [rendered.headline, rendered.body, rendered.extra].join('|')
    : rendered.facts.map((fact) => `${fact.label}=${fact.value}`).join('|');
  return `${event.type}|${body}`;
}

function cluster(events: RunEvent[]): Cluster[] {
  const clusters: Cluster[] = [];
  let signature = '';
  for (const event of events) {
    const current = signatureOf(event);
    const last = clusters.at(-1);
    if (last && current === signature) {
      last.count += 1;
      last.to = event.at;
      continue;
    }
    signature = current;
    clusters.push({ event, count: 1, from: event.at, to: event.at });
  }
  return clusters;
}

const timeOf = (iso: string): string => new Date(iso).toLocaleTimeString();

/**
 * Lo que pidió la persona, como primera fila del hilo.
 *
 * Se distingue del resto por el azul —el color de «tú» en todo el producto— frente al violeta del
 * agente, así que en un vistazo se ve quién dijo qué sin leer una sola etiqueta.
 */
function UserMessageRow({ text, tail }: { text: string; tail: boolean }): JSX.Element {
  return (
    <div className="tl-row user">
      <div className="tl-time" />
      <div className="tl-rail">
        <span className="tl-dot accent">
          <Glyph icon={ACTION_ICON.send} size={13} />
        </span>
        {tail ? <span className="tl-line" /> : null}
      </div>
      <div className="event-card user" role="note">
        <span className="event-head">
          <span className="badge accent">
            <Glyph icon={ACTION_ICON.send} />
            lo que pediste
          </span>
        </span>
        <span className="event-body">{text}</span>
      </div>
    </div>
  );
}

/** Una fila de la línea de tiempo: un evento, con su hora y su punto en el carril. */
function EventRow({ item, tail, nested, onOpen }: {
  item: Cluster;
  tail: boolean;
  /** Colgada de un tramo desplegado, no del hilo: se indenta para que se vea de quién es. */
  nested?: boolean;
  onOpen: () => void;
}): JSX.Element {
  const visual = visualOf(item.event.type);
  return (
    <div className={`tl-row ${isAnswer(item.event) ? 'answer' : ''} ${nested ? 'nested' : ''}`}>
      <div className="tl-time">
        {timeOf(item.from)}
        {/*
          * El final va en su propia línea, no seguido.
          *
          * La columna de la hora es estrecha y no crece: en línea, «7:18:32 PM → 7:18:40 PM»
          * se cortaba a media hora y el rango de un grupo quedaba ilegible justo donde
          * explica cuánto duró.
          */}
        {item.count > 1 && item.to !== item.from ? (
          <span className="tl-time__to faint">→ {timeOf(item.to)}</span>
        ) : null}
      </div>
      <div className="tl-rail">
        <span className={`tl-dot ${visual.tone}`}>
          <Glyph icon={isThinking(item.event) ? ACTION_ICON.session : visual.icon} size={13} />
        </span>
        {tail ? <span className="tl-line" /> : null}
      </div>
      <EventCard event={item.event} repeats={item.count} onOpen={onOpen} />
    </div>
  );
}

/**
 * Lo que el agente hizo entre dos cosas que dijo.
 *
 * Un tramo son los eventos que no son respuesta: el arranque, los cambios de estado, cada
 * herramienta, cada vuelta de razonamiento. Treinta tarjetas para contar «estuvo trabajando».
 */
interface Steps {
  /** La identidad del tramo: el `seq` de su primer evento, que ya no cambia aunque lleguen más. */
  key: number;
  items: Cluster[];
  /** Eventos, no grupos: es lo que se promete al desplegar. */
  count: number;
  from: string;
  to: string;
}

type Row =
  | { key: string; kind: 'user'; text: string }
  | { key: string; kind: 'steps'; steps: Steps }
  | { key: string; kind: 'event'; item: Cluster; nested: boolean };

/**
 * El hilo, tramo a tramo.
 *
 * Todo lo que no es una respuesta se acumula hasta la siguiente respuesta y se cuenta en una sola
 * tarjeta; lo que el agente dijo se queda en su propia fila, íntegro y sin plegar. El resultado
 * es siempre la misma silueta —lo que pediste, una tarjeta de trabajo, lo que contestó— por largo
 * que sea el trabajo por dentro.
 */
function buildRows(
  clusters: Cluster[],
  userMessage: string | null | undefined,
  isOpen: (key: number) => boolean,
): Row[] {
  const rows: Row[] = [];
  if (userMessage) rows.push({ key: 'user', kind: 'user', text: userMessage });

  let pending: Cluster[] = [];
  const flush = (): void => {
    const first = pending[0];
    const last = pending.at(-1);
    if (!first || !last) return;
    const steps: Steps = {
      key: first.event.seq,
      items: pending,
      count: pending.reduce((total, item) => total + item.count, 0),
      from: first.from,
      to: last.to,
    };
    rows.push({ key: `steps-${steps.key}`, kind: 'steps', steps });
    if (isOpen(steps.key)) {
      for (const item of pending) {
        rows.push({ key: `e${item.event.seq}`, kind: 'event', item, nested: true });
      }
    }
    pending = [];
  };

  for (const item of clusters) {
    if (isAnswer(item.event)) {
      flush();
      rows.push({ key: `e${item.event.seq}`, kind: 'event', item, nested: false });
      continue;
    }
    pending.push(item);
  }
  flush();
  return rows;
}

/** Lo último que se sabe de un tramo, en una línea. Es lo que enseña la tarjeta mientras trabaja. */
function summaryOf(event: RunEvent): string {
  const rendered = describe(event);
  const text = rendered.kind === 'text'
    ? rendered.headline ?? rendered.body ?? rendered.extra ?? ''
    : rendered.facts.slice(0, 3).map((fact) => `${fact.label}: ${fact.value}`).join(' · ')
      || rendered.note
      || '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 180 ? `${flat.slice(0, 180)}…` : flat;
}

/**
 * El tramo de trabajo, en una sola tarjeta.
 *
 * Enseña lo más reciente y nada más: mientras el agente trabaja, la tarjeta cambia de contenido en
 * vez de empujar la anterior hacia arriba, así que la respuesta que se está esperando no se va
 * nunca de la pantalla. El resto no se ha perdido —está a un clic, entero y en orden— pero deja de
 * competir por el sitio con lo único que se venía a leer.
 *
 * El giro va arriba a la derecha, que es donde ya se mira para saber si algo sigue vivo, y sólo lo
 * lleva el tramo en curso: un tramo cerrado no gira, cuenta cuántos pasos costó.
 */
function StepsRow({ steps, live, open, tail, onToggle }: {
  steps: Steps;
  /** El agente sigue en ello: esto todavía va a cambiar. */
  live: boolean;
  open: boolean;
  tail: boolean;
  onToggle: () => void;
}): JSX.Element {
  const latest = steps.items.at(-1) as Cluster;
  const visual = visualOf(latest.event.type);
  const pasos = steps.count === 1 ? '1 paso' : `${steps.count} pasos`;
  /*
   * Desplegada, la tarjeta deja de ser «lo último» y pasa a ser el título de lo que hay debajo.
   * Manteniendo el resumen se leía dos veces el mismo evento, una encima de la otra, y el rango
   * de `seq` dice algo que no se ve de un vistazo: por dónde va el stream.
   */
  const icon = open ? STATUS_ICON.activity : isThinking(latest.event) ? ACTION_ICON.session : visual.icon;
  const tone = open ? '' : visual.tone;
  const first = steps.items[0] as Cluster;

  return (
    <div className="tl-row steps">
      <div className="tl-time">
        {timeOf(steps.from)}
        {steps.to !== steps.from ? <span className="tl-time__to faint">→ {timeOf(steps.to)}</span> : null}
      </div>
      <div className="tl-rail">
        <span className={`tl-dot ${tone}`}>
          <Glyph icon={icon} size={13} />
        </span>
        {tail ? <span className="tl-line" /> : null}
      </div>
      <button
        type="button"
        className={`event-card steps ${tone}`}
        aria-expanded={open}
        onClick={onToggle}
        title={open ? 'Plegar y volver a ver sólo lo último' : `Desplegar ${pasos}`}
      >
        <span className="event-head">
          <span className={`badge ${tone}`}>
            <Glyph icon={icon} />
            {open ? 'lo que hizo' : kindLabel(latest.event)}
          </span>
          {/*
            * La `key` es lo que hace que esto se lea como un cambio y no como un salto: al llegar
            * un evento nuevo, React remonta la línea y la animación vuelve a correr.
            */}
          <span key={latest.event.seq} className="event-headline steps-latest truncate">
            {open
              ? `del #${first.event.seq} al #${latest.event.seq}`
              : summaryOf(latest.event)}
          </span>
          {latest.count > 1 && !open ? (
            <span className="badge neutral" title={`${latest.count} eventos idénticos seguidos`}>
              ×{latest.count}
            </span>
          ) : null}
          <span className="steps-meta">
            {live ? (
              <>
                <Glyph icon={RUN_STATUS_ICON.running} size={14} className="spin" />
                <span className="visually-hidden">trabajando</span>
              </>
            ) : null}
            <span className="tiny faint nowrap">{pasos}</span>
            <Glyph icon={open ? ACTION_ICON.scrollUp : ACTION_ICON.scrollDown} size={14} />
          </span>
        </span>
      </button>
    </div>
  );
}

/**
 * La línea de tiempo de un trabajo.
 *
 * La hora va fuera de la tarjeta, en su propia columna: al recorrerla se busca «qué pasó», no «a
 * qué hora»; la hora sirve cuando ya has encontrado el sitio.
 */
export function EventTimeline({ events, empty, limit, userMessage, live = false }: {
  events: RunEvent[];
  /** Qué explicar cuando no hay nada: por qué está vacío y qué lo llenará. */
  empty?: string;
  limit?: number;
  /**
   * Lo que pidió la persona, al principio del hilo.
   *
   * Un hilo que empieza por «el agente arrancó» obliga a recordar qué se había pedido. Se enseña
   * siempre, incluso cuando todavía no ha llegado ningún evento.
   */
  userMessage?: string | null;
  /**
   * El trabajo sigue vivo.
   *
   * Sólo cambia una cosa —si el último tramo gira o no—, pero es la diferencia entre «está
   * pensando» y «se quedó así», que es justo lo que no se puede deducir mirando eventos parados.
   */
  live?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState<number | null>(null);
  const [mode, setMode] = useState<'compacto' | 'todo'>('compacto');
  /** Los tramos a los que se les ha llevado la contraria al modo. Se olvidan al cambiarlo. */
  const [flipped, setFlipped] = useState<Set<number>>(new Set());

  const isOpen = (key: number): boolean => flipped.has(key) !== (mode === 'todo');
  const toggle = (key: number): void => setFlipped((previous) => {
    const next = new Set(previous);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const answers = events.filter(isAnswer);
  const clusters = cluster(limit ? events.slice(-limit) : events);
  const rows = buildRows(clusters, userMessage, isOpen);
  const opened = events.find((event) => event.seq === open);

  /*
   * Qué tramo está en curso.
   *
   * El último, y sólo si después no ha contestado nadie: en cuanto llega la respuesta, el tramo
   * que la precedía está cerrado por definición y dejar de girar es la mitad del mensaje.
   */
  const tip = clusters.at(-1);
  const activeKey = live && tip && !isAnswer(tip.event)
    ? rows.reduce<number | null>((key, row) => (row.kind === 'steps' ? row.steps.key : key), null)
    : null;

  if (events.length === 0) {
    return (
      <>
        {userMessage ? <UserMessageRow text={userMessage} tail={false} /> : null}
        <Empty
          tight
          icon={STATUS_ICON.activity}
          title="Sin eventos todavía"
          hint={empty ?? 'Cada cosa que diga el agente aparece aquí en cuanto llega, y se guarda para poder volver a leerla.'}
        />
      </>
    );
  }

  return (
    <>
      {/*
        * Desplegarlo todo de una vez.
        *
        * Cada tramo se abre por su cuenta —que es como se mira un trabajo: se sospecha de un
        * sitio y se abre ese—, pero depurar es lo contrario: se quiere el log entero sin ir
        * abriendo tramo por tramo. Se ofrece sólo cuando hay bastante que plegar como para que
        * la diferencia entre los dos modos signifique algo.
        */}
      {events.length > 4 ? (
        <div className="timeline-head">
          <span className="small muted">
            {answers.length === 0
              ? `${events.length} eventos, todavía sin respuesta`
              : `${answers.length === 1 ? '1 respuesta' : `${answers.length} respuestas`}`
                + ` entre ${events.length} eventos`}
          </span>
          <Segmented
            label="Cuánto detalle se enseña"
            value={mode}
            onChange={(value) => { setMode(value); setFlipped(new Set()); }}
            options={[
              { value: 'compacto', label: 'Compacto', icon: ACTION_ICON.exitFullscreen },
              { value: 'todo', label: 'Todo', icon: STATUS_ICON.activity },
            ]}
          />
        </div>
      ) : null}

      <div className="timeline">
        {rows.map((row, index) => {
          const tail = index < rows.length - 1;
          if (row.kind === 'user') return <UserMessageRow key={row.key} text={row.text} tail={tail} />;
          if (row.kind === 'steps') {
            return (
              <StepsRow
                key={row.key}
                steps={row.steps}
                live={row.steps.key === activeKey}
                open={isOpen(row.steps.key)}
                tail={tail}
                onToggle={() => toggle(row.steps.key)}
              />
            );
          }
          return (
            <EventRow
              key={row.key}
              item={row.item}
              tail={tail}
              nested={row.nested}
              onOpen={() => setOpen(row.item.event.seq)}
            />
          );
        })}
      </div>
      {opened ? <EventDetail event={opened} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
