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
  AutonomyMode, ChatArtifact, ChatCapabilities, ChatMessage, ChatRef,
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
  ACTION_ICON, Glyph, NAV_ICON, PROVIDER_ICON, SOURCE_ICON, STATUS_ICON,
} from '../ui/icons.jsx';
import { AUTONOMY, autonomyName, EFFORT } from '../ui/labels.js';
import { useAskAssistant } from '../ui/ask-assistant.jsx';
import { ArtifactChip, InlineArtifact } from '../ui/artifact.jsx';
import { ApprovalCard } from '../ui/approval-card.jsx';
import { Boundary } from '../ui/boundary.jsx';
import { Composer } from '../ui/composer.jsx';
import { Markdown } from '../ui/markdown.jsx';
import { usePageMeta } from '../ui/page-meta.jsx';
import { ConfirmDialog, DataRow } from '../ui/primitives.jsx';


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
 * Lo que llevamos gastado.
 *
 * Dice «gastado», nunca «te queda en la cuenta», y la diferencia no es de estilo: **el proveedor
 * no da el saldo** —una clave de proyecto recibe un 403 al pedirlo— así que esto son los tokens
 * que este core ha visto pasar, con la tarifa que tiene puesta. Presentarlo como saldo sería
 * inventarse un dato que alguien va a mirar justo antes de que la clave deje de funcionar.
 *
 * El resto se cuenta en **vueltas al modelo**, no en preguntas, y la palabra importa: una pregunta
 * puede costar una vuelta o doce según lo que haya que mirar, así que llamarlas «consultas» invitaba
 * a dividir mal y a creerse con más margen del que hay. Sólo aparece si se declaró cuánto se cargó,
 * y se calcula con la media de las vueltas de verdad; sin presupuesto declarado se enseña lo
 * gastado, que es lo que se sabe.
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
          ? `~${spend.remainingTurns.toLocaleString('es-ES')} vueltas`
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
        className="btn small ref-chip"
        disabled={open.isPending}
        title={`${target.title ?? target.sessionId} — ${target.provider} · ${target.host}`}
        onClick={() => open.mutate(
          {
            ref: { host: target.host, provider: target.provider, sessionId: target.sessionId },
            title: target.title,
          },
          { onSuccess: (result) => navigate(`/w/${result.workspace.id}`) },
        )}
      >
        <Glyph icon={PROVIDER_ICON[target.provider] ?? ACTION_ICON.session} />
        <span className="ref-label">
          {open.isPending ? 'Abriendo…' : (target.title ?? target.sessionId)}
        </span>
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
          {/*
            * Sin `cwd` la terminal abre en el home, y eso hay que decirlo antes de pulsar.
            *
            * Pasa cuando la sesión no tiene workspace: el core no puede resolver la carpeta y el
            * botón sigue siendo útil —máquina y sesión correctas— pero no aterriza donde está el
            * trabajo. Enseñar el `sessionId` en su hueco daba a entender que sí.
            */}
          {target.cwd ? (
            <span className="tiny faint mono ref-label" title={target.cwd}>{target.cwd}</span>
          ) : (
            <span className="tiny warn ref-label"
              title="Esta sesión no tiene workspace abierto, así que no se sabe en qué carpeta estaba.">
              sin directorio conocido: abre en el home
            </span>
          )}
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
                  className="btn small ref-chip"
                  title={ref.title ? `${ref.title} — abrir el workspace` : 'Abrir el workspace de esta sesión'}>
                  <Glyph icon={ACTION_ICON.open} />
                  <span className="ref-label">{ref.title ?? 'Abrir workspace'}</span>
                </Link>
              );
            }
            if (ref.kind === 'run') {
              return (
                <Link key={`r:${index}:${ref.runId}`} to={`/runs/${ref.runId}`}
                  className="btn small ref-chip"
                  title={ref.title ? `${ref.title} — ver el trabajo` : 'Ver el trabajo y lo que dejó'}>
                  <Glyph icon={NAV_ICON.runs} />
                  <span className="ref-label">{ref.title ?? 'Ver el trabajo'}</span>
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
function AutonomyChip({ value, modes, onChange, pending }: {
  value: AutonomyMode;
  /**
   * Los modos que este servidor ofrece de verdad.
   *
   * Vienen del core y no de una lista escrita aquí: `unrestricted` sólo existe si el operador lo
   * encendió, y una pantalla que lo ofrece cuando el servidor lo va a rechazar promete una cuerda
   * que no hay.
   */
  modes: readonly AutonomyMode[];
  onChange: (next: AutonomyMode) => void;
  pending: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement | null>(null);
  const actual = AUTONOMY[value];
  /*
   * El modo de la conversación puede no estar en la lista.
   *
   * Pasa si se apagó el flag con un hilo ya en `unrestricted`. Antes eso se pintaba «Manual» —el
   * `find` caía al primero— y decía justo lo contrario de lo que estaba pasando. Ahora se enseña lo
   * que hay, con el aviso de que el servidor ya no lo ofrece.
   */
  const degradado = !modes.includes(value);

  // El menú toma el foco al abrirse y se cierra con Escape, como cualquier otro diálogo de la casa.
  useEffect(() => {
    if (!open) return undefined;
    menu.current?.querySelector<HTMLButtonElement>('.autonomy-option')?.focus();
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="autonomy">
      <button
        type="button"
        className={`badge ${degradado ? 'danger' : actual?.tone ?? 'neutral'} autonomy-chip`}
        aria-expanded={open}
        aria-label={`Autonomía: ${autonomyName(value)}. Cambiar`}
        title={degradado
          ? `${autonomyName(value)}: este servidor ya no ofrece este modo. Elige otro.`
          : actual?.help}
        disabled={pending}
        onClick={() => setOpen(!open)}
      >
        <Glyph icon={value === 'manual' ? ACTION_ICON.secure : ACTION_ICON.insecure} />
        {autonomyName(value)}
        <Glyph icon={open ? ACTION_ICON.collapse : ACTION_ICON.expand} size={12} />
      </button>
      {open ? (
        <>
          <button type="button" className="autonomy-veil" aria-label="Cerrar"
            onClick={() => setOpen(false)} />
          <div className="autonomy-menu card" role="dialog" aria-label="Cuánta cuerda tiene" ref={menu}>
            {degradado ? (
              <p className="tiny warn" style={{ margin: '2px 6px 4px' }}>
                Esta conversación está en «{autonomyName(value)}» y el servidor ya no ofrece ese modo.
              </p>
            ) : null}
            {modes.map((mode) => {
              const label = AUTONOMY[mode];
              return (
                <button
                  key={mode}
                  type="button"
                  className="autonomy-option"
                  aria-current={mode === value}
                  onClick={() => { onChange(mode); setOpen(false); }}
                >
                  <span className="row tight">
                    <Glyph icon={mode === value ? ACTION_ICON.approve : ACTION_ICON.chevron} size={13} />
                    <strong className={`small ${label?.tone === 'danger' ? 'danger' : ''}`}>
                      {label?.name ?? mode}
                    </strong>
                  </span>
                  <span className="tiny faint">{label?.help}</span>
                </button>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * Si queda una pregunta esperando respuesta: no hay nada del asistente después de lo último tuyo.
 *
 * Es la misma definición que calcula el core en `pendingAnswer`, escrita aquí porque **dentro del
 * hilo el campo llega viejo**. La conversación se pide una vez al abrirla y el stream sólo la
 * invalida cuando llega una aprobación, así que la respuesta que acabas de ver aparecer no
 * refresca ese booleano: la línea diría «se quedó sin contestar» debajo de una respuesta recién
 * escrita. Los mensajes, en cambio, están aquí y al día.
 *
 * En la lista es al revés —no hay mensajes— y ahí manda el campo del core. Misma definición en los
 * dos sitios, cada uno calculado con lo más fresco que tiene delante.
 */
export const pendienteDeRespuesta = (messages: { role: string }[]): boolean => {
  const ultimaTuya = messages.map((m) => m.role).lastIndexOf('user');
  if (ultimaTuya === -1) return false;
  return !messages.slice(ultimaTuya + 1).some((m) => m.role === 'assistant');
};

/**
 * Si esta conversación es una pregunta que nadie contestó.
 *
 * En reposo y con una pregunta pendiente. `waiting_approval` y `thinking` se caen solos por el
 * primer término, que es lo que los distingue de esto: uno espera algo tuyo y el otro está
 * trabajando.
 *
 * El «pendiente» no se mira por el rol del último mensaje, y no por descuido: un `event` del hilo
 * puede ser «no pude contestar y me quedé sin intentos» —que sí es esto— o «Plan corregido: …»,
 * que es un turno que acabó bien. Diecisiete sitios escriben `event` y dicen cosas opuestas, así
 * que ese rol no decide nada. Lo que decide es si hay respuesta después de la pregunta.
 *
 * Va aparte y con nombre para poder probarla: dentro del componente sólo se podría comprobar
 * montando la pantalla entera contra una API, y lo que hay que sujetar aquí es la regla, no el
 * pintado.
 */
export const sinContestar = (status: string, pendiente: boolean): boolean =>
  status === 'idle' && pendiente;

/**
 * Lo que ocupa el catálogo, dicho para quien mira.
 *
 * Bytes porque los bytes se miden; los tokens van detrás, redondeados y con su «unos» delante,
 * porque cuatro caracteres por token es una regla del pulgar y una regla no es una medida. La cifra
 * en tokens está porque es la que se compara con lo que cuesta el turno, que es la decisión real.
 */
const catalogWeight = (bytes: number): string => {
  // Con separador de millares: «7400» se lee dos veces y «7.400» una.
  const tokens = (Math.round(bytes / 4 / 100) * 100).toLocaleString('es-ES');
  return `${Math.round(bytes / 1024)} KB, unos ${tokens} tokens`;
};

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
function StatusLine({
  hosts, capabilities, thinking, effort, failed, lost, unanswered, onRetry, onAskAgain,
}: {
  hosts: { reachable: boolean }[] | undefined;
  capabilities: ChatCapabilities | undefined;
  thinking: boolean;
  /** El nivel elegido para este turno, o nulo si no lo decide él. */
  effort: string | null;
  /** El turno se cayó. Antes esto no se distinguía de «en reposo». */
  failed: boolean;
  /** Nadie contestó y la conversación no lo dice: lo último del hilo es tuyo. */
  unanswered: boolean;
  /** Devolver la última pregunta al compositor, sin mandarla. */
  onAskAgain: () => void;
  /** Volver a abrir el stream cuando se dio por vencido. */
  onRetry: () => void;
  /** El stream se dio por vencido: no va a volver solo. */
  lost: boolean;
}): JSX.Element | null {
  /*
   * Un turno que se cayó no puede leerse como uno terminado.
   *
   * La línea sólo sabía distinguir «pensando» de «en reposo», así que un fallo dejaba la pantalla
   * exactamente igual que un éxito y la persona esperaba una respuesta que no iba a llegar.
   */
  if (failed) {
    return (
      <span className="chat-status danger">
        <span className="chat-status-dot" aria-hidden="true" />
        <span className="truncate">el turno falló</span>
      </span>
    );
  }

  /*
   * Nadie contestó, y hasta ahora eso se veía igual que una conversación terminada.
   *
   * Va después de `failed` y antes de todo lo demás porque es más raro y más grave: `failed` al
   * menos lo dice. La salida no manda nada sola —devuelve tu pregunta al compositor y la mandas
   * tú—: reenviar por tu cuenta una pregunta que ya gastó un turno del modelo es una decisión de
   * quien paga, no de la pantalla.
   */
  if (unanswered) {
    return (
      <span className="chat-status warn">
        <span className="chat-status-dot" aria-hidden="true" />
        <span className="truncate">se quedó sin contestar</span>
        <button type="button" className="btn small chat-status-retry" onClick={onAskAgain}>
          Volver a preguntar
        </button>
      </span>
    );
  }

  /*
   * Y perder el stream tampoco: sin esto, el hilo se queda callado y parece que nadie contesta.
   * Sólo cuando se ha dado por vencido —una reconexión de un segundo no es noticia—.
   */
  if (lost) {
    return (
      <span className="chat-status warn">
        <span className="chat-status-dot" aria-hidden="true" />
        <span className="truncate">sin conexión con el hilo</span>
        {/*
          * Y con qué volver.
          *
          * Decirlo sin ofrecer la vuelta dejaba un callejón: el stream ya está cerrado, así que la
          * única salida era recargar la página —y quien lee esto no tiene por qué saberlo—. Pasa
          * dejando la pestaña abierta mientras el portátil se duerme.
          */}
        <button type="button" className="btn small chat-status-retry" onClick={onRetry}>
          Reconectar
        </button>
      </span>
    );
  }

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

  /*
   * La línea va por trozos y no como una cadena, porque en un teléfono no cabe entera.
   *
   * Escrita de una pieza con `truncate`, lo que se perdía era **el final**, y el final es justo lo
   * único accionable: «quedan 2» avisa de cuánto margen hay antes de que el catálogo no quepa y el
   * modo directo se apague en silencio. Cortar por donde toca el texto es cortar por donde no toca
   * la información.
   *
   * Así que el aviso no encoge nunca, y lo que se sacrifica en estrecho es lo que se puede leer en
   * otro sitio: el número de capacidades, y luego el modelo —que además va en cada burbuja del
   * hilo, con su distintivo—.
   */
  const maquinas = responden !== null && total > 0
    ? (responden === total ? `${total} máquina${total === 1 ? '' : 's'}` : `${responden} de ${total} máquinas`)
    : null;
  const aviso = capabilities.capabilityMode === 'router' ? 'las busca'
    : capabilities.capabilityCount && capabilities.capabilityRoom <= 3
      ? `quedan ${capabilities.capabilityRoom}` : null;

  return (
    <span className={`chat-status ${tono}`}>
      <span className="chat-status-dot" aria-hidden="true" />
      {maquinas ? <span className="chat-status-part truncate">{maquinas}</span> : null}
      <span className="chat-status-part chat-status-model truncate">
        {model ? shortModel(model) : 'sin modelo'}
      </span>
      {capabilities.capabilityCount ? (
        /*
         * Cuántas hay, y al pasar por encima, cuánto pesan.
         *
         * El aviso de al lado cuenta funciones, que es lo que decide el repliegue al router porque
         * el tope de la API es de cuenta. Pero desde que cada definición lleva su esquema y su
         * descripción larga, lo que se paga en cada vuelta es otra cosa, y ninguna de las dos
         * cifras lo decía. Va en la ayuda y no en la línea porque es un dato para quien está
         * decidiendo si enchufar una capacidad más, no para quien está leyendo una respuesta —y
         * porque la línea ya no cabe entera en un teléfono—.
         */
        <span
          className="chat-status-part chat-status-count truncate"
          title={`El catálogo entero viaja en cada vuelta: ${catalogWeight(capabilities.catalogBytes)}.`}
        >
          {capabilities.capabilityCount} capacidades
        </span>
      ) : null}
      {aviso ? <strong className="chat-status-warn">{aviso}</strong> : null}
    </span>
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
  /*
   * Borrar una conversación no se deshace.
   *
   * Era el único sitio de la consola donde una acción irreversible salía de un clic sin preguntar,
   * y encima el botón está pegado al de cambiar la autonomía. El resto de la casa usa esta misma
   * tarjeta para lo que no se puede recuperar.
   */
  const [confirmDelete, setConfirmDelete] = useState(false);
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
  /*
   * Una pregunta que se quedó sin contestar, y que en pantalla no se distingue de una contestada.
   *
   * El turno se encola como trabajo y puede agotar sus intentos **sin** que la conversación pase a
   * `failed`: medido en producción, la salud avisaba de dos turnos perdidos mientras la única
   * conversación marcada como fallida era de tres días antes. O sea que el único sitio donde eso
   * se veía era un `/api/health` que no mira nadie, y aquí el hilo se quedaba en reposo con la
   * última palabra siendo tuya, exactamente igual que una conversación terminada.
   *
   * Se deduce del hilo en vez de esperar un campo nuevo: si está en reposo y lo último no lo dijo
   * el asistente, nadie contestó. `waiting_approval` y `thinking` quedan fuera solos, que es lo que
   * los distingue de esto.
   */
  const unanswered = sinContestar(status, pendienteDeRespuesta(messages));
  const autonomy = (stream.autonomy ?? conversation?.autonomy ?? 'manual') as AutonomyMode;
  const approvals = detail.data?.approvals ?? [];
  const capabilities = list.data?.capabilities;

  /*
   * Al llegar algo nuevo, abajo — **salvo que estés leyendo arriba**.
   *
   * Bajaba siempre, así que releer una respuesta anterior mientras el asistente sigue trabajando
   * era imposible: cada consulta te devolvía al final. Ahora sólo arrastra si ya estabas al final,
   * que es cuando bajar es lo que quieres; si no, aparece un aviso de cuántos han llegado y bajas
   * tú. El umbral es generoso a propósito: a 120 px del fondo se sigue considerando «estabas
   * abajo», porque nadie afina el scroll al píxel.
   */
  const [pendientes, setPendientes] = useState(0);
  const vistos = useRef(0);
  useEffect(() => {
    const caja = document.querySelector('.chat-messages');
    const abajo = !caja || caja.scrollHeight - caja.scrollTop - caja.clientHeight < 120;
    if (abajo) {
      bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
      setPendientes(0);
    } else if (messages.length > vistos.current) {
      setPendientes((previo) => previo + (messages.length - vistos.current));
    }
    vistos.current = messages.length;
  }, [messages.length, status]);

  const irAlFinal = (): void => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    setPendientes(0);
  };

  // Cada turno gasta, así que el contador se refresca al terminar uno y no cada pocos segundos.
  useEffect(() => {
    if (status === 'idle') void spend.refetch();
  }, [status, messages.length]);

  /** Elegir una conversación cierra la hoja: seguir viéndola tapando el hilo no ayuda a nadie. */
  function open(id: string | null): void {
    setListOpen(false);
    route.navigate(id ? `/assistant/${id}` : '/assistant');
  }

  /*
   * Lo escrito no se borra hasta que el servidor lo tiene.
   *
   * Se limpiaba antes de que la mutación resolviera, así que un 500, un 409 o un tiempo agotado se
   * llevaban el texto sin decir nada: la pantalla quedaba muda y lo escrito, perdido. Ahora se
   * limpia al confirmar y el error se pinta, que es lo único que permite volver a intentarlo.
   */
  function submit(): void {
    const text = draft.trim();
    if (!text) return;
    if (active) {
      send.mutate(text, { onSuccess: () => setDraft('') });
      return;
    }
    // Sin conversación abierta, el primer mensaje crea una y navega a ella. Por el mismo camino
    // que los accesos del resto de pantallas, y por eso hereda el workspace del que se viene.
    ask.ask({ prompt: text, workspaceId: fromWorkspace, onSent: () => setDraft('') });
  }

  /** Volver a mandar lo último que dijo la persona, para cuando el turno se cayó. */
  const lastUserText = [...messages].reverse().find((message) => message.role === 'user')?.text ?? null;

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

      <ConfirmDialog
        open={confirmDelete && Boolean(active)}
        title="Borrar esta conversación"
        description={
          <>
            Se borra <strong>{stream.title ?? conversation?.title ?? 'la conversación'}</strong> con
            todo su hilo, sus trazas y lo que enseñó. No se puede deshacer.
          </>
        }
        confirmLabel="Borrar"
        pending={remove.isPending}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutate(active as string, {
          onSuccess: () => { setConfirmDelete(false); open(null); },
        })}
      />

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
                  {/*
                    * Y la que se quedó sin contestar, que es la que hay que ver **sin entrar**.
                    *
                    * Dentro del hilo lo dice la línea de estado, pero quien no abre esa
                    * conversación no se entera nunca: en la lista se veía igual que una terminada.
                    * Se usa el rol del último mensaje —un hecho— en vez de un booleano calculado
                    * en el servidor, y con la misma regla que dentro para que las dos pantallas no
                    * puedan contradecirse.
                    */}
                  {sinContestar(item.status, item.pendingAnswer)
                    ? <span className="chat-rail-mudo"> · sin contestar</span> : ''}
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
            {/*
              * El servidor, con lo que de verdad sirve y lo que se está quedando fuera.
              *
              * Antes decía sólo el nombre y el número, y en verde siempre — el catálogo no traía
              * otro estado. Ahora sí, y hay dos cosas que enseñar que antes no existían:
              *
              *  · **`stale` no es `danger`.** Un catálogo viejo se sigue sirviendo y se puede
              *    trabajar; caído es que no hay nada. Pintarlos igual haría que el rojo dejara de
              *    significar algo.
              *  · **Las que no se sirven se dicen.** Una herramienta que el servidor no etiquetó no
              *    se ofrece —no se puede saber si escribe— y hasta ahora eso pasaba en silencio: la
              *    capacidad existía, el asistente contestaba «no existe» y nadie podía enterarse
              *    salvo leyendo el código. Se cuenta aparte de las denegadas porque la respuesta es
              *    distinta: a las denegadas no hay nada que hacerles; a éstas, etiquetarlas.
              */}
            {catalog.data.servers.map((server) => {
              const tono = server.status === 'ok' ? 'ok' : server.status === 'stale' ? 'warn' : 'danger';
              const fuera = server.untagged + server.filteredOut;
              return (
                <span
                  key={server.name}
                  className={`badge tiny ${tono}`}
                  title={[
                    server.status === 'stale' ? 'El catálogo es viejo: se sigue sirviendo, pero el servidor no contesta ahora.'
                      : server.status === 'ok' ? null : (server.lastError ?? 'No responde.'),
                    server.untagged ? `${server.untagged} sin etiquetar: no dicen si escriben, así que no se ofrecen.` : null,
                    server.filteredOut ? `${server.filteredOut} fuera por la lista de permitidas.` : null,
                  ].filter(Boolean).join(' ')}
                >
                  {server.name} · {server.toolCount}
                  {fuera ? <span className="faint"> · {fuera} fuera</span> : null}
                </span>
              );
            })}
            {/*
              * Lo que cuesta tener esto puesto.
              *
              * El catálogo entero viaja en **cada vuelta**, así que no es un coste de arranque: es
              * un peaje por mensaje que crece cada vez que se enchufa un servidor. Se dice aquí,
              * debajo de lo que se puede enchufar, porque es donde se toma esa decisión; en la
              * línea de estado no cabría y en la factura aparece ya mezclado con todo lo demás.
              */}
            {capabilities?.catalogBytes ? (
              <span className="tiny faint chat-capabilities-cost">
                {catalogWeight(capabilities.catalogBytes)} en cada vuelta
              </span>
            ) : null}
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
              {/*
                * El título recorta a una línea a propósito: es el resumen automático del hilo y
                * puede tener sesenta caracteres, que empujarían el resto de la cabecera fuera de
                * la fila. Va con `title` para que se pueda leer entero sin abrir la lista, donde
                * también está completo.
                */}
              <h2 title={active
                ? (stream.title ?? conversation?.title ?? 'Conversación') : undefined}>
                {active ? (stream.title ?? conversation?.title ?? 'Conversación') : 'Asistente'}
              </h2>
              <StatusLine
                hosts={hosts.data?.hosts}
                capabilities={capabilities}
                thinking={thinking}
                effort={stream.effort}
                failed={status === 'failed'}
                unanswered={unanswered}
                onAskAgain={() => {
                  const pregunta = [...messages].reverse().find((m) => m.role === 'user');
                  if (pregunta?.text) setDraft(pregunta.text);
                }}
                lost={stream.lost}
                onRetry={stream.retry}
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
                modes={capabilities?.autonomyModes ?? ['manual', 'auto']}
                pending={setAutonomy.isPending}
                onChange={(next) => setAutonomy.mutate(next)}
              />
              <button
                type="button"
                className="btn small danger"
                aria-label="Borrar la conversación"
                onClick={() => setConfirmDelete(true)}
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

          {/*
            * Cada burbuja con su anillo: lo que no se pueda pintar cae sola.
            *
            * Sin esto, un mensaje malformado en medio del hilo se lleva por delante todos los de
            * arriba y el compositor, y quien mira ve una pantalla en blanco sin saber qué pasó.
            */}
          {messages.map((message) => (
            <Boundary key={message.seq} what={`un mensaje (${message.role})`}>
              <MessageBubble message={message} conversationId={active} bodies={artifactBodies} />
            </Boundary>
          ))}

          {/*
            * La tarjeta se ancla arriba mientras espera tu firma.
            *
            * Iba al final del hilo, lejos del mensaje que la pidió, y en un móvil se perdía en
            * cuanto llegaba una consulta más. Lo que espera una firma no puede depender de que
            * alguien se desplace hasta encontrarlo: es lo único de esta pantalla que **hay que**
            * leer, y por eso se queda pegada bajo la cabecera hasta que se resuelve.
            */}
          {approvals.map((approval) => (
            <ApprovalCard
              className="chat-approval-sticky"
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

          {/*
            * Un turno caído deja una salida, no un callejón.
            *
            * Antes el hilo se quedaba mudo: la pregunta escrita, ninguna respuesta y nada que
            * pulsar. Reenviar lo último que dijiste es lo que se puede ofrecer sin tocar el core
            * —no rehace el turno, manda otra vez la misma pregunta— y es exactamente lo que hacía
            * la gente a mano, volviendo a escribirla.
            */}
          {status === 'failed' && lastUserText && active ? (
            <div className="note danger">
              <Glyph icon={ACTION_ICON.error} size={16} />
              <span>
                <span className="small">El turno se cayó sin llegar a contestar.</span>
                <span className="row tight" style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn small"
                    disabled={send.isPending}
                    onClick={() => send.mutate(lastUserText)}
                  >
                    <Glyph icon={ACTION_ICON.retry} />
                    {send.isPending ? 'Enviando…' : 'Volver a intentar'}
                  </button>
                </span>
              </span>
            </div>
          ) : null}

          {thinking ? (
            <div className="chat-thinking">
              <Glyph icon={STATUS_ICON.activity} size={14} className="spin" />
              <span className="small faint">pensando…</span>
            </div>
          ) : null}

          <div ref={bottom} />
        </div>

        {/* Lo que ha llegado mientras leías arriba, sin moverte de donde estabas. */}
        {pendientes > 0 ? (
          <button type="button" className="chat-nuevos" onClick={irAlFinal}>
            <Glyph icon={ACTION_ICON.scrollEnd} size={14} />
            {pendientes === 1 ? '1 mensaje nuevo' : `${pendientes} mensajes nuevos`}
          </button>
        ) : null}

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
