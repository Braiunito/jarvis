/**
 * Trabajo: todo lo que se ha mandado, esté donde esté.
 *
 * Separa «esperando a alguien» de «todavía trabajando»: no es lo mismo un trabajo que sigue su
 * curso que uno parado esperando una decisión humana, y mezclarlos hace que el segundo pase
 * desapercibido, que es justo el que hay que mirar.
 *
 * La lista es una tabla porque aquí se compara —qué agente, qué máquina, cuánto tardó—, y el
 * detalle vive al lado para no perder de vista el resto mientras se lee uno.
 */
import type { JSX } from 'react';
import { useState } from 'react';
import type { Run } from '@jarvis/contracts';
import { useCancelRun, useMetrics, useRetryRun, useRun, useRuns } from '../api/queries.js';
import { useRunStream } from '../api/run-stream.js';
import { Empty, ErrorNote, Link, Loading, RunStatusBadge, relativeTime } from '../ui/bits.jsx';
import { Sparkbars } from '../ui/charts.jsx';
import { PERMISSION, RUN_STATUS } from '../ui/labels.js';
import {
  ACTION_ICON, Glyph, NAV_ICON, PERMISSION_ICON, PROVIDER_ICON, STATUS_ICON,
} from '../ui/icons.jsx';
import { usePageMeta } from '../ui/page-meta.jsx';
import { Card, DataRow, Stat, Tabs, formatDuration } from '../ui/primitives.jsx';
import { EventTimeline } from '../ui/event-log.jsx';

type Filter = 'activos' | 'atencion' | 'terminados' | 'todos';

const ACTIVE = ['queued', 'preparing', 'running', 'cancelling'];
const ATTENTION = ['waiting', 'failed', 'timed_out'];

const duration = (run: Run): number | null =>
  run.startedAt && run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null;

export function RunCenterScreen({ runId }: { runId: string | null }): JSX.Element {
  usePageMeta({ title: 'Trabajo', subtitle: 'Lo que se ha mandado a los agentes y cómo acabó' });

  const runs = useRuns();
  const metrics = useMetrics(24);
  const [selected, setSelected] = useState<string | null>(runId);
  const [filter, setFilter] = useState<Filter>('todos');
  const current = selected ?? runId;
  const detail = useRun(current);
  const stream = useRunStream(current);
  const cancel = useCancelRun();
  const retry = useRetryRun();

  const all = runs.data?.runs ?? [];
  const active = all.filter((run) => ACTIVE.includes(run.status));
  const attention = all.filter((run) => ATTENTION.includes(run.status));

  const visible = filter === 'activos' ? active
    : filter === 'atencion' ? attention
      : filter === 'terminados' ? all.filter((run) => ['completed', 'cancelled'].includes(run.status))
        : all;

  const run = detail.data?.run;

  return (
    <div className="page">
      {/* Cuánto trabajo hay y en qué forma llega: el contexto antes de bajar a una fila. */}
      <div className="grid cols-4">
        <Card>
          <Stat value={active.length} label="en marcha"
            hint={active.length ? 'se están ejecutando ahora' : 'nada corriendo'} />
        </Card>
        <Card>
          <Stat value={attention.length} label="requieren que mires"
            hint={attention.length ? 'parados, fallados o sin tiempo' : 'ninguno pendiente'} />
        </Card>
        <Card>
          <Stat
            value={metrics.data ? formatDuration(metrics.data.runs.medianDurationMs) : '—'}
            label="duración típica"
            hint="mediana de las últimas 24 h"
          />
        </Card>
        <Card>
          <Stat value={metrics.data?.runs.total ?? all.length} label="trabajos en 24 h"
            {...(metrics.data ? { delta: metrics.data.runs.deltaPercent } : {})} />
          {metrics.data ? (
            <Sparkbars
              label="Trabajos por intervalo en las últimas 24 horas"
              points={metrics.data.runs.buckets.map((bucket) => ({
                at: bucket.at, value: bucket.runs, failed: bucket.failed,
              }))}
            />
          ) : null}
        </Card>
      </div>

      <div className="grid main-side">
        <Card className="flush">
          <div style={{ padding: '12px 14px 0' }}>
            <Tabs
              label="Qué trabajos se enseñan"
              active={filter}
              onChange={(id) => setFilter(id as Filter)}
              tabs={[
                { id: 'todos', label: 'Todos', icon: NAV_ICON.runs, count: all.length },
                { id: 'activos', label: 'En marcha', icon: STATUS_ICON.activity, count: active.length },
                { id: 'atencion', label: 'Requieren atención', icon: ACTION_ICON.error, count: attention.length },
                { id: 'terminados', label: 'Terminados', icon: ACTION_ICON.approve },
              ]}
            />
          </div>

          {runs.isLoading ? (
            <div style={{ padding: 14 }}>
              <Loading rows={4} shape="table" label="Cargando los trabajos…" />
            </div>
          ) : null}

          {!runs.isLoading && visible.length === 0 ? (
            filter === 'todos' ? (
              <Empty
                icon={NAV_ICON.runs}
                title="Todavía no se ha mandado nada"
                hint="El trabajo se manda desde un workspace, y aquí queda todo junto: dónde corrió, con qué permiso y qué dijo."
                action={
                  <Link to="/sessions" className="btn primary">
                    <Glyph icon={NAV_ICON.sessions} />
                    Elegir una sesión y empezar
                  </Link>
                }
              />
            ) : (
              <Empty
                icon={ACTION_ICON.filter}
                title="Nada en esta pestaña"
                hint={`Hay ${all.length} trabajo${all.length === 1 ? '' : 's'} en total, pero ninguno en este estado.`}
                action={
                  <button type="button" className="btn" onClick={() => setFilter('todos')}>
                    Ver todos
                  </button>
                }
              />
            )
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Trabajo</th>
                    <th>Agente y máquina</th>
                    <th>Permiso</th>
                    <th>Duración</th>
                    <th>Cuándo</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.slice(0, 60).map((item) => (
                    <tr key={item.id} aria-selected={current === item.id} tabIndex={0}
                      onClick={() => setSelected(item.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelected(item.id);
                        }
                      }}>
                      <td>
                        <div className="lead">
                          <span className={`lead-mark ${ATTENTION.includes(item.status) ? 'danger' : ACTIVE.includes(item.status) ? 'accent' : ''}`}>
                            <Glyph icon={PROVIDER_ICON[item.provider] ?? NAV_ICON.runs} size={15} />
                          </span>
                          <span className="cell-main">
                            <RunStatusBadge status={item.status} />
                            <span className="tiny faint mono truncate">{item.id.slice(0, 12)}</span>
                          </span>
                        </div>
                      </td>
                      <td data-secondary="true">
                        <span className="small">{item.provider} · {item.executionHost}</span>
                        {item.strategy === 'A' ? (
                          <span className="tiny faint"> → {item.workHost}</span>
                        ) : null}
                      </td>
                      <td className="optional">
                        <span className={`badge ${PERMISSION[item.permissionProfile].tone}`}>
                          <Glyph icon={PERMISSION_ICON[item.permissionProfile]} size={13} />
                          {PERMISSION[item.permissionProfile].name}
                        </span>
                      </td>
                      <td className="optional">
                        <span className="small muted">{formatDuration(duration(item))}</span>
                      </td>
                      <td data-secondary="true">
                        <span className="small muted">{relativeTime(item.finishedAt ?? item.startedAt ?? item.createdAt)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title={run ? 'Detalle del trabajo' : 'Nada seleccionado'} icon={ACTION_ICON.session}>
          {!run ? (
            <p className="small muted" style={{ margin: 0 }}>
              Elige un trabajo de la lista para ver dónde corrió, con qué permiso y qué dijo.
            </p>
          ) : (
            <div className="stack">
              <div className="row">
                <RunStatusBadge status={run.status} />
                <span className="tiny faint mono truncate">{run.id}</span>
              </div>
              <p className="tiny faint" style={{ margin: 0 }}>{RUN_STATUS[run.status].help}</p>

              <div className="row">
                <Link to={`/w/${run.workspaceId}`} className="btn small">
                  <Glyph icon={ACTION_ICON.open} />
                  Ir al workspace
                </Link>
                {['queued', 'preparing', 'running', 'waiting'].includes(run.status) ? (
                  <button type="button" className="btn small danger" onClick={() => cancel.mutate(run.id)}>
                    <Glyph icon={ACTION_ICON.stop} />
                    Parar
                  </button>
                ) : (
                  <button type="button" className="btn small" onClick={() => retry.mutate(run.id)}>
                    <Glyph icon={ACTION_ICON.retry} />
                    Reintentar
                  </button>
                )}
              </div>
              <ErrorNote error={cancel.error ?? retry.error} onRetry={() => void detail.refetch()} />

              <div className="stack" style={{ gap: 7 }}>
                <DataRow label="Ejecuta en"><span className="mono">{run.executionHost}</span></DataRow>
                <DataRow label="Trabaja sobre"><span className="mono">{run.workHost}</span></DataRow>
                <DataRow label="Cómo">
                  {run.strategy === 'A' ? 'desde el bastión, por ssh' : 'en la propia máquina'}
                </DataRow>
                <DataRow label="Podía">
                  <span className={`badge ${PERMISSION[run.permissionProfile].tone}`}>
                    <Glyph icon={PERMISSION_ICON[run.permissionProfile]} size={13} />
                    {PERMISSION[run.permissionProfile].name}
                  </span>
                </DataRow>
                <DataRow label="Empezó">{relativeTime(run.startedAt ?? run.createdAt)}</DataRow>
                <DataRow label="Duró">{formatDuration(duration(run))}</DataRow>
                {run.errorCode ? (
                  <DataRow label="Error">
                    <span className="badge danger">{run.errorCode}</span>
                  </DataRow>
                ) : null}
              </div>

              {run.strategyReason ? (
                <p className="tiny faint" style={{ margin: 0 }}>{run.strategyReason}</p>
              ) : null}

              <div>
                <p className="small muted" style={{ margin: '0 0 8px' }}>
                  Eventos {stream.connected ? '· en directo' : stream.ended ? '· cerrado' : '· reconectando…'}
                </p>
                <EventTimeline events={stream.events} limit={40}
                  empty="Este trabajo no llegó a dejar ningún evento. Si terminó mal, el detalle está en su código de error." />
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
