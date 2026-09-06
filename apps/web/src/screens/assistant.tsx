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
import type {
  Approval, AutonomyMode, ChatArtifact, ChatCapabilities, ChatMessage, ChatRef, PermissionProfile,
} from '@jarvis/contracts';
import type { SpendSummary } from '@jarvis/contracts';
import {
  useCapabilityCatalog, useConversation, useConversations, useDeleteConversation, useHosts,
  useOpenWorkspace, useResolveApproval, useSendMessage, useSetAutonomy, useSpend,
} from '../api/queries.js';
import { useChatStream } from '../api/chat-stream.js';
import { terminalHref } from '../api/links.js';
import { navigate, useRoute } from '../router.js';
import { Empty, ErrorNote, Link, Loading, relativeTime } from '../ui/bits.jsx';
import {
  ACTION_ICON, Glyph, NAV_ICON, PERMISSION_ICON, PROVIDER_ICON, SOURCE_ICON, STATUS_ICON,
} from '../ui/icons.jsx';
import { EFFORT, PERMISSION, permissionName } from '../ui/labels.js';
import { useAskAssistant } from '../ui/ask-assistant.jsx';
import { ArtifactChip, InlineArtifact } from '../ui/artifact.jsx';
import { Composer } from '../ui/composer.jsx';
import { Markdown } from '../ui/markdown.jsx';
import { usePageMeta } from '../ui/page-meta.jsx';
import { DataRow } from '../ui/primitives.jsx';

const AUTONOMY_OPTIONS: Array<{ value: AutonomyMode; label: string; hint: string }> = [
  {
    value: 'manual',
    label: 'Manual',
    hint: 'Todo lo que tenga efectos te lo pregunta antes, incluido lanzar un trabajo en modo seguro.',
  },
  /*
   * Dice lo que el código hace, no lo que el contrato promete.
   *
   * La frase anterior prometía que en automático los permisos de escritura seguían pidiendo
   * tarjeta. No es cierto: `#createRun` del toolbox sólo convierte a aprobación cuando la
   * autonomía es `manual`, así que en automático un trabajo con perfil `auto` —que escribe— sale
   * sin preguntar. Lo que sí sigue pidiendo permiso siempre es tocar una máquina con una
   * capacidad del sistema y salir a la nube, que son decisiones aparte y no dependen de esto.
   *
   * Se corrige la frase y no el motor porque el motor es de otro y ya está en camino. Pero un
   * texto que promete una tarjeta que no va a aparecer es peor que no decir nada: es una
   * exposición a un clic de quien se lo crea. Cuando el core cumpla lo que promete el contrato,
   * esta frase vuelve a la anterior.
   */
  {
    value: 'auto',
    label: 'Automático',
    hint: 'Puede lanzar trabajo sin preguntar, incluido con permiso de escritura. Sigue pidiéndote '
      + 'permiso para tocar una máquina con una capacidad del sistema y para salir a la nube.',
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
        {/*
          * El permiso, con su nombre y su tono, no con la palabra de la base.
          *
          * Aquí ponía `auto` a secas, que no le dice nada a quien está a punto de autorizar: `auto`
          * significa «escribe ficheros en el destino, y lo que toque queda tocado», y esa frase ya
          * estaba escrita en `labels.ts` sin que nadie la enseñara. En la única superficie donde el
          * producto promete que entre lo que se lee y lo que se ejecuta no cabe un cambio, la
          * etiqueta tiene que decir lo que se va a poder hacer.
          *
          * El tono también sale de ahí: `safe` es verde, `auto` ámbar y `yolo` rojo. Antes los tres
          * salían en ámbar, así que el más peligroso se leía igual que el intermedio.
          */}
        {target.permissionProfile ? (
          <span
            className={`badge ${PERMISSION[target.permissionProfile as PermissionProfile]?.tone ?? 'warn'}`}
            title={PERMISSION[target.permissionProfile as PermissionProfile]?.help}
          >
            <Glyph icon={PERMISSION_ICON[target.permissionProfile as PermissionProfile] ?? ACTION_ICON.insecure} />
            {permissionName(target.permissionProfile)}
          </span>
        ) : null}
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
function MessageRefs({ message, conversationId, bodies }: {
  message: ChatMessage;
  conversationId: string | null;
  /** Los cuerpos de los `inline` que ya han llegado, por identificador. */
  bodies: Map<string, ChatArtifact>;
}): JSX.Element | null {
  const refs = message.refs;
  const terminals = refs.filter(
    (ref): ref is Extract<ChatRef, { kind: 'terminal' }> => ref.kind === 'terminal');

  /*
   * Los artifacts se reparten por **presentación**, no por tipo.
   *
   * Un `inline` es contenido: va como bloque debajo del texto, porque es parte de la respuesta.
   * Un `panel` o un `modal` es una puerta: va como pastilla junto a las demás acciones. Es la
   * misma distinción que separa la oferta de terminal de un enlace a un trabajo, y por eso se
   * pintan en los mismos dos sitios.
   */
  const artifacts = refs.filter(
    (ref): ref is Extract<ChatRef, { kind: 'artifact' }> => ref.kind === 'artifact');
  const inline = artifacts.filter((ref) => ref.presentation === 'inline');
  const opened = artifacts.filter((ref) => ref.presentation !== 'inline');
  /*
   * Las pastillas de acción: workspace, sesión y trabajo.
   *
   * Se enumeran los tipos en vez de excluir los que no van, y es a propósito. Antes esto era un
   * «todo lo que no sea terminal» con la sesión de comodín al final, y en cuanto el contrato ganó
   * la variante `artifact` esa rama empezó a recibir algo que no sabía pintar. Enumerando, el día
   * que aparezca un tipo nuevo el compilador señala aquí en vez de que la pantalla lo intente.
   */
  const compact = refs.filter(
    (ref): ref is Extract<ChatRef, { kind: 'workspace' | 'session' | 'run' }> =>
      ref.kind === 'workspace' || ref.kind === 'session' || ref.kind === 'run');

  /*
   * `runIds` es lo que citaban las filas de antes y sigue vivo, así que se pinta igual. Lo que ya
   * viene como referencia no se repite: el mismo trabajo dos veces en la misma burbuja se lee
   * como dos trabajos.
   */
  const cited = new Set(compact
    .filter((ref): ref is Extract<ChatRef, { kind: 'run' }> => ref.kind === 'run')
    .map((ref) => ref.runId));
  const legacyRuns = message.runIds.filter((runId) => !cited.has(runId));

  if (!compact.length && !terminals.length && !legacyRuns.length
    && !inline.length && !opened.length) return null;

  return (
    <div className="chat-refs">
      {compact.length || legacyRuns.length || opened.length ? (
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
          {conversationId ? opened.map((ref) => (
            <ArtifactChip key={`a:${ref.artifactId}`} conversationId={conversationId} target={ref} />
          )) : null}
        </div>
      ) : null}

      {conversationId ? inline.map((ref) => (
        <InlineArtifact
          key={`i:${ref.artifactId}`}
          conversationId={conversationId}
          target={ref}
          artifact={bodies.get(ref.artifactId)}
        />
      )) : null}
      {terminals.map((ref, index) => (
        <TerminalRef key={`t:${index}:${ref.sessionId}`} target={ref} />
      ))}
    </div>
  );
}

function MessageBubble({ message, conversationId, bodies }: {
  message: ChatMessage;
  conversationId: string | null;
  bodies: Map<string, ChatArtifact>;
}): JSX.Element {
  if (message.role === 'tool') return <ToolTrace message={message} />;

  if (message.role === 'event') {
    /*
     * Un evento también puede traer lo que el turno dejó pulsable.
     *
     * Es el caso de un turno que **no pudo cumplir su decisión**: el core guarda las referencias en
     * la fila de evento para que lo que ya se produjo no se pierda porque el final saliera mal. Un
     * asistente que preparó tres artifacts y acabó diciendo «no puedo lanzar eso» los tenía
     * guardados y no los enseñaba: la mitad del arreglo estaba hecha y esta mitad los tiraba.
     */
    return (
      <div className="chat-event-block">
        <div className="chat-event">
          <Glyph icon={STATUS_ICON.activity} size={14} />
          <span>{message.text}</span>
        </div>
        <MessageRefs message={message} conversationId={conversationId} bodies={bodies} />
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
      {/*
        * Formato sólo en lo que escribe el asistente.
        *
        * Lo que escribió la persona se pinta literal: nadie quiere que su propio mensaje cambie de
        * forma al enviarlo, y un `*` entre asteriscos en una pregunta es un asterisco.
        */}
      {message.role === 'assistant'
        ? <div className="chat-bubble-text"><Markdown source={message.text} /></div>
        : <div className="chat-bubble-text">{message.text}</div>}
      <MessageRefs message={message} conversationId={conversationId} bodies={bodies} />
    </div>
  );
}

/**
 * La autonomía, en un chip que se abre.
 *
 * Sigue estando a la vista y sigue cambiándose donde se está usando —que es lo que pedía el
 * diseño— pero deja de costar una fila entera. En un móvil el selector de tres segmentos ocupaba
 * el ancho completo de la cabecera para enseñar una decisión que se toma una vez y se mira de
 * reojo; el modo actual se lee igual en un chip, y el selector aparece cuando lo pides.
 */
function AutonomyChip({ value, onChange, pending }: {
  value: AutonomyMode;
  onChange: (next: AutonomyMode) => void;
  pending: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const current = AUTONOMY_OPTIONS.find((option) => option.value === value) ?? AUTONOMY_OPTIONS[0];
  return (
    <div className="autonomy">
      <button
        type="button"
        className={`badge ${value === 'manual' ? 'neutral' : 'warn'} autonomy-chip`}
        aria-expanded={open}
        aria-label={`Autonomía: ${current?.label}. Cambiar`}
        title={current?.hint}
        disabled={pending}
        onClick={() => setOpen(!open)}
      >
        <Glyph icon={value === 'manual' ? ACTION_ICON.secure : ACTION_ICON.insecure} />
        {current?.label}
        <Glyph icon={open ? ACTION_ICON.collapse : ACTION_ICON.expand} size={12} />
      </button>
      {open ? (
        <>
          <button type="button" className="autonomy-veil" aria-label="Cerrar"
            onClick={() => setOpen(false)} />
          <div className="autonomy-menu card" role="dialog" aria-label="Cuánta cuerda tiene">
            {AUTONOMY_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className="autonomy-option"
                aria-current={option.value === value}
                onClick={() => { onChange(option.value); setOpen(false); }}
              >
                <span className="row tight">
                  <Glyph icon={option.value === value ? ACTION_ICON.approve : ACTION_ICON.chevron} size={13} />
                  <strong className="small">{option.label}</strong>
                </span>
                <span className="tiny faint">{option.hint}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * Una línea que dice si esto va a funcionar, y con qué.
 *
 * Sustituye a la fila de distintivos, que ocupaba su propio renglón para decir tres cosas sueltas.
 * El punto mira **si responden las máquinas**, que es lo que decidió quien usa esto: sin máquinas
 * no hay nada que consultar por muy bien que esté el modelo.
 *
 * Lo que no hace es decir «online» a secas. Un punto verde que colapsa el modelo, las capacidades,
 * el índice y seis hosts en una palabra es un indicador que no se puede comprobar; aquí cada cosa
 * se cuenta con su número, y el que esté mal se lee.
 */
function StatusLine({ hosts, capabilities, thinking, effort }: {
  hosts: { reachable: boolean }[] | undefined;
  capabilities: ChatCapabilities | undefined;
  thinking: boolean;
  /** El nivel elegido para este turno, o nulo si no lo decide él. */
  effort: string | null;
}): JSX.Element | null {
  /*
   * Mientras piensa, la línea dice con cuánto esfuerzo.
   *
   * Ocupa el sitio de lo de siempre en vez de añadir un indicador nuevo: el modelo y las máquinas
   * no cambian mientras dura un turno, y lo que sí cambia —y sólo se puede ver ahora— es esto. La
   * pasada previa que elige el nivel no llama a ninguna herramienta y no escribe ningún mensaje,
   * así que si no se ve aquí no se ve en ningún sitio.
   *
   * Cuando acaba, la línea vuelve. Un indicador que se queda diciendo «a fondo» después de
   * contestar no informa de nada: informa de lo que pasó, y para eso está el hilo.
   */
  if (thinking) {
    const nivel = effort ? EFFORT[effort] : null;
    return (
      <span className={`chat-status ${nivel?.tone ?? 'neutral'}`} title={nivel?.help}>
        <span className="chat-status-dot pulsing" aria-hidden="true" />
        <span className="truncate">
          {nivel ? `pensando · ${nivel.name}` : 'pensando…'}
        </span>
      </span>
    );
  }

  if (!capabilities) return null;
  const responden = hosts?.filter((host) => host.reachable).length ?? null;
  const total = hosts?.length ?? 0;
  const model = capabilities.localAvailable ? capabilities.localModel
    : capabilities.cloudAvailable ? capabilities.cloudModel : null;

  const tono = !model ? 'danger'
    : responden !== null && total > 0 && responden < total ? 'warn' : 'ok';

  const partes: string[] = [];
  if (responden !== null && total > 0) {
    partes.push(responden === total
      ? `${total} máquina${total === 1 ? '' : 's'}`
      : `${responden} de ${total} máquinas`);
  }
  partes.push(model ? shortModel(model) : 'sin modelo');
  if (capabilities.capabilityCount) {
    partes.push(capabilities.capabilityMode === 'router'
      ? `${capabilityCount(capabilities)} · las busca`
      : `${capabilityCount(capabilities)}`);
  }

  return (
    <span className={`chat-status ${tono}`}>
      <span className="chat-status-dot" aria-hidden="true" />
      <span className="truncate">{partes.join(' · ')}</span>
    </span>
  );
}

/** Las capacidades, con el aviso pegado cuando quedan pocas. */
const capabilityCount = (capabilities: ChatCapabilities): string =>
  capabilities.capabilityMode !== 'router' && capabilities.capabilityRoom <= 3
    ? `${capabilities.capabilityCount} capacidades · quedan ${capabilities.capabilityRoom}`
    : `${capabilities.capabilityCount} capacidades`;

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
  /*
   * Si responden las máquinas, que es lo que dice el punto de la cabecera.
   *
   * Sin `probe`: es una lectura de base con cinco minutos de caché, no una conexión por host. El
   * sondeo de verdad cuesta una conexión por máquina y vive en la pantalla de Salud, que es donde
   * alguien va a mirar eso a propósito.
   */
  const hosts = useHosts();
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

  /*
   * Los cuerpos de los `inline`, de los dos sitios por los que pueden llegar: la carga inicial
   * —para entrar a una conversación ya escrita— y el stream —para el turno que estás esperando—.
   * Se funden por identificador, como los mensajes por `seq`, y por el mismo motivo: son la misma
   * cosa contada por dos canales y el que llegue segundo no puede borrar al primero.
   */
  const artifactBodies = new Map<string, ChatArtifact>();
  for (const artifact of detail.data?.artifacts ?? []) artifactBodies.set(artifact.id, artifact);
  for (const artifact of stream.artifacts) artifactBodies.set(artifact.id, artifact);

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

  function submit(): void {
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
              * El título del hilo y, debajo, si esto va a funcionar.
              *
              * Las dos cosas en la misma columna y no en dos filas: antes el título ocupaba un
              * renglón y los distintivos otro, y en un móvil eso son dos de las cinco líneas que
              * hay antes del primer mensaje.
              */}
            <span className="chat-head-id">
              <h2 className="truncate">
                {active ? (stream.title ?? conversation?.title ?? 'Conversación') : 'Asistente'}
              </h2>
              <StatusLine
                hosts={hosts.data?.hosts}
                capabilities={capabilities}
                thinking={thinking}
                effort={stream.effort}
              />
            </span>
          </div>

          <div className="chat-head-meta">
            {spend.data ? <SpendBadge spend={spend.data} /> : null}
          </div>

          {active ? (
            <div className="chat-head-actions">
              <AutonomyChip
                value={autonomy}
                pending={setAutonomy.isPending}
                onChange={(next) => setAutonomy.mutate(next)}
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

          {messages.map((message) => (
            <MessageBubble key={message.seq} message={message}
              conversationId={active} bodies={artifactBodies} />
          ))}

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

        <Composer
          className="chat-composer"
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          submitOnEnter
          placeholder={active ? 'Escribe…' : '¿Cómo va el servidor?'}
          label="Mensaje para el asistente"
          submitLabel="Enviar"
          submitting={send.isPending || ask.pending}
          {...{ rows: 1 }}
        />
      </section>
    </div>
  );
}
