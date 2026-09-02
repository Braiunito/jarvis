/**
 * El workspace: dónde se trabaja.
 *
 * Tres reglas gobiernan esta pantalla:
 *   · el destino y el permiso se ven antes de pulsar Enviar;
 *   · el borrador no se pierde por navegar, fallar ni recargar, y sólo se borra cuando el
 *     servidor confirma que el run existe;
 *   · lo que escribió el agente remoto y lo que hizo Jarvis nunca se mezclan sin decirlo.
 *
 * Las pestañas separan cuatro preguntas distintas —qué está pasando, qué se dijo, con qué
 * contexto y con qué ajustes— pero el compositor no se esconde detrás de ninguna: mandar trabajo
 * es lo que se viene a hacer aquí.
 */
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, PermissionProfile, Run } from '@jarvis/contracts';
import {
  useCancelRun, useCreateRun, useRenameWorkspace, useSaveDraft, useTarget, useTranscript, useUsage,
  useWorkspace,
} from '../api/queries.js';
import { useRunStream } from '../api/run-stream.js';
import {
  Empty, ErrorNote, Link, Loading, RunStatusBadge, StaleNote, TargetChip, relativeTime,
} from '../ui/bits.jsx';
import { useAnnounceOnChange } from '../ui/announce.jsx';
import { AssistantPanel } from '../ui/assistant.jsx';
import { PERMISSION, PROVENANCE, RUN_STATUS } from '../ui/labels.js';
import {
  ACTION_ICON, Glyph, NAV_ICON, PERMISSION_ICON, PROVENANCE_ICON, PROVIDER_ICON, STATUS_ICON,
} from '../ui/icons.jsx';
import { EventTimeline } from '../ui/event-log.jsx';
import { usePageMeta } from '../ui/page-meta.jsx';
import { UsageBadge, messageBadgeText } from '../ui/usage.jsx';
import { Card, DataRow, Segmented, Tabs, formatDuration, type SegmentOption } from '../ui/primitives.jsx';

const PROFILES: Array<SegmentOption<PermissionProfile>> = (['safe', 'auto', 'yolo'] as const).map((value) => ({
  value,
  label: PERMISSION[value].name,
  icon: PERMISSION_ICON[value],
  tone: PERMISSION[value].tone,
  hint: PERMISSION[value].help,
}));

/**
 * Atajos de lo que más se pide.
 *
 * Son plantillas, no acciones: rellenan el compositor para que se lean y se corrijan antes de
 * enviarse. Un chip que lanzara trabajo por sí solo se pulsaría sin mirar el permiso.
 */
const SUGGESTIONS = [
  'Resume en qué estado quedó esto y qué falta.',
  'Revisa los cambios sin tocar nada y dime qué ves.',
  'Explica el último error y propón cómo arreglarlo.',
  'Sigue por donde lo dejaste.',
];

/** Espejo local del borrador: cubre los segundos entre teclear y que el servidor confirme. */
const draftMirrorKey = (workspaceId: string): string => `jarvis.draft.${workspaceId}`;

const ATTACHMENT_STATE: Record<string, string> = {
  staged: 'subido, sin usar todavía',
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

type TabId = 'actividad' | 'conversacion' | 'contexto' | 'ajustes';

export function WorkspaceScreen({ workspaceId }: { workspaceId: string }): JSX.Element {
  const detail = useWorkspace(workspaceId);
  const workspace = detail.data?.workspace;
  const transcript = useTranscript(workspace);
  const usage = useUsage(workspace);

  const [profile, setProfile] = useState<PermissionProfile>('safe');
  const target = useTarget(workspaceId, profile);
  const createRun = useCreateRun(workspaceId);
  const cancelRun = useCancelRun();
  const saveDraft = useSaveDraft(workspaceId);

  const rename = useRenameWorkspace(workspaceId);
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>('actividad');

  const [body, setBody] = useState('');
  const [dirty, setDirty] = useState(false);
  const version = detail.data?.draft.version ?? 0;
  const textarea = useRef<HTMLTextAreaElement | null>(null);

  // El run que se está mirando: el más reciente, salvo que el usuario elija otro.
  const [pinnedRunId, setPinnedRunId] = useState<string | null>(null);
  const runs = detail.data?.runs ?? [];
  const attachments: Attachment[] = detail.data?.attachments ?? [];
  const activeRun: Run | undefined = useMemo(() => {
    if (pinnedRunId) return runs.find((run) => run.id === pinnedRunId);
    return runs[0];
  }, [pinnedRunId, runs]);
  const stream = useRunStream(activeRun ? activeRun.id : null);

  useAnnounceOnChange(
    activeRun ? `${activeRun.id}:${activeRun.status}` : null,
    (value) => {
      if (!value || !activeRun) return null;
      const label = RUN_STATUS[activeRun.status];
      return `El trabajo ${activeRun.id.slice(0, 8)} está ${label.name.toLowerCase()}. ${label.help}`;
    },
  );

  usePageMeta({
    title: workspace?.title ?? 'Workspace',
    ...(workspace ? { subtitle: `${workspace.ref.provider} en ${workspace.ref.host}` } : {}),
    parent: PARENT,
  });

  /**
   * Al cambiar de workspace se recarga el borrador del servidor, con el espejo local sólo como
   * red de seguridad de los últimos segundos. Cambiar de contexto no puede arrastrar el texto de
   * otro sitio.
   */
  useEffect(() => {
    if (!detail.data) return;
    const mirrored = window.localStorage.getItem(draftMirrorKey(workspaceId));
    setBody(mirrored && mirrored !== detail.data.draft.body ? mirrored : detail.data.draft.body);
    setDirty(Boolean(mirrored && mirrored !== detail.data.draft.body));
    setPinnedRunId(null);
    setTab('actividad');
  }, [workspaceId, detail.data?.workspace.id]);

  // Guardado con retardo: escribir no puede costar una petición por tecla, y perder lo escrito
  // por navegar no es aceptable.
  const timer = useRef<number | null>(null);
  const onChangeBody = useCallback((value: string) => {
    setBody(value);
    setDirty(true);
    window.localStorage.setItem(draftMirrorKey(workspaceId), value);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      saveDraft.mutate({ body: value, expectedVersion: version }, {
        onSuccess: () => setDirty(false),
      });
    }, 600);
  }, [saveDraft, version, workspaceId]);

  async function send(): Promise<void> {
    if (!body.trim()) return;
    // La clave de idempotencia es del envío, no del render: un doble toque manda la misma.
    const idempotencyKey = `${workspaceId}:${version}:${body.length}:${body.slice(0, 24)}`;
    const created = await createRun.mutateAsync({ prompt: body, permissionProfile: profile, idempotencyKey });
    // El borrador sólo se limpia cuando el servidor ya tiene el run.
    setBody('');
    setDirty(false);
    window.localStorage.removeItem(draftMirrorKey(workspaceId));
    saveDraft.mutate({ body: '', expectedVersion: version });
    setPinnedRunId(created.run.id);
    setTab('actividad');
  }

  if (detail.isLoading) {
    return <div className="page"><Loading rows={4} shape="list" label="Cargando el workspace…" /></div>;
  }
  if (detail.error) {
    return (
      <div className="page">
        <ErrorNote error={detail.error} onRetry={() => void detail.refetch()}
          action={<Link to="/sessions" className="btn small">Volver a Sesiones</Link>} />
      </div>
    );
  }
  if (!workspace) {
    return (
      <div className="page">
        <ErrorNote
          error={{ code: 'NOT_FOUND', message: 'Este workspace ya no existe o nunca existió.' }}
          action={<Link to="/sessions" className="btn small">Buscar la sesión</Link>}
        />
      </div>
    );
  }

  const events = stream.events;
  const terminalHref = `/terminal?host=${encodeURIComponent(workspace.ref.host)}`
    + `&provider=${workspace.ref.provider}`
    + `&sessionId=${encodeURIComponent(workspace.ref.sessionId)}`
    + `&from=${encodeURIComponent(workspace.id)}`;
  const attention = runs.filter((run) => ['failed', 'timed_out', 'waiting'].includes(run.status));
  const messages = transcript.data?.messages ?? [];
  // Los que tiene la sesión, no los que caben en la página que se ha traído.
  const messageBadge = messageBadgeText({
    shown: messages.length, total: transcript.data?.messageCount ?? null,
  });

  const suggest = (text: string): void => {
    onChangeBody(body.trim() ? `${body.trim()}\n${text}` : text);
    textarea.current?.focus();
  };

  return (
    <div className="page">
      {/* Cabecera: qué es esto, dónde vive y qué se puede hacer con ello. */}
      <Card>
        <div className="spread" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            {editingTitle === null ? (
              <h2 style={{ margin: '0 0 6px', fontSize: 17 }}>
                <button type="button" className="title-edit"
                  title="Cambiar el nombre de este workspace"
                  onClick={() => setEditingTitle(workspace.title ?? '')}>
                  {workspace.title ?? 'Sin nombre todavía'}
                  <Glyph icon={ACTION_ICON.rename} size={13} />
                </button>
              </h2>
            ) : (
              <form className="row" style={{ marginBottom: 6 }}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (editingTitle.trim()) rename.mutate(editingTitle.trim());
                  setEditingTitle(null);
                }}>
                <input className="input" autoFocus value={editingTitle} aria-label="Nombre del workspace"
                  onChange={(event) => setEditingTitle(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Escape') setEditingTitle(null); }} />
                <button type="submit" className="btn small primary">
                  <Glyph icon={ACTION_ICON.approve} />
                  Guardar
                </button>
              </form>
            )}

            <div className="row" style={{ gap: 6 }}>
              <span className="badge neutral">
                <Glyph icon={PROVIDER_ICON[workspace.ref.provider] ?? NAV_ICON.terminal} />
                {workspace.ref.provider}
              </span>
              <span className="badge neutral">
                <Glyph icon={STATUS_ICON.host} />
                {workspace.ref.host}
              </span>
              {workspace.cwd ? (
                <span className="badge neutral mono" title={workspace.cwd}>
                  <Glyph icon={STATUS_ICON.folder} />
                  {workspace.cwd}
                </span>
              ) : null}
              {messages.length ? (
                <span className="badge neutral" title={messageBadge.title}>
                  <Glyph icon={STATUS_ICON.message} />
                  {messageBadge.text}
                </span>
              ) : null}
              <UsageBadge query={usage} />
            </div>
          </div>

          <div className="row">
            <Link to={terminalHref} className="btn">
              <Glyph icon={NAV_ICON.terminal} />
              Abrir terminal
            </Link>
            <Link to="/runs" className="btn">
              <Glyph icon={NAV_ICON.runs} />
              Ver todo el trabajo
            </Link>
          </div>
        </div>
        <ErrorNote error={rename.error} />
      </Card>

      {attention.length ? (
        <p className="note" role="status">
          <Glyph icon={ACTION_ICON.error} size={16} />
          <span>
            {attention.length === 1
              ? 'Un trabajo de este workspace se paró mal. '
              : `${attention.length} trabajos de este workspace se pararon mal. `}
            <button type="button" className="linklike"
              onClick={() => { setPinnedRunId(attention[0]?.id ?? null); setTab('actividad'); }}>
              Ver el último
            </button>
          </span>
        </p>
      ) : null}

      <div className="grid main-side">
        <div className="stack" style={{ gap: 14 }}>
          <Card>
            <Tabs
              label="Vistas del workspace"
              active={tab}
              onChange={(id) => setTab(id as TabId)}
              tabs={[
                { id: 'actividad', label: 'Actividad', icon: STATUS_ICON.activity },
                { id: 'conversacion', label: 'Conversación', icon: ACTION_ICON.message, count: messages.length },
                { id: 'contexto', label: 'Archivos y contexto', icon: ACTION_ICON.attach, count: attachments.length },
                { id: 'ajustes', label: 'Configuración', icon: ACTION_ICON.settings },
              ]}
            />

            {tab === 'actividad' ? (
              activeRun ? (
                <>
                  <div className="row" style={{ marginBottom: 12 }}>
                    <RunStatusBadge status={activeRun.status} />
                    <span className="small muted mono">{activeRun.id.slice(0, 10)}</span>
                    <span className="small muted">{relativeTime(activeRun.startedAt ?? activeRun.createdAt)}</span>
                    <span className="badge neutral">
                      <Glyph icon={STATUS_ICON.host} />
                      {activeRun.executionHost}
                    </span>
                    {activeRun.strategy === 'A' ? (
                      <span className="badge warn">trabaja sobre {activeRun.workHost}</span>
                    ) : null}
                    <span className={`badge ${PERMISSION[activeRun.permissionProfile].tone}`}>
                      <Glyph icon={PERMISSION_ICON[activeRun.permissionProfile]} />
                      {PERMISSION[activeRun.permissionProfile].name}
                    </span>
                    {!stream.connected && !stream.ended ? (
                      <span className="badge warn">
                        <Glyph icon={ACTION_ICON.connect} />
                        reconectando…
                      </span>
                    ) : null}
                    <span className="row" style={{ marginLeft: 'auto' }}>
                      <Link to={`/runs/${activeRun.id}`} className="btn small">
                        <Glyph icon={ACTION_ICON.external} />
                        Abrir el trabajo
                      </Link>
                      {['queued', 'preparing', 'running', 'waiting'].includes(activeRun.status) ? (
                        <button type="button" className="btn small danger"
                          onClick={() => cancelRun.mutate(activeRun.id)}>
                          <Glyph icon={ACTION_ICON.stop} />
                          Parar
                        </button>
                      ) : null}
                    </span>
                  </div>
                  <EventTimeline
                    events={events}
                    empty="El trabajo ya está lanzado; en cuanto el agente diga algo aparece aquí, y se queda guardado."
                  />
                </>
              ) : (
                <Empty
                  icon={ACTION_ICON.send}
                  title="Todavía no has mandado nada aquí"
                  hint="Lo que escribas abajo se ejecuta en la máquina de la cabecera, con el permiso que elijas. Aquí verás lo que vaya haciendo, paso a paso."
                  action={
                    <button type="button" className="btn primary"
                      onClick={() => textarea.current?.focus()}>
                      <Glyph icon={ACTION_ICON.send} />
                      Escribir la primera tarea
                    </button>
                  }
                />
              )
            ) : null}

            {tab === 'conversacion' ? (
              <>
                <p className="small muted" style={{ margin: '0 0 10px' }}>
                  Escrito por el agente en {workspace.ref.host}. Jarvis sólo lo lee.
                </p>
                <StaleNote stale={Boolean(transcript.error)} />
                {transcript.isLoading ? <Loading rows={3} shape="text" label="Cargando la conversación…" /> : null}
                {transcript.error ? (
                  <ErrorNote error={transcript.error} onRetry={() => void transcript.refetch()} />
                ) : null}
                {/*
                  * Una zona con scroll propio necesita ser alcanzable con el teclado: sin
                  * `tabindex` no hay forma de bajar por ella sin ratón.
                  */}
                <div className="messages" tabIndex={0} role="region"
                  aria-label="Conversación de la sesión">
                  {messages.map((message, index) => (
                    <div key={index} className={`message ${message.role}`}>
                      <div className="who">
                        <span>{message.role}</span>
                        <span className="badge neutral">
                          <Glyph icon={PROVENANCE_ICON[message.provenance] ?? PROVENANCE_ICON['system'] as never} size={13} />
                          {PROVENANCE[message.provenance] ?? message.provenance}
                        </span>
                        {message.at ? <span>{new Date(message.at).toLocaleString()}</span> : null}
                      </div>
                      <div className="body">{message.text}</div>
                    </div>
                  ))}
                  {!transcript.isLoading && !transcript.error && messages.length === 0 ? (
                    <Empty
                      tight
                      icon={ACTION_ICON.message}
                      title="Esta sesión todavía no tiene mensajes"
                      hint="Aparecerán aquí en cuanto el agente hable en la máquina, lo mandes tú desde abajo o alguien trabaje en esa sesión por su cuenta."
                    />
                  ) : null}
                </div>
              </>
            ) : null}

            {tab === 'contexto' ? (
              <div className="stack">
                <p className="small muted" style={{ margin: 0 }}>
                  Lo que el agente puede ver: la carpeta donde trabaja y los ficheros que le subiste.
                  Jarvis les da un nombre propio en la máquina y los borra al terminar.
                </p>
                <div className="stack" style={{ gap: 7 }}>
                  <DataRow label="Carpeta de trabajo">
                    <span className="mono">{workspace.cwd ?? 'sin carpeta'}</span>
                  </DataRow>
                  <DataRow label="Sesión del agente">
                    <span className="mono">{workspace.ref.sessionId}</span>
                  </DataRow>
                </div>

                <div>
                  <div className="spread" style={{ marginBottom: 8 }}>
                    <span className="small muted">Adjuntos</span>
                    <span className="tiny faint">{attachments.length}</span>
                  </div>
                  {attachments.length === 0 ? (
                    <Empty
                      tight
                      icon={ACTION_ICON.attach}
                      title="Sin adjuntos"
                      hint="Se suben al mandar trabajo, viven en la máquina con un nombre que pone Jarvis y caducan solos."
                    />
                  ) : (
                    <div className="list">
                      {attachments.map((file) => (
                        <div key={file.id} className="list-item" style={{ cursor: 'default' }}>
                          <span className="row tight nowrap" style={{ minWidth: 0 }}>
                            <Glyph icon={ACTION_ICON.attach} />
                            <span className="truncate">{file.displayName}</span>
                            <span className="tiny faint">{formatBytes(file.sizeBytes)}</span>
                          </span>
                          <span className="row tight nowrap">
                            <span className={`badge ${file.state === 'failed' ? 'danger' : file.state === 'expired' ? 'warn' : 'neutral'}`}>
                              {ATTACHMENT_STATE[file.state] ?? file.state}
                            </span>
                            <span className="tiny faint">{relativeTime(file.createdAt)}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : null}

            {tab === 'ajustes' ? (
              <div className="stack">
                <div className="stack" style={{ gap: 7 }}>
                  <DataRow label="Identificador">
                    <span className="mono">{workspace.id}</span>
                  </DataRow>
                  <DataRow label="Máquina">{workspace.ref.host}</DataRow>
                  <DataRow label="Agente">{workspace.ref.provider}</DataRow>
                  <DataRow label="Sesión">
                    <span className="mono">{workspace.ref.sessionId}</span>
                  </DataRow>
                  <DataRow label="Creado">{relativeTime(workspace.createdAt)}</DataRow>
                </div>

                <div>
                  <p className="small muted" style={{ margin: '0 0 8px' }}>Destino que se usará al enviar</p>
                  <div className="composer-target">
                    <TargetChip target={target.data?.target} />
                  </div>
                  {target.data?.target.reason ? (
                    <p className="tiny faint" style={{ margin: '8px 0 0' }}>{target.data.target.reason}</p>
                  ) : null}
                </div>

                <p className="note">
                  <Glyph icon={ACTION_ICON.secure} size={16} />
                  <span>
                    El nombre del workspace es tuyo: si lo cambias, Jarvis deja de reescribirlo con
                    el título que trae la sesión.
                  </span>
                </p>
              </div>
            ) : null}
          </Card>

          {/* El compositor no vive dentro de una pestaña: es lo que se viene a hacer aquí. */}
          {tab === 'actividad' || tab === 'conversacion' ? (
            <Card className="composer">
              <div className="composer-target">
                <TargetChip target={target.data?.target} />
                {target.isLoading ? <span className="small muted">resolviendo destino…</span> : null}
                {target.error ? <span className="badge danger">destino no disponible</span> : null}
              </div>
              <ErrorNote error={target.error} />

              <label className="stack" style={{ gap: 6 }}>
                <span className="small muted">
                  Qué quieres que haga
                  {dirty ? ' · guardando borrador…' : version ? ' · borrador guardado' : ''}
                </span>
                <textarea
                  ref={textarea}
                  className="textarea"
                  value={body}
                  onChange={(event) => onChangeBody(event.target.value)}
                  placeholder="Describe la tarea. Se manda a la máquina de arriba con el permiso que elijas."
                  aria-label="Qué quieres que haga el agente"
                />
              </label>

              <div className="suggestions">
                {SUGGESTIONS.map((text) => (
                  <button key={text} type="button" className="suggestion" onClick={() => suggest(text)}>
                    <Glyph icon={ACTION_ICON.go} size={13} />
                    {text}
                  </button>
                ))}
              </div>

              <div className="spread" style={{ flexWrap: 'wrap' }}>
                <Segmented
                  label="Qué puede hacer el agente"
                  options={PROFILES}
                  value={profile}
                  onChange={setProfile}
                />
                <button type="button" className="btn primary" disabled={createRun.isPending || !body.trim()}
                  onClick={() => void send()}>
                  <Glyph icon={ACTION_ICON.send} />
                  {createRun.isPending ? 'Enviando…' : 'Enviar'}
                </button>
              </div>

              <p className="small muted permission-help" style={{ margin: 0 }}>
                <Glyph icon={PERMISSION_ICON[profile]} />
                <span>{PERMISSION[profile].help}</span>
              </p>
              <ErrorNote error={createRun.error} />
            </Card>
          ) : null}
        </div>

        <div className="stack" style={{ gap: 14 }}>
          <AssistantPanel workspaceId={workspaceId} />

          <Card title="Trabajos de este workspace" icon={NAV_ICON.runs} count={runs.length}
            {...(attention.length ? { countTone: 'attention' as const } : {})}>
            <div className="list">
              {runs.map((run) => (
                <button key={run.id} type="button" className="list-item"
                  aria-current={activeRun?.id === run.id}
                  onClick={() => { setPinnedRunId(run.id); setTab('actividad'); }}>
                  <span className="row tight nowrap" style={{ minWidth: 0 }}>
                    <RunStatusBadge status={run.status} />
                    <span className="small muted mono truncate">{run.id.slice(0, 8)}</span>
                  </span>
                  <span className="row tight nowrap">
                    <span className={`badge ${PERMISSION[run.permissionProfile].tone}`}>
                      <Glyph icon={PERMISSION_ICON[run.permissionProfile]} size={13} />
                      {PERMISSION[run.permissionProfile].name}
                    </span>
                    <span className="tiny faint">{relativeTime(run.createdAt)}</span>
                  </span>
                </button>
              ))}
              {runs.length === 0 ? (
                <Empty
                  tight
                  icon={NAV_ICON.runs}
                  title="Ningún trabajo todavía"
                  hint="Cada cosa que mandes desde abajo deja aquí su registro, con su permiso y su evidencia."
                />
              ) : null}
            </div>
          </Card>

          <Card title="Resumen" icon={ACTION_ICON.session}>
            <div className="stack" style={{ gap: 7 }}>
              <DataRow label="Mensajes en la sesión">
                {transcript.data?.messageCount ?? messages.length ?? '—'}
                {transcript.data && transcript.data.messageCount !== null
                  && transcript.data.messageCount > messages.length
                  ? <span className="muted small"> · aquí se ven los {messages.length} últimos</span>
                  : null}
              </DataRow>
              <DataRow label="Trabajos lanzados">{runs.length}</DataRow>
              <DataRow label="Último trabajo">{relativeTime(runs[0]?.createdAt ?? null)}</DataRow>
              <DataRow label="Duración del último">
                {formatDuration(durationOf(runs[0]))}
              </DataRow>
              <DataRow label="Adjuntos vivos">
                {attachments.filter((file) => file.state === 'staged' || file.state === 'claimed').length}
              </DataRow>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/** Constante para que las migas no sean un objeto nuevo en cada render. */
const PARENT = { label: 'Sesiones', to: '/sessions' } as const;

const durationOf = (run: Run | undefined): number | null =>
  run?.startedAt && run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null;
