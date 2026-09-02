import type { JSX } from 'react';
/**
 * Command center: dónde estaba el trabajo, qué está pasando ahora y qué está roto.
 */
import { useHealth, useRuns, useWorkspaces } from '../api/queries.js';
import { Empty, Link, Loading, RunStatusBadge, relativeTime } from '../ui/bits.jsx';
import type { Health } from '@jarvis/contracts';

function healthTone(status: Health['status']): string {
  return status === 'ok' ? 'ok' : status === 'degraded' ? 'warn' : 'danger';
}

export function HomeScreen(): JSX.Element {
  const workspaces = useWorkspaces();
  const runs = useRuns();
  const health = useHealth();

  const active = (runs.data?.runs ?? []).filter((run) =>
    ['queued', 'preparing', 'running', 'waiting', 'cancelling'].includes(run.status));
  const attention = (runs.data?.runs ?? []).filter((run) =>
    run.status === 'failed' || run.status === 'timed_out');

  return (
    <div className="page">
      <div className="grid-2">
        <div>
          <div className="card">
            <h2>Trabajo en curso</h2>
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
              <h2>Requieren atención</h2>
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
            <h2>Workspaces recientes</h2>
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
            <h2>Salud</h2>
            {health.isLoading ? <Loading rows={2} /> : null}
            {health.data ? (
              <>
                <p className="row" style={{ marginTop: 0 }}>
                  <span className={`badge ${healthTone(health.data.status)}`}>
                    <span className="dot" aria-hidden="true" />{health.data.status}
                  </span>
                  <span className="small muted">core {health.data.version}</span>
                </p>
                <div className="list">
                  {Object.entries(health.data.checks).map(([name, check]) => (
                    <div key={name} className="list-item" style={{ cursor: 'default' }}>
                      <span className="row">
                        <span className={`badge ${check.status === 'ok' ? 'ok' : check.status === 'failed' ? 'danger' : 'warn'}`}>
                          <span className="dot" aria-hidden="true" />{check.status}
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
