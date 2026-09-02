import type { JSX } from 'react';
/**
 * Command center: dónde estaba el trabajo, qué está pasando ahora y qué está roto.
 */
import { useHealth, useRuns, useWorkspaces } from '../api/queries.js';
import { Empty, Link, Loading, RunStatusBadge, relativeTime } from '../ui/bits.jsx';
import { ACTION_ICON, Glyph, HEALTH_ICON, NAV_ICON } from '../ui/icons.jsx';
import { HEALTH } from '../ui/labels.js';
import type { Health } from '@jarvis/contracts';

function healthTone(status: Health['status']): string {
  return status === 'ok' ? 'ok' : status === 'degraded' ? 'warn' : 'danger';
}

/** El resumen de arriba: una palabra que se lee de lejos. */
const HEALTH_SUMMARY: Record<Health['status'], string> = {
  ok: 'todo bien',
  degraded: 'algo a medias',
  failed: 'algo caído',
};

export function HomeScreen(): JSX.Element {
  const workspaces = useWorkspaces();
  const runs = useRuns();
  const health = useHealth();

  const active = (runs.data?.runs ?? []).filter((run) =>
    ['queued', 'preparing', 'running', 'waiting', 'cancelling'].includes(run.status));
  const attention = (runs.data?.runs ?? []).filter((run) =>
    run.status === 'failed' || run.status === 'timed_out');

  const last = workspaces.data?.workspaces[0];

  return (
    <div className="page">
      {last ? (
        <Link to={`/w/${last.id}`} className="card resume" style={{ textDecoration: 'none', color: 'inherit', marginBottom: 12 }}>
          <span className="small muted row" style={{ gap: 6 }}>
            <Glyph icon={ACTION_ICON.go} />
            Seguir donde lo dejaste
          </span>
          <span className="resume-title">{last.title ?? last.ref.sessionId}</span>
          <span className="small muted">
            {last.ref.provider} · {last.ref.host}
            {last.cwd ? ` · ${last.cwd}` : ''} · {relativeTime(last.lastOpenedAt)}
          </span>
        </Link>
      ) : null}

      <div className="grid-2">
        <div>
          <div className="card">
            <h2 className="row" style={{ gap: 7 }}>
              <Glyph icon={NAV_ICON.runs} size={16} />
              Trabajo en curso
            </h2>
            {runs.isLoading ? <Loading rows={2} /> : null}
            {!runs.isLoading && active.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>Nada ejecutándose ahora mismo.</p>
            ) : null}
            <div className="list">
              {active.map((run) => (
                <Link key={run.id} to={`/runs/${run.id}`} className="list-item" style={{ display: 'grid', textDecoration: 'none', color: 'inherit' }}>
                  <span className="row">
                    <RunStatusBadge status={run.status} />
                    <span className="small muted">{run.provider} · {run.executionHost}</span>
                  </span>
                  <span className="small muted">iniciado {relativeTime(run.startedAt ?? run.createdAt)}</span>
                </Link>
              ))}
            </div>
          </div>

          {attention.length > 0 ? (
            <div className="card">
              <h2 className="row" style={{ gap: 7, color: 'var(--danger)' }}>
                <Glyph icon={ACTION_ICON.error} size={16} />
                Requieren atención
              </h2>
              <div className="list">
                {attention.slice(0, 5).map((run) => (
                  <Link key={run.id} to={`/runs/${run.id}`} className="list-item" style={{ display: 'grid', textDecoration: 'none', color: 'inherit' }}>
                    <span className="row">
                      <RunStatusBadge status={run.status} />
                      <span className="small">{run.errorMessage ?? run.errorCode ?? 'sin detalle'}</span>
                    </span>
                    <span className="small muted">{relativeTime(run.finishedAt)}</span>
                  </Link>
                ))}
              </div>
            </div>
          ) : null}

          <div className="card">
            <h2 className="row" style={{ gap: 7 }}>
              <Glyph icon={ACTION_ICON.open} size={16} />
              Workspaces recientes
            </h2>
            {workspaces.isLoading ? <Loading /> : null}
            {!workspaces.isLoading && (workspaces.data?.workspaces ?? []).length === 0 ? (
              <Empty title="Todavía no has abierto ninguna sesión"
                hint="Busca una en el explorador y ábrela: el workspace es lo que conserva su contexto." />
            ) : null}
            <div className="list">
              {(workspaces.data?.workspaces ?? []).map((workspace) => (
                <Link key={workspace.id} to={`/w/${workspace.id}`} className="list-item" style={{ display: 'grid', textDecoration: 'none', color: 'inherit' }}>
                  <span className="title">{workspace.title ?? workspace.ref.sessionId}</span>
                  <span className="small muted">
                    {workspace.ref.provider} · {workspace.ref.host}
                    {workspace.cwd ? ` · ${workspace.cwd}` : ''} · abierto {relativeTime(workspace.lastOpenedAt)}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </div>

        <div>
          <div className="card">
            <h2 className="row" style={{ gap: 7 }}>
              <Glyph icon={NAV_ICON.health} size={16} />
              Salud
            </h2>
            {health.isLoading ? <Loading rows={2} /> : null}
            {health.data ? (
              <>
                <p className="row" style={{ marginTop: 0 }}>
                  <span className={`badge ${healthTone(health.data.status)}`}>
                    <Glyph icon={HEALTH_ICON[health.data.status] ?? HEALTH_ICON['unknown'] as never} />
                    {HEALTH_SUMMARY[health.data.status]}
                  </span>
                  <span className="small muted">core {health.data.version}</span>
                </p>
                <div className="list">
                  {Object.entries(health.data.checks).map(([name, check]) => (
                    <div key={name} className="list-item" style={{ cursor: 'default' }}>
                      <span className="row">
                        <span className={`badge ${HEALTH[check.status]?.tone ?? 'neutral'}`}>
                          <Glyph icon={HEALTH_ICON[check.status] ?? HEALTH_ICON['unknown'] as never} size={13} />
                          {HEALTH[check.status]?.name ?? check.status}
                        </span>
                        <span className="small mono">{name}</span>
                      </span>
                      {check.message ? <span className="small muted">{check.message}</span> : null}
                    </div>
                  ))}
                </div>
                <p style={{ marginBottom: 0 }}><Link to="/health">Ver diagnóstico completo</Link></p>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
