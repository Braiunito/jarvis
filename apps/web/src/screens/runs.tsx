/**
 * Run center: todo el trabajo, esté donde esté.
 *
 * Separa «esperando a alguien» de «todavía trabajando»: no es lo mismo un run que sigue su curso
 * que uno parado esperando una decisión humana.
 */
import type { JSX } from 'react';
import { useState } from 'react';
import { useCancelRun, useRetryRun, useRun, useRuns } from '../api/queries.js';
import { useRunStream } from '../api/run-stream.js';
import { ErrorNote, Empty, Link, Loading, RunStatusBadge, relativeTime } from '../ui/bits.jsx';

export function RunCenterScreen({ runId }: { runId: string | null }): JSX.Element {
  const runs = useRuns();
  const [selected, setSelected] = useState<string | null>(runId);
  const current = selected ?? runId;
  const detail = useRun(current);
  const stream = useRunStream(current);
  const cancel = useCancelRun();
  const retry = useRetryRun();

  const all = runs.data?.runs ?? [];
  const active = all.filter((run) => ['queued', 'preparing', 'running', 'cancelling'].includes(run.status));
  const waiting = all.filter((run) => run.status === 'waiting');
  const done = all.filter((run) => ['completed', 'failed', 'cancelled', 'timed_out'].includes(run.status));

  return (
    <div className="page wide">
      <div className="grid-2">
        <div>
          <div className="card">
            <h2>Activos</h2>
            {runs.isLoading ? <Loading rows={2} /> : null}
            {active.length === 0 && !runs.isLoading ? <p className="muted small" style={{ margin: 0 }}>Nada en marcha.</p> : null}
            <div className="list">
              {active.map((run) => (
                <button key={run.id} type="button" className="list-item" aria-current={current === run.id}
                  onClick={() => setSelected(run.id)}>
                  <span className="row">
                    <RunStatusBadge status={run.status} />
                    <span className="small muted mono">{run.id.slice(0, 8)}</span>
                    <span className="small muted">{run.provider} · {run.executionHost}</span>
                  </span>
                  <span className="small muted">{relativeTime(run.startedAt ?? run.createdAt)}</span>
                </button>
              ))}
            </div>
          </div>

          {waiting.length > 0 ? (
            <div className="card">
              <h2>Esperando intervención</h2>
              <div className="list">
                {waiting.map((run) => (
                  <button key={run.id} type="button" className="list-item" onClick={() => setSelected(run.id)}>
                    <span className="row"><RunStatusBadge status={run.status} /><span className="small">{run.id.slice(0, 8)}</span></span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="card">
            <h2>Recientes</h2>
            {done.length === 0 && !runs.isLoading ? (
              <Empty title="Sin historial todavía" hint="Los runs terminados aparecen aquí con su evidencia." />
            ) : null}
            <div className="list">
              {done.slice(0, 30).map((run) => (
                <button key={run.id} type="button" className="list-item" aria-current={current === run.id}
                  onClick={() => setSelected(run.id)}>
                  <span className="row">
                    <RunStatusBadge status={run.status} />
                    <span className="small muted mono">{run.id.slice(0, 8)}</span>
                    <span className="small muted">{run.provider} · {run.executionHost}</span>
                  </span>
                  <span className="small muted">
                    {relativeTime(run.finishedAt ?? run.createdAt)}
                    {run.errorMessage ? ` · ${run.errorMessage.slice(0, 60)}` : ''}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div>
          <div className="card">
            <h2>Detalle</h2>
            {!current ? <p className="muted small" style={{ margin: 0 }}>Elige un run.</p> : null}
            {detail.data ? (
              <div className="stack">
                <div className="row">
                  <RunStatusBadge status={detail.data.run.status} />
                  <span className="small muted mono">{detail.data.run.id}</span>
                </div>
                <dl className="small" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 10px', margin: 0 }}>
                  <dt className="muted">Ejecuta en</dt><dd style={{ margin: 0 }} className="mono">{detail.data.run.executionHost}</dd>
                  <dt className="muted">Trabaja sobre</dt><dd style={{ margin: 0 }} className="mono">{detail.data.run.workHost}</dd>
                  <dt className="muted">Estrategia</dt><dd style={{ margin: 0 }}>{detail.data.run.strategy}{detail.data.run.strategyReason ? ` · ${detail.data.run.strategyReason}` : ''}</dd>
                  <dt className="muted">Permiso</dt><dd style={{ margin: 0 }}>{detail.data.run.permissionProfile}</dd>
                  <dt className="muted">Creado</dt><dd style={{ margin: 0 }}>{new Date(detail.data.run.createdAt).toLocaleString()}</dd>
                  {detail.data.run.finishedAt ? (<><dt className="muted">Terminado</dt><dd style={{ margin: 0 }}>{new Date(detail.data.run.finishedAt).toLocaleString()}</dd></>) : null}
                  {detail.data.run.errorCode ? (<><dt className="muted">Error</dt><dd style={{ margin: 0 }}>{detail.data.run.errorCode}</dd></>) : null}
                </dl>
                <div className="row">
                  <Link to={`/w/${detail.data.run.workspaceId}`} className="btn small">Ir al workspace</Link>
                  {['queued', 'preparing', 'running', 'waiting'].includes(detail.data.run.status) ? (
                    <button type="button" className="btn small danger" onClick={() => cancel.mutate(detail.data.run.id)}>Parar</button>
                  ) : (
                    <button type="button" className="btn small" onClick={() => retry.mutate(detail.data.run.id)}>Reintentar</button>
                  )}
                </div>
                <ErrorNote error={cancel.error ?? retry.error} />
                <div className="timeline">
                  {stream.events.map((event) => (
                    <div key={event.seq} className="event">
                      <div className="kind">#{event.seq} · {event.type}</div>
                      <pre>{JSON.stringify(event.payload).slice(0, 500)}</pre>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
