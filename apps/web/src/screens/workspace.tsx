/**
 * Una sesión: su conversación y la caja para seguirla.
 *
 * La pantalla es un hilo, de arriba abajo, y nada más. Cada turno —lo que pediste y lo que hizo el
 * agente hasta contestar— es una tarjeta plegada que se lee en dos líneas: lo que pediste y lo
 * último que contestó. Al pulsarla se despliega el turno entero, con el proceso del agente en sus
 * propias tarjetas compactas que a su vez se despliegan. El último turno ya viene abierto.
 *
 * Tres reglas que siguen igual que antes del rediseño:
 *   · el destino y el permiso se ven antes de pulsar Enviar;
 *   · el borrador no se pierde por navegar, fallar ni recargar, y sólo se borra cuando el
 *     servidor confirma que el trabajo existe;
 *   · lo que escribió el agente en la máquina y lo que lanzó Jarvis se funden en un hilo, pero el
 *     turno de un trabajo de Jarvis lo dice y trae su proceso.
 *
 * Lo que antes eran pestañas —contexto, ajustes, resumen, lista de trabajos— vive ahora en
 * «Detalles», plegado: se consulta de vez en cuando y no tiene por qué ocupar la pantalla siempre.
 */
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, PermissionProfile, Run, TranscriptMessage, Workspace } from '@jarvis/contracts';
import {
  useCancelRun, useCreateRun, useRenameWorkspace, useSaveDraft, useTarget, useTranscript,
  useUploadAttachment, useUsage, useWorkspace,
} from '../api/queries.js';
import { useRunStream } from '../api/run-stream.js';
import { terminalHref } from '../api/links.js';
import { CopyButton, Empty, ErrorNote, Link, Loading, RunStatusBadge, TargetChip, relativeTime } from '../ui/bits.jsx';
import { useAnnounceOnChange } from '../ui/announce.jsx';
import { Boundary } from '../ui/boundary.jsx';
import { Composer } from '../ui/composer.jsx';
import { PERMISSION, RUN_STATUS, isRunLive } from '../ui/labels.js';
import {
  ACTION_ICON, Glyph, NAV_ICON, PERMISSION_ICON, PROVIDER_ICON, RUN_STATUS_ICON, STATUS_ICON,
} from '../ui/icons.jsx';
import { EventTimeline } from '../ui/event-log.jsx';
import { Markdown } from '../ui/markdown.jsx';
import { openNewSession } from '../ui/new-session.jsx';
import { usePageMeta } from '../ui/page-meta.jsx';
import { UsageBadge } from '../ui/usage.jsx';
import { DataRow, Segmented, formatDuration, type SegmentOption } from '../ui/primitives.jsx';
import { buildTurns, fullAnswer, oneLine, type Turn } from '../ui/turns.js';
import { folderName } from './explorer.jsx';

const PROFILES: Array<SegmentOption<PermissionProfile>> = (['safe', 'auto', 'yolo'] as const).map((value) => ({
  value,
  label: PERMISSION[value].name,
  icon: PERMISSION_ICON[value],
  tone: PERMISSION[value].tone,
  hint: PERMISSION[value].help,
}));

/** Cuántos turnos plegados se enseñan antes de pedir «ver anteriores». */
const VISIBLE_TURNS = 6;

/** Espejo local del borrador: cubre los segundos entre teclear y que el servidor confirme. */
const draftMirrorKey = (workspaceId: string): string => `jarvis.draft.${workspaceId}`;

const ATTACHMENT_STATE: Record<string, string> = {
  staged: 'sin usar todavía',
  claimed: 'usado por un trabajo',
  released: 'borrado de la máquina',
  release_pending: 'pendiente de borrar',
  expired: 'caducado',
  failed: 'falló al subir',
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
};

const durationOf = (run: Run | undefined): number | null =>
  run?.startedAt && run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null;

export function WorkspaceScreen({ workspaceId }: { workspaceId: string }): JSX.Element {
  const detail = useWorkspace(workspaceId);
  const workspace = detail.data?.workspace;
  const transcript = useTranscript(workspace);

  /*
   * Arriba, dónde está: «Sesiones › app», y la miga lleva al grupo abierto. El nombre de la sesión
   * va en la página, donde se puede cambiar; repetirlo en la cabecera era leerlo dos veces.
   */
  const folder = workspace ? folderName(workspace.cwd) : null;
  usePageMeta({
    title: folder ?? 'Sesión',
    parent: { label: 'Sesiones', to: folder ? `/?g=${encodeURIComponent(folder)}` : '/' },
    ...(workspace?.title ? { documentTitle: workspace.title } : {}),
  });

  if (detail.isLoading) {
    return <div className="page narrow"><Loading rows={4} shape="list" label="Cargando la sesión…" /></div>;
  }
  if (detail.error) {
    return (
      <div className="page narrow">
        <ErrorNote error={detail.error} onRetry={() => void detail.refetch()}
          action={<Link to="/" className="btn small">Volver a Sesiones</Link>} />
      </div>
    );
  }
  if (!workspace || !detail.data) {
    return (
      <div className="page narrow">
        <ErrorNote
          error={{ code: 'NOT_FOUND', message: 'Esta sesión ya no existe en Jarvis o nunca existió.' }}
          action={<Link to="/" className="btn small">Buscar la sesión</Link>}
        />
      </div>
    );
  }

  const runs = detail.data.runs;
  const messages = transcript.data?.messages ?? [];
  /*
   * Una sesión que no se puede continuar ni estrenar. Lo dice el core, que lo comprobó contra la
   * máquina: las que sólo guardan un `/comando` tienen turnos que no son turnos.
   */
  const deadSession = transcript.data?.resumable === false;

  return (
    <div className="page narrow workspace-page">
      <Header workspace={workspace} runs={runs} attachments={detail.data.attachments}
        messageCount={transcript.data?.messageCount ?? null} />

      {/* Por sesión: lo abierto a mano en una no tiene nada que ver con otra. */}
      <Thread
        key={workspaceId}
        workspace={workspace}
        runs={runs}
        messages={messages}
        loading={transcript.isLoading}
        error={transcript.error}
        truncated={Boolean(transcript.data?.truncated)}
        onRetry={() => void transcript.refetch()}
      />

      {deadSession ? (
        <Empty
          icon={ACTION_ICON.empty}
          title="Aquí no hay conversación que continuar"
          hint={`La sesión existe en ${workspace.ref.host} pero no guarda ningún turno, así que no se puede reanudar. Sí se puede empezar otra en la misma carpeta.`}
          action={
            <button type="button" className="btn primary" onClick={() => openNewSession({
              host: workspace.ref.host, provider: workspace.ref.provider, cwd: workspace.cwd,
            })}>
              <Glyph icon={ACTION_ICON.new} />
              Empezar una aquí
            </button>
          }
        />
      ) : (
        <WorkspaceComposer key={workspaceId} workspaceId={workspaceId} draftBody={detail.data.draft.body}
          draftVersion={detail.data.draft.version} attachments={detail.data.attachments} />
      )}
    </div>
  );
}

// ---- cabecera -----------------------------------------------------------------

function Header({ workspace, runs, attachments, messageCount }: {
  workspace: Workspace;
  runs: Run[];
  attachments: Attachment[];
  messageCount: number | null;
}): JSX.Element {
  const usage = useUsage(workspace);
  const rename = useRenameWorkspace(workspace.id);
  const [editing, setEditing] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  // El destino de los detalles es el del perfil por defecto: el del compositor se ve en el compositor.
  const target = useTarget(details ? workspace.id : null, 'safe');

  const terminal = terminalHref({
    host: workspace.ref.host,
    provider: workspace.ref.provider,
    sessionId: workspace.ref.sessionId,
    from: workspace.id,
  });

  return (
    <header className="ws-head">
      <div className="ws-head-main">
        {editing === null ? (
          <h2 className="ws-title">
            <button type="button" className="title-edit" title="Cambiar el nombre"
              onClick={() => setEditing(workspace.title ?? '')}>
              {workspace.title ?? 'Sin nombre todavía'}
              <Glyph icon={ACTION_ICON.rename} size={13} />
            </button>
          </h2>
        ) : (
          <form className="row" onSubmit={(event) => {
            event.preventDefault();
            if (editing.trim()) rename.mutate(editing.trim());
            setEditing(null);
          }}>
            <input className="input" autoFocus value={editing} aria-label="Nombre de la sesión"
              onChange={(event) => setEditing(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Escape') setEditing(null); }} />
            <button type="submit" className="btn small primary">Guardar</button>
          </form>
        )}

        <div className="ws-meta">
          <button type="button" className="meta-item linklike-plain" onClick={() => setDetails((value) => !value)}
            title={workspace.cwd ?? 'sin carpeta'} aria-expanded={details}>
            <Glyph icon={STATUS_ICON.folder} size={13} />
            {folderName(workspace.cwd)}
          </button>
          <span className="meta-item">
            <Glyph icon={STATUS_ICON.host} size={13} />
            {workspace.ref.host}
          </span>
          <span className="meta-item">
            <Glyph icon={PROVIDER_ICON[workspace.ref.provider] ?? NAV_ICON.terminal} size={13} />
            {workspace.ref.provider}
          </span>
          {workspace.sessionLaunched === false ? (
            <span className="meta-item warn" title="El agente todavía no ha abierto esta sesión en la máquina">
              sin estrenar
            </span>
          ) : null}
          <UsageBadge query={usage} />
        </div>
      </div>

      <div className="ws-actions">
        <Link to={terminal} className="btn small" title="Abrir esta sesión en la terminal">
          <Glyph icon={NAV_ICON.terminal} />
          <span className="chip-text">Terminal</span>
        </Link>
        <button type="button" className="btn small ghost" aria-expanded={details}
          onClick={() => setDetails((value) => !value)}>
          <Glyph icon={ACTION_ICON.info} />
          <span className="chip-text">Detalles</span>
        </button>
      </div>

      {details ? (
        <div className="ws-details">
          <DataRow label="Carpeta">
            <span className="mono">{workspace.cwd ?? 'sin carpeta'}</span>
            {workspace.cwdSource === 'derived' ? <span className="faint"> · deducida</span> : null}
          </DataRow>
          <DataRow label="Sesión del agente">
            <span className="mono">{workspace.sessionPending ? 'asignándose…' : workspace.ref.sessionId}</span>
          </DataRow>
          <DataRow label="Destino al enviar">
            <span className="row tight" style={{ justifyContent: 'flex-end' }}>
              <TargetChip target={target.data?.target} />
            </span>
          </DataRow>
          <DataRow label="Mensajes">{messageCount ?? '—'}</DataRow>
          <DataRow label="Trabajos desde Jarvis">
            {runs.length}
            {runs[0] ? ` · el último duró ${formatDuration(durationOf(runs[0]))}` : ''}
          </DataRow>
          <DataRow label="En Jarvis desde">{relativeTime(workspace.createdAt)}</DataRow>
          {attachments.length ? (
            <div className="stack" style={{ gap: 4 }}>
              <span className="small muted">Adjuntos</span>
              {attachments.map((file) => (
                <span key={file.id} className="row tight small">
                  <Glyph icon={ACTION_ICON.attach} size={13} />
                  <span className="truncate">{file.displayName}</span>
                  <span className="faint">{formatBytes(file.sizeBytes)} · {ATTACHMENT_STATE[file.state] ?? file.state}</span>
                </span>
              ))}
            </div>
          ) : null}
          <p className="tiny faint" style={{ margin: 0 }}>
            <span className="mono">{workspace.id}</span>
            {' · '}
            <Link to="/runs">ver todo el trabajo</Link>
          </p>
        </div>
      ) : null}
      <ErrorNote error={rename.error} />
    </header>
  );
}

// ---- el hilo --------------------------------------------------------------------

function Thread({ workspace, runs, messages, loading, error, truncated, onRetry }: {
  workspace: Workspace;
  runs: Run[];
  messages: TranscriptMessage[];
  loading: boolean;
  error: unknown;
  truncated: boolean;
  onRetry: () => void;
}): JSX.Element {
  const turns = useMemo(() => buildTurns(messages, runs), [messages, runs]);
  const [showAll, setShowAll] = useState(false);
  /** Lo que se ha abierto o cerrado a mano. Lo que no está aquí sigue la regla por defecto. */
  const [manual, setManual] = useState<Record<string, boolean>>({});

  const last = turns.at(-1);
  const isOpen = (turn: Turn): boolean => manual[turn.key]
    ?? (turn === last || (turn.kind === 'run' && isRunLive(turn.run.status)));
  const toggle = (turn: Turn): void => setManual((previous) => ({ ...previous, [turn.key]: !isOpen(turn) }));

  const hidden = showAll ? 0 : Math.max(0, turns.length - VISIBLE_TURNS);
  const shown = turns.slice(hidden);

  // Lo que se paró mal y nadie ha mirado: se avisa una vez, arriba, con un atajo al turno.
  const failing = turns.filter((turn): turn is Extract<Turn, { kind: 'run' }> =>
    turn.kind === 'run' && !turn.run.acknowledgedAt && ['failed', 'timed_out', 'waiting'].includes(turn.run.status));
  const lastFailing = failing.at(-1);

  const activeRun = runs.find((run) => isRunLive(run.status));
  useAnnounceOnChange(
    activeRun ? `${activeRun.id}:${activeRun.status}` : null,
    (value) => (value && activeRun ? `El trabajo está ${RUN_STATUS[activeRun.status].name.toLowerCase()}.` : null),
  );

  if (loading && turns.length === 0) return <Loading rows={3} shape="list" label="Cargando la conversación…" />;

  return (
    <section className="thread" aria-label="Conversación">
      {error ? <ErrorNote error={error} onRetry={onRetry} /> : null}

      {lastFailing && !isOpen(lastFailing) ? (
        <button type="button" className="notice danger" onClick={() => {
          setShowAll(true);
          setManual((previous) => ({ ...previous, [lastFailing.key]: true }));
          window.setTimeout(() => document.getElementById(`turn-${lastFailing.key}`)?.scrollIntoView({ block: 'start' }), 0);
        }}>
          <Glyph icon={ACTION_ICON.error} size={15} />
          {failing.length === 1 ? 'Un trabajo se paró mal' : `${failing.length} trabajos se pararon mal`}
          <span className="notice-go">ver →</span>
        </button>
      ) : null}

      {hidden > 0 || truncated ? (
        <button type="button" className="thread-more" onClick={() => setShowAll(true)} disabled={hidden === 0}>
          {hidden > 0
            ? `Ver ${hidden} ${hidden === 1 ? 'turno anterior' : 'turnos anteriores'}`
            : 'Lo anterior de la sesión está en la terminal'}
        </button>
      ) : null}

      {shown.map((turn) => (
        <Boundary key={turn.key} what="este turno">
          <TurnCard turn={turn} open={isOpen(turn)} onToggle={() => toggle(turn)} />
        </Boundary>
      ))}

      {!loading && !error && turns.length === 0 ? (
        <Empty
          tight
          icon={ACTION_ICON.message}
          title={workspace.sessionLaunched === false ? 'Sesión nueva' : 'Todavía no hay mensajes'}
          hint="Escribe abajo lo que quieres que haga el agente."
        />
      ) : null}
    </section>
  );
}

function TurnStatus({ turn }: { turn: Turn }): JSX.Element | null {
  if (turn.kind !== 'run') return null;
  const status = turn.run.status;
  const label = RUN_STATUS[status];
  return (
    <span className={`turn-status ${label.tone}`} title={`${label.name}. ${label.help}`}>
      <Glyph icon={RUN_STATUS_ICON[status]} size={14} className={status === 'running' ? 'spin' : undefined} />
      <span className="visually-hidden">{label.name}</span>
    </span>
  );
}

function TurnCard({ turn, open, onToggle }: { turn: Turn; open: boolean; onToggle: () => void }): JSX.Element {
  const when = turn.at ? relativeTime(turn.at) : null;
  const prompt = turn.prompt
    ? (open ? turn.prompt.trim() : oneLine(turn.prompt, 160))
    : '(continúa de antes)';
  const answer = turn.answer ? oneLine(turn.answer, 260) : null;
  const live = turn.kind === 'run' && isRunLive(turn.run.status);
  // Plegado se copia la última respuesta sin abrir nada; desplegado, cada respuesta tiene el suyo.
  const copyable = !open && !live ? fullAnswer(turn) : null;

  return (
    <article id={`turn-${turn.key}`} className={`turn ${open ? 'open' : ''} ${copyable ? 'has-copy' : ''} ${turn.kind}`}>
      <button type="button" className="turn-head" aria-expanded={open} onClick={onToggle}>
        <span className="turn-prompt">
          <span className="turn-you" aria-hidden="true">Tú</span>
          <span className={open ? 'turn-prompt-text' : 'turn-prompt-text truncate'}>{prompt}</span>
        </span>
        <span className="turn-meta">
          <TurnStatus turn={turn} />
          {when ? <span className="tiny faint nowrap">{when}</span> : null}
          <Glyph icon={open ? ACTION_ICON.scrollUp : ACTION_ICON.scrollDown} size={14} className="faint" />
        </span>
        {!open ? (
          <span className={`turn-answer ${answer ? '' : 'faint'}`}>
            {answer ?? (live ? 'trabajando…' : 'sin respuesta')}
          </span>
        ) : null}
      </button>
      {/* Fuera del botón del turno: un botón dentro de otro no es HTML válido ni se puede pulsar. */}
      {copyable ? <CopyButton text={copyable} label="Copiar la última respuesta" className="turn-copy" /> : null}

      {open ? (
        <div className="turn-body">
          {turn.kind === 'run'
            ? <RunTurnBody run={turn.run} />
            : <TranscriptTurnBody messages={turn.messages} prompt={turn.prompt} />}
        </div>
      ) : null}
    </article>
  );
}

/** El turno de un trabajo de Jarvis: su línea de eventos, en directo si sigue vivo. */
function RunTurnBody({ run }: { run: Run }): JSX.Element {
  const stream = useRunStream(run.id);
  const cancel = useCancelRun();
  const live = isRunLive(run.status);

  const toolbar = (
    <span className="turn-tools">
      <RunStatusBadge status={run.status} />
      <span className={`badge ${PERMISSION[run.permissionProfile].tone}`} title={PERMISSION[run.permissionProfile].help}>
        <Glyph icon={PERMISSION_ICON[run.permissionProfile]} />
        {PERMISSION[run.permissionProfile].name}
      </span>
      {live && !stream.connected && !stream.ended ? <span className="badge warn">reconectando…</span> : null}
      {['queued', 'preparing', 'running', 'waiting'].includes(run.status) ? (
        <button type="button" className="btn small danger" onClick={() => cancel.mutate(run.id)}>
          <Glyph icon={ACTION_ICON.stop} />
          Parar
        </button>
      ) : null}
      <Link to={`/runs/${run.id}`} className="btn small icon ghost" title="Abrir en Trabajo" aria-label="Abrir este trabajo en Trabajo">
        <Glyph icon={ACTION_ICON.external} />
      </Link>
    </span>
  );

  return (
    <>
      <ErrorNote error={cancel.error} />
      {/*
        * Lo que se pidió ya está en la cabecera del turno: repetirlo como primera fila del hilo era
        * leerlo dos veces. Cambiar de trabajo empieza de cero: compacto y todo plegado.
        */}
      <EventTimeline
        key={run.id}
        events={stream.events}
        toolbar={toolbar}
        live={live}
        empty={live
          ? 'Ya está lanzado; en cuanto el agente diga algo aparece aquí.'
          : (run.errorMessage ?? 'Este trabajo no dejó eventos.')}
      />
    </>
  );
}

/**
 * Lo que vino del transcript de la máquina.
 *
 * Un `/model` tecleado en la terminal y su respuesta llegan con `role: "user"` porque así los
 * guarda el fichero de sesión; se pintan como una línea pequeña, no como un mensaje de nadie.
 */
function TranscriptTurnBody({ messages, prompt }: { messages: TranscriptMessage[]; prompt: string | null }): JSX.Element {
  // El primer mensaje es lo que se pidió, y eso ya está escrito entero en la cabecera del turno.
  const rest = prompt && messages[0]?.role === 'user' ? messages.slice(1) : messages;
  return (
    <div className="messages">
      {rest.map((message, index) => {
        if (message.kind !== 'text') {
          return (
            <div key={index} className="cli-line" title={message.text}>
              <Glyph icon={message.kind === 'command' ? ACTION_ICON.go : NAV_ICON.terminal} size={13} />
              <span className="truncate mono">{message.label}</span>
            </div>
          );
        }
        return (
          <div key={index} className={`message ${message.role}`}>
            <div className="who">
              <span>{message.role === 'user' ? 'Tú' : message.role === 'assistant' ? 'Agente' : message.role}</span>
              {message.at ? (
                <span className="faint" title={new Date(message.at).toLocaleString()}>{relativeTime(message.at)}</span>
              ) : null}
              {message.role === 'assistant' ? <CopyButton text={message.text} className="message-copy" /> : null}
            </div>
            <div className="body">
              {message.role === 'assistant' ? <Markdown source={message.text} /> : message.text}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---- el compositor --------------------------------------------------------------

function WorkspaceComposer({ workspaceId, draftBody, draftVersion, attachments }: {
  workspaceId: string;
  draftBody: string;
  draftVersion: number;
  attachments: Attachment[];
}): JSX.Element {
  const [profile, setProfile] = useState<PermissionProfile>('safe');
  const target = useTarget(workspaceId, profile);
  const createRun = useCreateRun(workspaceId);
  const upload = useUploadAttachment(workspaceId);
  const saveDraft = useSaveDraft(workspaceId);
  /**
   * Qué adjuntos van con el próximo envío. Se excluye aquí y no se borra allí: un fichero subido
   * vive en la máquina y caduca solo; lo que se decide aquí es qué se le pasa al agente.
   */
  const [excluded, setExcluded] = useState<string[]>([]);
  const [body, setBody] = useState('');
  const [dirty, setDirty] = useState(false);

  /**
   * Al cambiar de sesión se recarga el borrador del servidor, con el espejo local sólo como red
   * de seguridad de los últimos segundos. Cambiar de contexto no puede arrastrar texto de otro sitio.
   */
  useEffect(() => {
    const mirrored = window.localStorage.getItem(draftMirrorKey(workspaceId));
    setBody(mirrored && mirrored !== draftBody ? mirrored : draftBody);
    setDirty(Boolean(mirrored && mirrored !== draftBody));
    // Sólo al cambiar de sesión: el borrador del servidor se refresca solo y no debe pisar lo escrito.
  }, [workspaceId]);

  // Guardado con retardo: escribir no puede costar una petición por tecla.
  const timer = useRef<number | null>(null);
  const onChangeBody = useCallback((value: string) => {
    setBody(value);
    setDirty(true);
    window.localStorage.setItem(draftMirrorKey(workspaceId), value);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      saveDraft.mutate({ body: value, expectedVersion: draftVersion }, { onSuccess: () => setDirty(false) });
    }, 600);
  }, [saveDraft, draftVersion, workspaceId]);

  const staged = attachments.filter((file) => file.state === 'staged');
  const attached = staged.filter((file) => !excluded.includes(file.id));

  async function send(): Promise<void> {
    if (!body.trim()) return;
    // La clave de idempotencia es del envío, no del render: un doble toque manda la misma.
    const idempotencyKey = `${workspaceId}:${draftVersion}:${body.length}:${body.slice(0, 24)}`;
    await createRun.mutateAsync({
      prompt: body,
      permissionProfile: profile,
      idempotencyKey,
      ...(attached.length ? { attachmentIds: attached.map((file) => file.id) } : {}),
    });
    // El borrador sólo se limpia cuando el servidor ya tiene el trabajo.
    setBody('');
    setDirty(false);
    window.localStorage.removeItem(draftMirrorKey(workspaceId));
    saveDraft.mutate({ body: '', expectedVersion: draftVersion });
  }

  return (
    <section className="ws-composer" aria-label="Mandar trabajo">
      <Composer
        value={body}
        onChange={onChangeBody}
        onSubmit={() => void send()}
        placeholder="¿Qué quieres que haga?"
        label="Qué quieres que haga el agente"
        submitLabel="Enviar"
        submitting={createRun.isPending}
        disabled={upload.isPending}
        rows={2}
        uploading={upload.isPending}
        onFiles={(chosen) => {
          // De uno en uno: el core reserva cuota por fichero y así un rechazo dice cuál falló.
          void chosen.reduce(
            (chain, file) => chain.then(() => upload.mutateAsync(file).then(() => undefined)),
            Promise.resolve(),
          ).catch(() => undefined);
        }}
        after={
          <>
            {staged.length ? (
              <div className="facts">
                {staged.map((file) => {
                  const off = excluded.includes(file.id);
                  return (
                    <span key={file.id} className={`fact ${off ? '' : 'ok'}`}>
                      <span className="fact-label"><Glyph icon={ACTION_ICON.attach} size={12} /></span>
                      <span className={`fact-value ${off ? 'faint' : ''}`} title={file.displayName}>
                        {file.displayName} · {formatBytes(file.sizeBytes)}
                      </span>
                      <button type="button" className="linklike tiny"
                        aria-label={`${off ? 'Incluir' : 'Quitar'} ${file.displayName}`}
                        onClick={() => setExcluded((list) => (
                          off ? list.filter((id) => id !== file.id) : [...list, file.id]
                        ))}>
                        {off ? 'incluir' : 'quitar'}
                      </button>
                    </span>
                  );
                })}
              </div>
            ) : null}
            <ErrorNote error={upload.error} />
            {/*
              * El permiso se queda a la vista y entero: es lo que decide qué puede tocar el agente
              * en una máquina de verdad. Lo único que se compacta es la explicación, a una línea.
              */}
            <div className="composer-foot">
              <Segmented label="Qué puede hacer el agente" options={PROFILES} value={profile} onChange={setProfile} />
              <span className="composer-target small" title={target.data?.target.reason ?? undefined}>
                {target.data?.target
                  ? `${target.data.target.provider} · en ${target.data.target.executionHost}`
                    + (target.data.target.strategy === 'A' ? ` sobre ${target.data.target.workHost}` : '')
                  : target.isLoading ? 'resolviendo destino…' : 'destino no disponible'}
                {dirty ? ' · guardando…' : ''}
              </span>
            </div>
            <p className="tiny muted permission-help">
              <Glyph icon={PERMISSION_ICON[profile]} size={13} />
              <span>{PERMISSION[profile].help}</span>
            </p>
            <ErrorNote error={target.error} />
          </>
        }
      />
      <ErrorNote error={createRun.error} />
    </section>
  );
}
