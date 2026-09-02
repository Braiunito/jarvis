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

const visualOf = (type: string): EventVisual =>
  VISUALS[type] ?? { icon: STATUS_ICON.activity, tone: '' };

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

function EventCard({ event, onOpen }: { event: RunEvent; onOpen: () => void }): JSX.Element {
  const visual = visualOf(event.type);
  const rendered = describe(event);
  const answer = isAnswer(event);

  return (
    <button type="button" className={`event-card ${visual.tone} ${answer ? 'answer' : ''}`}
      onClick={onOpen} title="Ver el evento tal y como llegó">
      <span className="event-head">
        <span className={`badge ${visual.tone}`}>
          <Glyph icon={visual.icon} />
          {EVENT_KIND[event.type] ?? event.type}
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
              <span className={`fact-value ${fact.mono ? 'mono' : ''}`}>{fact.value}</span>
            </span>
          ))}
        </span>
      ) : null}
    </button>
  );
}

/**
 * La línea de tiempo de un trabajo.
 *
 * La hora va fuera de la tarjeta, en su propia columna: al recorrerla se busca «qué pasó», no «a
 * qué hora»; la hora sirve cuando ya has encontrado el sitio.
 */
export function EventTimeline({ events, empty, limit }: {
  events: RunEvent[];
  /** Qué explicar cuando no hay nada: por qué está vacío y qué lo llenará. */
  empty?: string;
  limit?: number;
}): JSX.Element {
  const [open, setOpen] = useState<number | null>(null);
  const [onlyAnswers, setOnlyAnswers] = useState(false);

  const answers = events.filter(isAnswer);
  const source = onlyAnswers ? answers : events;
  const shown = limit ? source.slice(-limit) : source;
  const opened = shown.find((event) => event.seq === open);

  if (events.length === 0) {
    return (
      <Empty
        tight
        icon={STATUS_ICON.activity}
        title="Sin eventos todavía"
        hint={empty ?? 'Cada cosa que diga el agente aparece aquí en cuanto llega, y se guarda para poder volver a leerla.'}
      />
    );
  }

  return (
    <>
      {/*
        * Aislar las respuestas.
        *
        * En un trabajo largo, lo que dijo el agente son dos líneas entre treinta de fontanería.
        * El filtro no borra nada —vuelve con un clic— pero convierte «buscar dónde contestó» en
        * «mirar». Se ofrece sólo cuando hay bastante ruido como para que sirva de algo.
        */}
      {answers.length > 0 && events.length > 4 ? (
        <div className="timeline-head">
          <span className="small muted">
            {answers.length === 1 ? '1 respuesta' : `${answers.length} respuestas`}
            {' entre '}
            {events.length} eventos
          </span>
          <Segmented
            label="Qué eventos se enseñan"
            value={onlyAnswers ? 'respuestas' : 'todo'}
            onChange={(value) => setOnlyAnswers(value === 'respuestas')}
            options={[
              { value: 'todo', label: 'Todo', icon: STATUS_ICON.activity },
              { value: 'respuestas', label: 'Sólo respuestas', icon: ACTION_ICON.message },
            ]}
          />
        </div>
      ) : null}

      <div className="timeline">
        {shown.map((event, index) => {
          const visual = visualOf(event.type);
          return (
            <div key={event.seq} className={`tl-row ${isAnswer(event) ? 'answer' : ''}`}>
              <div className="tl-time">{new Date(event.at).toLocaleTimeString()}</div>
              <div className="tl-rail">
                <span className={`tl-dot ${visual.tone}`}>
                  <Glyph icon={visual.icon} size={13} />
                </span>
                {index < shown.length - 1 ? <span className="tl-line" /> : null}
              </div>
              <EventCard event={event} onOpen={() => setOpen(event.seq)} />
            </div>
          );
        })}
      </div>
      {opened ? <EventDetail event={opened} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
