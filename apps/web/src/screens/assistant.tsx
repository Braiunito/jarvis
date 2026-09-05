/**
 * El Asistente: la sección propia del asistente de casa.
 *
 * Es una conversación, así que se lee de arriba abajo y lo último está abajo. Lo que la separa de
 * un chat cualquiera es que aquí **se ve el trabajo**: cada consulta que hace el modelo aparece
 * como una línea con su nombre real —`zeus.memory_pressure`, no «usando una herramienta»— y se
 * puede abrir para ver qué devolvió. Un asistente que consulta seis cosas y contesta una frase
 * sin enseñar de dónde sale es indistinguible de uno que se lo inventa.
 *
 * Tres cosas que la pantalla promete y por las que está construida así:
 *
 *  · **De dónde sale cada respuesta.** Cada burbuja lleva su origen. Con la casa se piensa gratis;
 *    con la nube se paga y sale de aquí, así que no puede ser un detalle escondido en un tooltip.
 *  · **Cuánta cuerda tiene**, visible y cambiable en el sitio donde se está usando, no enterrada
 *    en unos ajustes. Es la decisión que más cambia lo que va a pasar.
 *  · **Lo que espera tu firma**, arriba del todo y con lo que se va a hacer escrito entero. Una
 *    aprobación que hay que buscar es una aprobación que se acaba dando sin leer.
 */
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { Approval, AutonomyMode, ChatMessage, ChatRef } from '@jarvis/contracts';
import type { SpendSummary } from '@jarvis/contracts';
import {
  useCapabilityCatalog, useConversation, useConversations, useDeleteConversation,
  useOpenWorkspace, useResolveApproval, useSendMessage, useSetAutonomy, useSpend,
} from '../api/queries.js';
import { useChatStream } from '../api/chat-stream.js';
import { terminalHref } from '../api/links.js';
import { navigate, useRoute } from '../router.js';
import { Empty, ErrorNote, Link, Loading, relativeTime } from '../ui/bits.jsx';
import {
  ACTION_ICON, Glyph, NAV_ICON, PROVIDER_ICON, SOURCE_ICON, STATUS_ICON,
} from '../ui/icons.jsx';
import { useAskAssistant } from '../ui/ask-assistant.jsx';
import { usePageMeta } from '../ui/page-meta.jsx';
import { DataRow, Segmented } from '../ui/primitives.jsx';

const AUTONOMY_OPTIONS: Array<{ value: AutonomyMode; label: string; hint: string }> = [
  {
    value: 'manual',
    label: 'Manual',
    hint: 'Todo lo que tenga efectos te lo pregunta antes, incluido lanzar un trabajo en modo seguro.',
  },
  {
    value: 'auto',
    label: 'Automático',
    hint: 'Puede lanzar trabajo en modo seguro sin preguntar. Sigue pidiéndote permiso para tocar '
      + 'una máquina, para los permisos de escritura y para salir a la nube.',
  },
];

/** El nombre corto de un modelo: lo que cabe en un distintivo sin dejar de identificarlo. */
const shortModel = (model: string | null): string => model?.split('/').pop() ?? 'modelo';

/**
 * Con qué se contestó esto.
 *
 * Enseña **el modelo**, no dónde vive. Durante un tiempo puso «casa» y «nube», que era cierto
 * cuando el primer escalón era un `llama-server` en el bastión; hoy los dos están fuera y esa
 * etiqueta sería una mentira en cada mensaje. Lo que de verdad se quiere saber mirando una
 * respuesta concreta es si la contestó el barato o costó veinticinco veces más, y eso lo dice el
 * nombre.
 */
function SourceBadge({ source, model }: { source: string | null; model: string | null }): JSX.Element | null {
  if (!source) return null;
  const escalado = source === 'cloud';
  return (
    <span
      className={`badge ${escalado ? 'warn' : 'ok'} tiny`}
      title={escalado ? `Escalado: contestó ${model}` : `Contestó ${model}`}
    >
      {escalado ? <Glyph icon={SOURCE_ICON.cloud} /> : null}
      {shortModel(model)}
    </span>
  );
}

/**
 * Una consulta del asistente, plegada.
 *
 * Plegada porque el hilo lo lee una persona y un volcado de JSON entre dos frases lo rompe;
 * desplegable porque cuando algo no cuadra, lo que hay que mirar es justo esto.
 */
function ToolTrace({ message }: { message: ChatMessage }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className={`chat-tool ${message.toolOk === false ? 'failed' : ''}`}>
      <button type="button" className="chat-tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Glyph icon={message.toolOk === false ? ACTION_ICON.error : ACTION_ICON.capability} size={14} />
        <span className="mono">{message.toolName}</span>
        {message.toolOk === false ? <span className="badge danger tiny">falló</span> : null}
        <Glyph icon={open ? ACTION_ICON.collapse : ACTION_ICON.expand} size={14} />
      </button>
      {open ? (
        <div className="chat-tool-body">
          {message.toolInput && Object.keys(message.toolInput as object).length ? (
            <pre className="tiny mono">{JSON.stringify(message.toolInput, null, 2)}</pre>
          ) : null}
          <pre className="tiny mono">{message.text}</pre>
        </div>
      ) : null}
    </div>
  );
}

/**
 * La tarjeta de permiso.
 *
 * Dice **qué** se va a hacer y **dónde**, con el texto entero y sin recortar: lo que se autoriza
 * es exactamente esto. Las tres clases de permiso que puede pedir el asistente se leen distinto
 * porque no se parecen en nada —salir a la nube cuesta dinero, reiniciar un servicio tumba algo
 * durante unos minutos, lanzar un trabajo escribe en un repositorio—.
 */
function ApprovalCard({ approval, onDecide, pending }: {
  approval: Approval;
  onDecide: (decision: 'approved' | 'rejected') => void;
  pending: boolean;
}): JSX.Element {
  const target = approval.target as {
    reason?: string; capability?: string; args?: Record<string, unknown>;
    host?: string; permissionProfile?: string; prompt?: string; model?: string;
  };
  const expiresIn = Math.max(0, Math.round((Date.parse(approval.expiresAt) - Date.now()) / 60_000));

  const heading = approval.actionType === 'escalate' ? 'Quiere consultar a la nube'
    : approval.actionType === 'capability' ? 'Quiere tocar una máquina'
      : 'Quiere lanzar un trabajo';

  return (
    <div className="card warn-card chat-approval">
      <h3 className="row" style={{ color: 'var(--warn)', gap: 6, margin: '0 0 6px' }}>
        <Glyph icon={approval.actionType === 'escalate' ? SOURCE_ICON.cloud : ACTION_ICON.capability} size={16} />
        {heading}
      </h3>
      <p style={{ margin: '0 0 8px' }}>{approval.summary}</p>

      <div className="row small" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
        {target.capability ? <span className="badge neutral mono">{target.capability}</span> : null}
        {target.model ? <span className="badge neutral mono">{target.model}</span> : null}
        {target.host ? <span className="badge neutral mono">{target.host}</span> : null}
        {target.permissionProfile ? <span className="badge warn">{target.permissionProfile}</span> : null}
        <span className="muted">caduca en {expiresIn} min</span>
      </div>

      {/* Los argumentos exactos: entre lo que se lee aquí y lo que se ejecuta no cabe un cambio. */}
      {target.args && Object.keys(target.args).length ? (
        <pre className="small mono chat-approval-args">{JSON.stringify(target.args, null, 2)}</pre>
      ) : null}
      {target.prompt ? <pre className="small mono chat-approval-args">{target.prompt}</pre> : null}

      <div className="row">
        <button type="button" className="btn primary" disabled={pending} onClick={() => onDecide('approved')}>
          <Glyph icon={ACTION_ICON.approve} />
          Autorizar
        </button>
        <button type="button" className="btn danger" disabled={pending} onClick={() => onDecide('rejected')}>
          <Glyph icon={ACTION_ICON.reject} />
          No
        </button>
      </div>
    </div>
  );
}

/**
 * Lo que llevamos gastado.
 *
 * Dice «gastado», nunca «te queda en la cuenta», y la diferencia no es de estilo: **el proveedor
 * no da el saldo** —una clave de proyecto recibe un 403 al pedirlo— así que esto son los tokens
 * que este core ha visto pasar, con la tarifa que tiene puesta. Presentarlo como saldo sería
 * inventarse un dato que alguien va a mirar justo antes de que la clave deje de funcionar.
 *
 * El resto en consultas sólo aparece si se declaró cuánto se cargó, y se calcula con la media de
 * las vueltas de verdad. Sin presupuesto declarado se enseña sólo lo gastado, que es lo que se
 * sabe.
 */
function SpendBadge({ spend }: { spend: SpendSummary }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (!spend.turns) return null;

  const dinero = (usd: number): string => (usd < 0.01 ? `${(usd * 100).toFixed(2)} ¢` : `${usd.toFixed(2)} $`);
  const gastadoPct = spend.budgetUsd ? Math.min(100, (spend.spentUsd / spend.budgetUsd) * 100) : 0;
  // Amarillo a partir de tres cuartos y rojo en el último décimo: hay tiempo de reaccionar.
  const tono = gastadoPct >= 90 ? 'danger' : gastadoPct >= 75 ? 'warn' : 'ok';

  return (
    <div className="chat-spend">
      <button
        type="button"
        className={`badge ${spend.budgetUsd ? tono : 'neutral'} tiny`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title="Estimado a partir de los tokens que ha visto este servidor. No es el saldo de la cuenta."
      >
        <Glyph icon={STATUS_ICON.gauge} />
        {spend.remainingTurns !== null
          ? `~${spend.remainingTurns.toLocaleString('es-ES')} consultas`
          : dinero(spend.spentUsd)}
      </button>

      {open ? (
        <div className="chat-spend-detail card">
          <p className="tiny faint" style={{ margin: '0 0 8px' }}>
            Estimado con los tokens que ha visto este servidor y la tarifa configurada.
            <strong> No es el saldo de la cuenta</strong>: la clave de API no puede consultarlo.
          </p>
          <DataRow label="Gastado">
            {dinero(spend.spentUsd)} en {spend.turns.toLocaleString('es-ES')} vueltas
          </DataRow>
          {spend.budgetUsd !== null ? (
            <>
              <DataRow label="De lo cargado">{dinero(spend.budgetUsd)}</DataRow>
              <DataRow label="Queda">{dinero(spend.remainingUsd ?? 0)}</DataRow>
            </>
          ) : (
            <p className="tiny faint" style={{ margin: '6px 0 0' }}>
              Para saber cuánto queda, declara lo cargado en <code>JARVIS_MODEL_BUDGET_USD</code>.
            </p>
          )}
          {spend.avgTurnUsd ? <DataRow label="Por vuelta">{dinero(spend.avgTurnUsd)}</DataRow> : null}

          <div className="chat-spend-models">
            {spend.byModel.map((entry) => (
              <div key={`${entry.model}:${entry.source}`} className="row between tiny">
                <span className="mono">{entry.model}</span>
                <span className="faint">
                  {entry.turns} · {entry.usd === null ? 'sin tarifa' : dinero(entry.usd)}
                </span>
              </div>
            ))}
          </div>
          {spend.unpriced.length ? (
            <p className="tiny warn" style={{ margin: '8px 0 0' }}>
              Sin tarifa configurada: {spend.unpriced.join(', ')}. Su gasto no está contado.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Un título de sesión puede ser un párrafo. En un botón cabe una línea. */
const short = (text: string, max = 56): string =>
  (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Una sesión citada.
 *
 * Es la única referencia que no es un enlace: una sesión que el asistente encontró en el índice
 * puede no tener workspace todavía, así que abrirla es crearlo y entrar. Se hace con la misma
 * llamada que usa el explorador, no con una copia.
 */
function SessionRef({ target }: { target: Extract<ChatRef, { kind: 'session' }> }): JSX.Element {
  const open = useOpenWorkspace();
  return (
    <>
      <button
        type="button"
        className="btn small"
        disabled={open.isPending}
        title={`${target.provider} · ${target.host} · ${target.sessionId}`}
        onClick={() => open.mutate(
          {
            ref: { host: target.host, provider: target.provider, sessionId: target.sessionId },
            title: target.title,
          },
          { onSuccess: (result) => navigate(`/w/${result.workspace.id}`) },
        )}
      >
        <Glyph icon={PROVIDER_ICON[target.provider] ?? ACTION_ICON.session} />
        {open.isPending ? 'Abriendo…' : short(target.title ?? target.sessionId)}
      </button>
      {open.error ? (
        <span style={{ flex: '1 1 100%' }}><ErrorNote error={open.error} /></span>
      ) : null}
    </>
  );
}

/**
 * La terminal que el asistente propone.
 *
 * Lleva el motivo escrito, y no es adorno: sin él es un botón que manda a una máquina sin decir a
 * qué. Es el mismo trato que la oferta del panel de planes, que es donde se aprendió.
 */
function TerminalRef({ target }: { target: Extract<ChatRef, { kind: 'terminal' }> }): JSX.Element {
  return (
    <div className="note">
      <Glyph icon={NAV_ICON.terminal} size={16} />
      <span>
        <span className="small">{target.reason}</span>
        <span className="row tight" style={{ marginTop: 8 }}>
          <Link
            to={terminalHref({
              host: target.host,
              provider: target.provider,
              sessionId: target.sessionId,
              from: target.workspaceId,
            })}
            className="btn small"
          >
            <Glyph icon={NAV_ICON.terminal} />
            Abrir terminal en {target.host}
          </Link>
          <span className="tiny faint mono">{target.cwd ?? target.sessionId}</span>
        </span>
      </span>
    </div>
  );
}

/**
 * Lo que encontró, en forma de acción.
 *
 * Un asistente que contesta «esa sesión está en zeus, en /srv/app» y te deja ahí ha hecho la
 * mitad del trabajo: quien pregunta quiere abrirla. Por eso cada referencia se pinta como algo
 * que se pulsa y vive dentro de la burbuja —es parte de la respuesta, no una lista aparte—.
 */
function MessageRefs({ message }: { message: ChatMessage }): JSX.Element | null {
  const refs = message.refs;
  const terminals = refs.filter(
    (ref): ref is Extract<ChatRef, { kind: 'terminal' }> => ref.kind === 'terminal');
  const compact = refs.filter(
    (ref): ref is Exclude<ChatRef, { kind: 'terminal' }> => ref.kind !== 'terminal');

  /*
   * `runIds` es lo que citaban las filas de antes y sigue vivo, así que se pinta igual. Lo que ya
   * viene como referencia no se repite: el mismo trabajo dos veces en la misma burbuja se lee
   * como dos trabajos.
   */
  const cited = new Set(compact
    .filter((ref): ref is Extract<ChatRef, { kind: 'run' }> => ref.kind === 'run')
    .map((ref) => ref.runId));
  const legacyRuns = message.runIds.filter((runId) => !cited.has(runId));

  if (!compact.length && !terminals.length && !legacyRuns.length) return null;

  return (
    <div className="chat-refs">
      {compact.length || legacyRuns.length ? (
        <div className="row tight">
          {compact.map((ref, index) => {
            if (ref.kind === 'workspace') {
              return (
                <Link key={`w:${index}:${ref.workspaceId}`} to={`/w/${ref.workspaceId}`}
                  className="btn small" title="Abrir el workspace de esta sesión">
                  <Glyph icon={ACTION_ICON.open} />
                  {short(ref.title ?? 'Abrir workspace')}
                </Link>
              );
            }
            if (ref.kind === 'run') {
              return (
                <Link key={`r:${index}:${ref.runId}`} to={`/runs/${ref.runId}`}
                  className="btn small" title="Ver el trabajo y lo que dejó">
                  <Glyph icon={NAV_ICON.runs} />
                  {short(ref.title ?? 'Ver el trabajo')}
                </Link>
              );
            }
            return <SessionRef key={`s:${index}:${ref.sessionId}`} target={ref} />;
          })}
          {legacyRuns.map((runId) => (
            <Link key={runId} to={`/runs/${runId}`} className="btn small">
              <Glyph icon={NAV_ICON.runs} />
              Ver el trabajo
            </Link>
          ))}
        </div>
      ) : null}
      {terminals.map((ref, index) => (
        <TerminalRef key={`t:${index}:${ref.sessionId}`} target={ref} />
      ))}
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }): JSX.Element {
  if (message.role === 'tool') return <ToolTrace message={message} />;

  if (message.role === 'event') {
    return (
      <div className="chat-event">
        <Glyph icon={STATUS_ICON.activity} size={14} />
        <span>{message.text}</span>
      </div>
    );
  }

  return (
    <div className={`chat-bubble ${message.role}`}>
      <div className="chat-bubble-meta">
        {message.role === 'assistant'
          ? <SourceBadge source={message.source} model={message.modelId} />
          : <span className="tiny faint">tú</span>}
        <span className="tiny faint">{relativeTime(message.createdAt)}</span>
      </div>
      <div className="chat-bubble-text">{message.text}</div>
      <MessageRefs message={message} />
    </div>
  );
}

export function AssistantScreen(): JSX.Element {
  usePageMeta({ title: 'Asistente', subtitle: 'El modelo de casa, con las máquinas delante' });
  const route = useRoute();
  const active = route.segments[1] ?? null;
  /**
   * De qué workspace se viene.
   *
   * Una conversación sin workspace es sobre la casa; con él alcanza el trabajo de esa sesión y
   * sabe en qué carpeta vive, que es lo que decide si la terminal que acabe ofreciendo abre donde
   * está el problema o en el home. Venía en la URL y se tiraba, así que entrar desde un workspace
   * daba exactamente la misma conversación que entrar desde el menú.
   */
  const fromWorkspace = route.query.get('workspace');

  const list = useConversations();
  const detail = useConversation(active);
  const catalog = useCapabilityCatalog();
  const stream = useChatStream(active);
  const ask = useAskAssistant();
  const send = useSendMessage(active);
  const setAutonomy = useSetAutonomy(active);
  const remove = useDeleteConversation();
  const resolve = useResolveApproval();

  const spend = useSpend();
  const [draft, setDraft] = useState('');
  /**
   * La lista de conversaciones, en estrecho, como hoja.
   *
   * En un móvil el hilo abierto es a lo que se ha entrado, y una tira de títulos robándole un
   * quinto de la pantalla estorba en todos los mensajes para servir en uno de cada veinte. Es el
   * mismo problema que ya resolvió el panel de detalle, así que se resuelve igual: la lista se
   * pide, tapa lo de detrás mientras se usa, y se va.
   */
  const [listOpen, setListOpen] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  /*
   * Los mensajes vienen de dos sitios: la carga inicial y el stream. Se juntan por `seq`, que es
   * identidad pública y no se reutiliza, así que basta con quedarse con el mayor de cada uno.
   */
  const merged = new Map<number, ChatMessage>();
  for (const message of detail.data?.messages ?? []) merged.set(message.seq, message);
  for (const message of stream.messages) merged.set(message.seq, message);
  const messages = [...merged.values()].sort((a, b) => a.seq - b.seq);

  const conversation = detail.data?.conversation;
  const status = stream.status ?? conversation?.status ?? 'idle';
  const autonomy = (stream.autonomy ?? conversation?.autonomy ?? 'manual') as AutonomyMode;
  const approvals = detail.data?.approvals ?? [];
  const capabilities = list.data?.capabilities;

  // Al llegar algo nuevo, abajo. Es una conversación: lo último es lo que se está leyendo.
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, status]);

  // Cada turno gasta, así que el contador se refresca al terminar uno y no cada pocos segundos.
  useEffect(() => {
    if (status === 'idle') void spend.refetch();
  }, [status, messages.length]);

  /** Elegir una conversación cierra la hoja: seguir viéndola tapando el hilo no ayuda a nadie. */
  function open(id: string | null): void {
    setListOpen(false);
    route.navigate(id ? `/assistant/${id}` : '/assistant');
  }

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    if (active) {
      send.mutate(text);
      return;
    }
    // Sin conversación abierta, el primer mensaje crea una y navega a ella. Por el mismo camino
    // que los accesos del resto de pantallas, y por eso hereda el workspace del que se viene.
    ask.ask({ prompt: text, workspaceId: fromWorkspace });
  }

  const thinking = status === 'thinking';
  const noModel = capabilities && !capabilities.localAvailable && !capabilities.cloudAvailable;

  return (
    <div className={`page assistant-page ${listOpen ? 'list-open' : ''}`}>
      {/* Velo: apaga el hilo de detrás para que se entienda que la hoja manda. Sólo en estrecho. */}
      {listOpen ? (
        <button
          type="button"
          className="chat-rail-backdrop"
          aria-label="Cerrar la lista de conversaciones"
          onClick={() => setListOpen(false)}
        />
      ) : null}

      <aside className="chat-rail">
        <div className="row between" style={{ marginBottom: 8 }}>
          <strong className="small">Conversaciones</strong>
          <button type="button" className="btn small" onClick={() => open(null)} disabled={!active}>
            <Glyph icon={ACTION_ICON.send} />
            Nueva
          </button>
        </div>

        {list.isLoading ? <Loading rows={3} /> : null}
        {list.error ? <ErrorNote error={list.error} onRetry={() => void list.refetch()} /> : null}

        <ul className="chat-rail-list">
          {(list.data?.conversations ?? []).map((item) => (
            <li key={item.id}>
              <a
                href={`/assistant/${item.id}`}
                className={item.id === active ? 'current' : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  open(item.id);
                }}
              >
                <span className="chat-rail-title">{item.title}</span>
                <span className="tiny faint">
                  {relativeTime(item.lastMessageAt ?? item.createdAt)}
                  {item.status === 'waiting_approval' ? ' · espera tu permiso' : ''}
                </span>
              </a>
            </li>
          ))}
        </ul>

        {/*
          * Qué sabe mirar, contado en una línea.
          *
          * No es decoración: es lo que hace que alguien se atreva a preguntarle por el servidor en
          * vez de suponer que sólo sabe de código.
          */}
        {catalog.data?.servers.length ? (
          <div className="chat-capabilities">
            <span className="tiny faint">Sabe consultar</span>
            <ul className="tiny">
              {catalog.data.areas.slice(0, 6).map((area) => (
                <li key={area.area}>{area.area} <span className="faint">({area.count})</span></li>
              ))}
            </ul>
            {catalog.data.servers.map((server) => (
              <span key={server.name} className={`badge tiny ${server.status === 'ok' ? 'ok' : 'danger'}`}>
                {server.name} · {server.toolCount}
              </span>
            ))}
          </div>
        ) : null}
      </aside>

      <section className="chat-thread">
        {noModel ? (
          <p className="note warn" role="status">
            <Glyph icon={ACTION_ICON.error} size={16} />
            <span>
              No hay ningún modelo configurado en el core. El asistente necesita al menos
              <code> JARVIS_ASSISTANT_MODEL_BASE_URL</code> y su clave.
            </span>
          </p>
        ) : null}

        {/*
          * La cabecera sólo si tiene algo que decir.
          *
          * Sin conversación abierta ni modelo configurado se quedaba una franja con su borde y
          * nada dentro, que en un móvil es una línea de pantalla gastada en no informar.
          */}
        {active || capabilities?.localAvailable || capabilities?.cloudAvailable ? (
        <header className="chat-head">
          <div className="chat-head-title">
            {/* En estrecho, la puerta a la lista. En ancho no existe: la lista está al lado. */}
            {/* Sólo si hay algo que listar, y sólo donde la lista no cabe al lado. */}
            {(list.data?.conversations.length ?? 0) > 0 ? (
              <button
                type="button"
                className="btn small chat-head-list"
                onClick={() => setListOpen(true)}
                aria-label="Ver las conversaciones"
              >
                <Glyph icon={NAV_ICON.runs} />
              </button>
            ) : null}
            {/*
              * El título del hilo, no el de la sección: la cabecera de la página ya pone
              * «Asistente», y repetirlo debajo gasta una línea de un móvil para no decir nada.
              */}
            {active ? <h2>{stream.title ?? conversation?.title ?? 'Conversación'}</h2> : null}
          </div>

          <div className="chat-head-meta">
            {capabilities?.localAvailable ? (
              <span className="badge ok tiny" title={`Contesta ${capabilities.localModel}`}>
                {shortModel(capabilities.localModel)}
              </span>
            ) : null}
            {capabilities?.cloudAvailable ? (
              <span className="badge neutral tiny" title={`Se escala a ${capabilities.cloudModel}, con tu permiso`}>
                <Glyph icon={SOURCE_ICON.cloud} />
                {shortModel(capabilities.cloudModel)}
              </span>
            ) : null}
            {/*
              * Cuántas capacidades, y **cómo** se le ofrecen.
              *
              * El repliegue al router es silencioso: pasado el tope de funciones de la API, el
              * modelo deja de elegir a la primera y tiene que buscarlas antes, lo que cuesta una
              * vuelta más por consulta. Hasta ahora eso sólo se notaba porque el asistente iba
              * más lento, y nadie tenía por qué relacionarlo con las cuatro herramientas que
              * alguien enchufó ayer en otra máquina. Por eso el aviso llega antes de caer: con
              * tres huecos o menos, el distintivo ya lo dice.
              */}
            {capabilities?.capabilityCount ? (
              <span
                className={`badge tiny ${capabilities.capabilityMode === 'router' ? 'warn'
                  : capabilities.capabilityRoom <= 3 ? 'warn' : 'neutral'}`}
                title={capabilities.capabilityMode === 'router'
                  ? 'No caben todas como herramientas del modelo, así que las busca antes de usarlas: '
                    + 'una vuelta más por consulta.'
                  : `Se le ofrecen todas de golpe. Caben ${capabilities.capabilityRoom} más antes `
                    + 'de que tenga que buscarlas.'}
              >
                <Glyph icon={ACTION_ICON.capability} />
                {capabilities.capabilityCount}
                {capabilities.capabilityMode === 'router' ? ' · las busca'
                  : capabilities.capabilityRoom <= 3 ? ` · quedan ${capabilities.capabilityRoom}` : ''}
              </span>
            ) : null}
            {spend.data ? <SpendBadge spend={spend.data} /> : null}
          </div>

          {active ? (
            <div className="chat-head-actions">
              <Segmented
                label="Autonomía"
                value={autonomy}
                options={AUTONOMY_OPTIONS.map((option) => ({
                  value: option.value, label: option.label, hint: option.hint,
                }))}
                onChange={(value) => setAutonomy.mutate(value)}
              />
              <button
                type="button"
                className="btn small danger"
                aria-label="Borrar la conversación"
                onClick={() => remove.mutate(active, { onSuccess: () => open(null) })}
              >
                <Glyph icon={ACTION_ICON.delete} />
                <span className="chat-head-word">Borrar</span>
              </button>
            </div>
          ) : null}
        </header>
        ) : null}

        <div className="chat-messages">
          {!active ? (
            <Empty
              icon={NAV_ICON.assistant}
              title="Pregúntale a la casa"
              hint="Sabe mirar el servidor, las cámaras, los contenedores y las sesiones de agente. Empieza escribiendo abajo."
            />
          ) : null}

          {detail.isLoading ? <Loading rows={4} shape="timeline" /> : null}
          {detail.error ? <ErrorNote error={detail.error} onRetry={() => void detail.refetch()} /> : null}

          {messages.map((message) => <MessageBubble key={message.seq} message={message} />)}

          {approvals.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              pending={resolve.isPending}
              onDecide={(decision) => resolve.mutate({ id: approval.id, decision }, {
                onSuccess: () => void detail.refetch(),
              })}
            />
          ))}

          {/* Si crear la conversación falla, el composer se queda quieto y parece que no responde. */}
          <ErrorNote error={ask.error} />

          {thinking ? (
            <div className="chat-thinking">
              <Glyph icon={STATUS_ICON.activity} size={14} className="spin" />
              <span className="small faint">pensando…</span>
            </div>
          ) : null}

          <div ref={bottom} />
        </div>

        <form className="chat-composer" onSubmit={submit}>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={active ? 'Escribe…' : '¿Cómo va el servidor?'}
            rows={2}
            aria-label="Mensaje para el asistente"
            onKeyDown={(event) => {
              // Enter envía; Shift+Enter hace párrafo. Es lo que espera quien viene de cualquier chat.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit(event);
              }
            }}
          />
          <button
            type="submit"
            className="btn primary chat-send"
            disabled={!draft.trim() || send.isPending || ask.pending}
            aria-label="Enviar"
          >
            <Glyph icon={ACTION_ICON.send} />
            <span className="chat-head-word">Enviar</span>
          </button>
        </form>
      </section>
    </div>
  );
}
