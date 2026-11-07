/**
 * Trabajo: todo lo que se ha mandado desde Jarvis, esté en la sesión que esté.
 *
 * Una lista y su detalle. El filtro separa «en marcha» de «necesita que mires», que no son lo
 * mismo: mezclarlos hace que lo segundo pase desapercibido, que es justo lo que hay que mirar.
 * Lo que había además —cifras de 24 h, la cuota, una explicación plegada, filtros por agente,
 * máquina y fecha— se quitó: estaba en otra parte o no se usaba.
 */
import type { JSX } from 'react';
import { useState } from 'react';
import type { Run } from '@jarvis/contracts';
import {
  useAcknowledgeRun, useCancelRun, useRetryRun, useRun, useRuns,
} from '../api/queries.js';
import { useRunStream } from '../api/run-stream.js';
import { Empty, ErrorNote, Link, Loading, RunStatusBadge, relativeTime } from '../ui/bits.jsx';
import { PERMISSION, RUN_STATUS, isRunLive, runTitle } from '../ui/labels.js';
import {
  ACTION_ICON, Glyph, NAV_ICON, PERMISSION_ICON, RUN_STATUS_ICON,
} from '../ui/icons.jsx';
import { usePageMeta } from '../ui/page-meta.jsx';
import { Card, DataRow, Segmented, formatDuration } from '../ui/primitives.jsx';
import { EventTimeline } from '../ui/event-log.jsx';
import { folderName } from './explorer.jsx';

type Filter = 'todos' | 'activos' | 'atencion';

const ACTIVE = ['queued', 'preparing', 'running', 'cancelling'];
const ATTENTION = ['waiting', 'failed', 'timed_out'];

const duration = (run: Run): number | null =>
  run.startedAt && run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null;

export function RunCenterScreen({ runId }: { runId: string | null }): JSX.Element {
  usePageMeta({ title: 'Trabajo' });

  const runs = useRuns();
  const [selected, setSelected] = useState<string | null>(runId);
  const [filter, setFilter] = useState<Filter>('todos');
  // Cerrar la hoja tiene que poder ganarle también al id que viene en la URL: si no, en estrecho
  // el detalle se queda abierto y no hay forma de volver a la lista sin navegar a otro sitio.
  const [cerrado, setCerrado] = useState(false);
  const current = cerrado ? null : (selected ?? runId);
  const acknowledge = useAcknowledgeRun();

  const all = runs.data?.runs ?? [];
  const active = all.filter((run) => ACTIVE.includes(run.status));
  const attention = all.filter((run) => ATTENTION.includes(run.status) && !run.acknowledgedAt);
  const visible = filter === 'activos' ? active : filter === 'atencion' ? attention : all;

  const close = (): void => { setSelected(null); setCerrado(true); };

  return (
    <div className="page">
      <div className="toolbar">
        <Segmented<Filter>
          label="Qué trabajos se enseñan"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'todos', label: `Todos ${all.length}` },
            { value: 'activos', label: `En marcha ${active.length}` },
            { value: 'atencion', label: `Atención ${attention.length}`, ...(attention.length ? { tone: 'danger' as const } : {}) },
          ]}
        />
        <span className="grow" />
        {/*
          * Dar por visto no arregla nada ni cambia el trabajo: sólo deja de reclamar. Sin esto,
          * cuatro fallos de la semana pasada dejaban el aviso encendido para siempre.
          */}
        {attention.length ? (
          <button type="button" className="btn small ghost" disabled={acknowledge.isPending}
            onClick={() => acknowledge.mutate(null)}>
            <Glyph icon={ACTION_ICON.approve} />
            {acknowledge.isPending ? 'Marcando…' : 'Dar todos por vistos'}
          </button>
        ) : null}
      </div>

      <div className="grid main-side">
        <div className="run-list">
          {runs.isLoading ? <Loading rows={4} shape="list" label="Cargando los trabajos…" /> : null}
          <ErrorNote error={runs.error} onRetry={() => void runs.refetch()} />

          {!runs.isLoading && visible.length === 0 ? (
            filter === 'todos' ? (
              <Empty
                icon={NAV_ICON.runs}
                title="Todavía no se ha mandado nada"
                hint="Lo que mandes desde una sesión queda aquí: dónde corrió, con qué permiso y qué dijo."
                action={<Link to="/" className="btn primary">Ir a Sesiones</Link>}
              />
            ) : (
              <Empty icon={ACTION_ICON.filter} title="Nada aquí"
                action={<button type="button" className="btn" onClick={() => setFilter('todos')}>Ver todos</button>} />
            )
          ) : null}

          {visible.slice(0, 60).map((item) => {
            const tone = RUN_STATUS[item.status].tone;
            return (
              <button key={item.id} type="button" className="run-row"
                aria-current={current === item.id}
                onClick={() => { setSelected(item.id); setCerrado(false); }}>
                <span className={`turn-status ${tone}`} title={RUN_STATUS[item.status].name}>
                  <Glyph icon={RUN_STATUS_ICON[item.status]} size={15} className={item.status === 'running' ? 'spin' : undefined} />
                  <span className="visually-hidden">{RUN_STATUS[item.status].name}</span>
                </span>
                <span className="run-row-main">
                  <span className="run-row-title truncate" title={item.promptPreview ?? undefined}>{runTitle(item)}</span>
                  <span className="run-row-sub truncate">
                    {folderName(item.cwd)} · {item.executionHost} · {item.provider}
                    {duration(item) !== null ? ` · ${formatDuration(duration(item))}` : ''}
                  </span>
                </span>
                <span className="tiny faint nowrap">
                  {relativeTime(item.finishedAt ?? item.startedAt ?? item.createdAt)}
                </span>
              </button>
            );
          })}
        </div>

        {current ? (
          <button type="button" className="detail-sheet-backdrop" aria-label="Cerrar el detalle" onClick={close} />
        ) : null}
        <RunDetail runId={current} onClose={close} />
      </div>
    </div>
  );
}

function RunDetail({ runId, onClose }: { runId: string | null; onClose: () => void }): JSX.Element {
  const detail = useRun(runId);
  const stream = useRunStream(runId);
  const cancel = useCancelRun();
  const retry = useRetryRun();
  const acknowledge = useAcknowledgeRun();
  const run = detail.data?.run;

  if (!run) {
    return (
      <Card className="detail-sheet">
        <p className="small muted" style={{ margin: 0 }}>
          {runId ? 'Cargando…' : 'Elige un trabajo para ver qué hizo.'}
        </p>
      </Card>
    );
  }

  return (
    <Card className="detail-sheet is-open">
      <div className="stack">
        <div className="spread" style={{ alignItems: 'flex-start' }}>
          <p className="run-detail-title">{runTitle(run, 200)}</p>
          <button type="button" className="btn small icon ghost" onClick={onClose} aria-label="Cerrar el detalle">
            <Glyph icon={ACTION_ICON.reject} />
          </button>
        </div>

        <div className="row">
          <RunStatusBadge status={run.status} />
          <span className={`badge ${PERMISSION[run.permissionProfile].tone}`}>
            <Glyph icon={PERMISSION_ICON[run.permissionProfile]} size={13} />
            {PERMISSION[run.permissionProfile].name}
          </span>
        </div>

        <div className="row">
          <Link to={`/w/${run.workspaceId}`} className="btn small primary">
            <Glyph icon={ACTION_ICON.open} />
            Ir a la sesión
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
          {ATTENTION.includes(run.status) && !run.acknowledgedAt ? (
            <button type="button" className="btn small ghost" title="Dejar de reclamar atención. El trabajo no cambia."
              onClick={() => acknowledge.mutate(run.id)}>
              <Glyph icon={ACTION_ICON.approve} />
              Visto
            </button>
          ) : null}
        </div>
        <ErrorNote error={cancel.error ?? retry.error ?? acknowledge.error} onRetry={() => void detail.refetch()} />

        <details className="facts-fold">
          <summary className="small muted">Dónde y cómo</summary>
          <div className="stack" style={{ gap: 6, marginTop: 8 }}>
            <DataRow label="Carpeta"><span className="mono">{run.cwd ?? '—'}</span></DataRow>
            <DataRow label="Ejecuta en"><span className="mono">{run.executionHost}</span></DataRow>
            {run.strategy === 'A' ? <DataRow label="Trabaja sobre"><span className="mono">{run.workHost}</span></DataRow> : null}
            <DataRow label="Empezó">{relativeTime(run.startedAt ?? run.createdAt)}</DataRow>
            <DataRow label="Duró">{formatDuration(duration(run))}</DataRow>
            {run.errorCode ? <DataRow label="Error"><span className="badge danger">{run.errorCode}</span></DataRow> : null}
            <DataRow label="Id"><span className="mono">{run.id}</span></DataRow>
            {run.strategyReason ? <p className="tiny faint" style={{ margin: 0 }}>{run.strategyReason}</p> : null}
          </div>
        </details>

        {/*
          * Lo pedido no se repite: es el título de arriba.
          *
          * La `key` hace que cambiar de trabajo empiece de cero: compacto y todo plegado. Los tramos
          * se reconocen por su `seq`, que vuelve a 0 en cada trabajo, y sin ella se desplegaba un
          * tramo por parecerse al que se abrió en el anterior.
          */}
        <EventTimeline key={run.id} events={stream.events} limit={40}
          live={isRunLive(run.status)}
          empty="Este trabajo no llegó a dejar ningún evento. Si terminó mal, el detalle está en su código de error." />
      </div>
    </Card>
  );
}
