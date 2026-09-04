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
import type { Approval, AutonomyMode, ChatMessage } from '@jarvis/contracts';
import {
  useCapabilityCatalog, useConversation, useConversations, useCreateConversation,
  useDeleteConversation, useResolveApproval, useSendMessage, useSetAutonomy,
} from '../api/queries.js';
import { useChatStream } from '../api/chat-stream.js';
import { useRoute } from '../router.js';
import { Empty, ErrorNote, Loading, relativeTime } from '../ui/bits.jsx';
import { ACTION_ICON, Glyph, NAV_ICON, SOURCE_ICON, STATUS_ICON } from '../ui/icons.jsx';
import { usePageMeta } from '../ui/page-meta.jsx';
import { Segmented } from '../ui/primitives.jsx';

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

/**
 * De dónde salió esto.
 *
 * Va en la burbuja y no en una leyenda porque la pregunta —«¿esto lo ha contestado el de casa o
 * ha costado dinero?»— se hace sobre una respuesta concreta, no sobre la conversación entera.
 */
function SourceBadge({ source, model }: { source: string | null; model: string | null }): JSX.Element | null {
  if (!source) return null;
  const cloud = source === 'cloud';
  return (
    <span
      className={`badge ${cloud ? 'warn' : 'ok'} tiny`}
      title={model ? `${cloud ? 'Consultado fuera' : 'Pensado en casa'} con ${model}` : undefined}
    >
      <Glyph icon={cloud ? SOURCE_ICON.cloud : SOURCE_ICON.local} />
      {cloud ? 'nube' : 'casa'}
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
      {message.runIds.length ? (
        <div className="row tight" style={{ marginTop: 6 }}>
          {message.runIds.map((runId) => (
            <a key={runId} className="btn small" href={`/runs/${runId}`}>
              <Glyph icon={NAV_ICON.runs} />
              Ver el trabajo
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function AssistantScreen(): JSX.Element {
  usePageMeta({ title: 'Asistente', subtitle: 'El modelo de casa, con las máquinas delante' });
  const route = useRoute();
  const active = route.segments[1] ?? null;

  const list = useConversations();
  const detail = useConversation(active);
  const catalog = useCapabilityCatalog();
  const stream = useChatStream(active);
  const create = useCreateConversation();
  const send = useSendMessage(active);
  const setAutonomy = useSetAutonomy(active);
  const remove = useDeleteConversation();
  const resolve = useResolveApproval();

  const [draft, setDraft] = useState('');
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

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    if (active) {
      send.mutate(text);
      return;
    }
    // Sin conversación abierta, el primer mensaje crea una y navega a ella.
    create.mutate({ message: text }, {
      onSuccess: ({ conversation: created }) => route.navigate(`/assistant/${created.id}`),
    });
  }

  const thinking = status === 'thinking';
  const noModel = capabilities && !capabilities.localAvailable && !capabilities.cloudAvailable;

  return (
    <div className="page assistant-page">
      <aside className="chat-rail">
        <div className="row between" style={{ marginBottom: 8 }}>
          <strong className="small">Conversaciones</strong>
          <button
            type="button"
            className="btn small"
            onClick={() => route.navigate('/assistant')}
            disabled={!active}
          >
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
                  route.navigate(`/assistant/${item.id}`);
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
              No hay ningún modelo configurado en el core. Con <code>JARVIS_LOCAL_MODEL_BASE_URL</code> el
              asistente piensa en casa; con <code>JARVIS_MODEL_API_KEY</code>, en la nube.
            </span>
          </p>
        ) : null}

        <header className="chat-head">
          <div>
            <h2>{stream.title ?? conversation?.title ?? 'Asistente'}</h2>
            <div className="row tight small">
              {capabilities?.localAvailable ? (
                <span className="badge ok tiny" title={capabilities.localModel ?? undefined}>
                  <Glyph icon={SOURCE_ICON.local} />
                  {capabilities.localModel?.split('/').pop() ?? 'local'}
                </span>
              ) : null}
              {capabilities?.cloudAvailable ? (
                <span className="badge neutral tiny" title={`Escalada disponible: ${capabilities.cloudModel}`}>
                  <Glyph icon={SOURCE_ICON.cloud} />
                  {capabilities.cloudModel}
                </span>
              ) : null}
              {capabilities?.capabilityCount ? (
                <span className="badge neutral tiny">
                  <Glyph icon={ACTION_ICON.capability} />
                  {capabilities.capabilityCount} capacidades
                </span>
              ) : null}
            </div>
          </div>

          {active ? (
            <div className="row tight">
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
                onClick={() => {
                  remove.mutate(active, { onSuccess: () => route.navigate('/assistant') });
                }}
              >
                <Glyph icon={ACTION_ICON.delete} />
                Borrar
              </button>
            </div>
          ) : null}
        </header>

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
          <button type="submit" className="btn primary" disabled={!draft.trim() || send.isPending || create.isPending}>
            <Glyph icon={ACTION_ICON.send} />
            Enviar
          </button>
        </form>
      </section>
    </div>
  );
}
