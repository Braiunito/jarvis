/**
 * El workspace: dónde se trabaja.
 *
 * Tres reglas gobiernan esta pantalla:
 *   · el destino y el permiso se ven antes de pulsar Send;
 *   · el borrador no se pierde por navegar, fallar ni recargar, y sólo se borra cuando el
 *     servidor confirma que el run existe;
 *   · lo que escribió el agente remoto y lo que hizo Jarvis nunca se mezclan sin decirlo.
 */
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PermissionProfile, Run, RunEvent } from '@jarvis/contracts';
import {
  useCancelRun, useCreateRun, useRenameWorkspace, useSaveDraft, useTarget, useTranscript, useUsage,
  useWorkspace,
} from '../api/queries.js';
import { useRunStream } from '../api/run-stream.js';
import { ErrorNote, Link, Loading, RunStatusBadge, StaleNote, TargetChip, relativeTime } from '../ui/bits.jsx';
import { AssistantPanel } from '../ui/assistant.jsx';
import { EVENT_KIND, PERMISSION, PROVENANCE } from '../ui/labels.js';

const PROFILES: PermissionProfile[] = ['safe', 'auto', 'yolo'];

/** Espejo local del borrador: cubre los segundos entre teclear y que el servidor confirme. */
const draftMirrorKey = (workspaceId: string): string => `jarvis.draft.${workspaceId}`;

function eventText(event: RunEvent): string {
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload?.['text'] === 'string') return payload['text'] as string;
  if (event.type === 'agent.tool') {
    const tool = payload['tool'] as { name?: string; status?: string; output?: string; truncated?: boolean };
    return `${tool.name ?? 'tool'} · ${tool.status ?? ''}${tool.output ? `\n${tool.output}` : ''}${tool.truncated ? '\n[recortado]' : ''}`;
  }
  if (event.type === 'agent.result') {
    const result = payload as { ok?: boolean; text?: string };
    return result.text ?? (result.ok ? 'terminado' : 'terminado con error');
  }
  if (event.type === 'run.status') {
    const status = payload as { from: string; to: string; reason?: string };
    return `${status.from} → ${status.to}${status.reason ? ` (${status.reason})` : ''}`;
  }
  if (event.type === 'agent.error') return String(payload['message'] ?? 'error');
  return JSON.stringify(payload).slice(0, 400);
}

const eventTone = (type: string): string =>
  type === 'agent.error' ? 'error' : type === 'agent.tool' ? 'tool' : type === 'agent.text' ? 'text' : '';

export function WorkspaceScreen({ workspaceId }: { workspaceId: string }): JSX.Element {
  const detail = useWorkspace(workspaceId);
  const workspace = detail.data?.workspace;
  const transcript = useTranscript(workspace);
  const usage = useUsage(workspaceId);

  const [profile, setProfile] = useState<PermissionProfile>('safe');
  const target = useTarget(workspaceId, profile);
  const createRun = useCreateRun(workspaceId);
  const cancelRun = useCancelRun();
  const saveDraft = useSaveDraft(workspaceId);

  const rename = useRenameWorkspace(workspaceId);
  const [editingTitle, setEditingTitle] = useState<string | null>(null);

  const [body, setBody] = useState('');
  const [dirty, setDirty] = useState(false);
  const version = detail.data?.draft.version ?? 0;

  // El run que se está mirando: el más reciente, salvo que el usuario elija otro.
  const [pinnedRunId, setPinnedRunId] = useState<string | null>(null);
  const runs = detail.data?.runs ?? [];
  const activeRun: Run | undefined = useMemo(() => {
    if (pinnedRunId) return runs.find((run) => run.id === pinnedRunId);
    return runs[0];
  }, [pinnedRunId, runs]);
  const stream = useRunStream(activeRun ? activeRun.id : null);

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
  }

  if (detail.isLoading) return <div className="page"><Loading rows={6} /></div>;
  if (detail.error) return <div className="page"><ErrorNote error={detail.error} /></div>;
  if (!workspace) return <div className="page"><ErrorNote error={{ code: 'NOT_FOUND', message: 'workspace desconocido' }} /></div>;

  const events = stream.events.length ? stream.events : [];

  return (
    <div className="page wide">
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            {editingTitle === null ? (
              <h2 style={{ marginBottom: 2 }}>
                <button
                  type="button"
                  className="title-edit"
                  title="Cambiar el nombre de este workspace"
                  onClick={() => setEditingTitle(workspace.title ?? '')}
                >
                  {workspace.title ?? 'Sin nombre todavía'}
                </button>
              </h2>
            ) : (
              <form
                className="row"
                style={{ marginBottom: 2 }}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (editingTitle.trim()) rename.mutate(editingTitle.trim());
                  setEditingTitle(null);
                }}
              >
                <input
                  className="input"
                  autoFocus
                  value={editingTitle}
                  aria-label="Nombre del workspace"
                  onChange={(event) => setEditingTitle(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Escape') setEditingTitle(null); }}
                />
                <button type="submit" className="btn small primary">Guardar</button>
              </form>
            )}
            <p className="small muted mono" style={{ margin: 0 }}>
              {workspace.ref.host} · {workspace.ref.provider} · {workspace.ref.sessionId}
              {workspace.cwd ? ` · ${workspace.cwd}` : ''}
            </p>
          </div>
          <div className="row">
            {usage.data ? (
              <span className={`badge ${usage.data.stale ? 'warn' : 'neutral'}`} title={usage.data.refreshError ?? undefined}>
                {usage.data.account?.plan ?? 'cuenta'}
                {usage.data.limits.map((limit) => ` · ${limit.label} ${limit.usedPercent}%`).join('')}
                {usage.data.stale ? ' (viejo)' : ''}
              </span>
            ) : null}
            <Link to={`/terminal?host=${encodeURIComponent(workspace.ref.host)}&provider=${workspace.ref.provider}&sessionId=${encodeURIComponent(workspace.ref.sessionId)}`}
              className="btn small">Terminal</Link>
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div>
          <div className="card">
            <h2>Trabajo</h2>
            {activeRun ? (
              <>
                <div className="row" style={{ marginBottom: 8 }}>
                  <RunStatusBadge status={activeRun.status} />
                  <span className="small muted mono">{activeRun.id.slice(0, 10)}</span>
                  <span className="small muted">{relativeTime(activeRun.startedAt ?? activeRun.createdAt)}</span>
                  <span className="badge neutral">{activeRun.executionHost}</span>
                  {activeRun.strategy === 'A' ? <span className="badge warn">A → {activeRun.workHost}</span> : null}
                  {!stream.connected && !stream.ended ? <span className="badge warn">reconectando…</span> : null}
                  {['queued', 'preparing', 'running', 'waiting'].includes(activeRun.status) ? (
                    <button type="button" className="btn small danger" onClick={() => cancelRun.mutate(activeRun.id)}>
                      Parar
                    </button>
                  ) : null}
                </div>
                <p className="visually-hidden" aria-live="polite">
                  El run {activeRun.id.slice(0, 8)} está {activeRun.status}.
                </p>
                <div className="timeline">
                  {events.map((event) => (
                    <div key={event.seq} className={`event ${eventTone(event.type)}`}>
                      <div className="kind">
                        #{event.seq} · {EVENT_KIND[event.type] ?? event.type}
                        {' · '}{new Date(event.at).toLocaleTimeString()}
                      </div>
                      <pre>{eventText(event)}</pre>
                    </div>
                  ))}
                  {events.length === 0 ? <p className="muted small">Sin eventos todavía.</p> : null}
                </div>
              </>
            ) : (
              <p className="muted small" style={{ margin: 0 }}>
                Aún no has mandado nada en este workspace.
              </p>
            )}
          </div>

          <div className="card composer">
            <h2>Enviar trabajo</h2>
            <div className="target-line">
              <TargetChip target={target.data?.target} />
              {target.isLoading ? <span className="small muted">resolviendo destino…</span> : null}
              {target.error ? <span className="badge danger">destino no disponible</span> : null}
            </div>
            <ErrorNote error={target.error} />
            <label className="stack">
              <span className="small muted">
                Prompt {dirty ? '· guardando borrador…' : detail.data?.draft.version ? '· borrador guardado' : ''}
              </span>
              <textarea
                className="textarea"
                value={body}
                onChange={(event) => onChangeBody(event.target.value)}
                placeholder="Qué quieres que haga el agente…"
                aria-label="Prompt"
              />
            </label>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <label className="row small">
                <span className="muted">Qué puede hacer</span>
                <select className="select control-md" value={profile}
                  onChange={(event) => setProfile(event.target.value as PermissionProfile)}>
                  {PROFILES.map((value) => (
                    <option key={value} value={value}>{PERMISSION[value].name}</option>
                  ))}
                </select>
              </label>
              <button type="button" className="btn primary" disabled={createRun.isPending || !body.trim()}
                onClick={() => void send()}>
                {createRun.isPending ? 'Enviando…' : 'Enviar'}
              </button>
            </div>
            <ErrorNote error={createRun.error} />
            <p className="small muted" style={{ margin: 0 }}>{PERMISSION[profile].help}</p>
          </div>
        </div>

        <div>
          <div className="card">
            <h2>Historial de la sesión</h2>
            <p className="small muted" style={{ marginTop: 0 }}>
              Escrito por el agente en {workspace.ref.host}. Jarvis sólo lo lee.
            </p>
            <StaleNote stale={Boolean(transcript.error)} />
            {transcript.isLoading ? <Loading rows={3} /> : null}
            {transcript.error ? (
              <p className="small muted">El índice no pudo devolver el transcript ahora mismo.</p>
            ) : null}
            <div className="transcript">
              {(transcript.data?.messages ?? []).map((message, index) => (
                <div key={index} className={`message ${message.role}`}>
                  <div className="who">
                    <span>{message.role}</span>
                    <span className="badge neutral">{PROVENANCE[message.provenance] ?? message.provenance}</span>
                    {message.at ? <span>{new Date(message.at).toLocaleString()}</span> : null}
                  </div>
                  <div className="body">{message.text}</div>
                </div>
              ))}
            </div>
          </div>

          <AssistantPanel workspaceId={workspaceId} />

          <div className="card">
            <h2>Runs de este workspace</h2>
            <div className="list">
              {runs.map((run) => (
                <button key={run.id} type="button" className="list-item"
                  aria-current={activeRun?.id === run.id}
                  onClick={() => setPinnedRunId(run.id)}>
                  <span className="row">
                    <RunStatusBadge status={run.status} />
                    <span className="small muted mono">{run.id.slice(0, 8)}</span>
                    <span className="badge neutral">{PERMISSION[run.permissionProfile].name}</span>
                  </span>
                  <span className="small muted">{relativeTime(run.createdAt)}</span>
                </button>
              ))}
              {runs.length === 0 ? <p className="muted small" style={{ margin: 0 }}>Ninguno todavía.</p> : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
