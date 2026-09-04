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
import { useMemo, useState } from 'react';
import type { Run } from '@jarvis/contracts';
import {
  useAcknowledgeRun, useCancelRun, useMetrics, useRetryRun, useRun, useRuns,
} from '../api/queries.js';
import { useRunStream } from '../api/run-stream.js';
import { Empty, ErrorNote, Link, Loading, RunStatusBadge, relativeTime } from '../ui/bits.jsx';
import { Meter, Sparkbars } from '../ui/charts.jsx';
import {
  PERMISSION, RUN_STATUS, isRunLive, runTitle, USAGE_LOW_PERCENT, usageWindowName,
} from '../ui/labels.js';
import {
  ACTION_ICON, Glyph, NAV_ICON, PERMISSION_ICON, PROVIDER_ICON, STATUS_ICON,
} from '../ui/icons.jsx';
import { usePageMeta } from '../ui/page-meta.jsx';
import { Card, DataRow, Stat, Tabs, formatDuration } from '../ui/primitives.jsx';
import { EventTimeline } from '../ui/event-log.jsx';

type Filter = 'activos' | 'atencion' | 'terminados' | 'todos';

/*
 * Ventanas de tiempo, en días. Son las que se piden de verdad al mirar trabajo:
 * «lo de hoy», «esta semana». Una fecha exacta no la busca nadie aquí; para eso
 * está el identificador.
 */
type Recencia = 'hoy' | '3d' | '7d' | 'todo';
const RECENCIA_LABEL: Record<Recencia, string> = {
  hoy: 'Hoy',
  '3d': 'Últimos 3 días',
  '7d': 'Última semana',
  todo: 'Todo',
};
const RECENCIA_DIAS: Record<Exclude<Recencia, 'todo'>, number> = { hoy: 1, '3d': 3, '7d': 7 };

const ACTIVE = ['queued', 'preparing', 'running', 'cancelling'];
const ATTENTION = ['waiting', 'failed', 'timed_out'];

const duration = (run: Run): number | null =>
  run.startedAt && run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null;

export function RunCenterScreen({ runId }: { runId: string | null }): JSX.Element {
  usePageMeta({
    title: 'Trabajo',
    subtitle: 'Cada cosa que has mandado ejecutar: dónde corrió, con qué permiso y qué dijo',
  });

  const runs = useRuns();
  const metrics = useMetrics(24);
  const [selected, setSelected] = useState<string | null>(runId);
  const [filter, setFilter] = useState<Filter>('todos');
  // Los mismos ejes que en Sesiones: con muchos trabajos, «todos» no sirve de
  // nada si no se puede recortar por quién lo hizo, dónde y cuándo.
  const [provider, setProvider] = useState('');
  const [host, setHost] = useState('');
  const [recencia, setRecencia] = useState<Recencia>('todo');
  // Cerrar la hoja tiene que poder ganarle también al id que viene en la URL: si
  // no, en estrecho el detalle se queda abierto y no hay forma de volver a la
  // lista sin navegar a otro sitio.
  const [cerrado, setCerrado] = useState(false);
  const current = cerrado ? null : (selected ?? runId);
  const detail = useRun(current);
  const stream = useRunStream(current);
  const cancel = useCancelRun();
  const retry = useRetryRun();
  const acknowledge = useAcknowledgeRun();

  const all = runs.data?.runs ?? [];
  const active = all.filter((run) => ACTIVE.includes(run.status));
  const attention = all.filter((run) => ATTENTION.includes(run.status) && !run.acknowledgedAt);

  const hosts = useMemo(() => [...new Set(all.map((run) => run.executionHost))].sort(), [all]);
  const providers = useMemo(() => [...new Set(all.map((run) => run.provider))].sort(), [all]);

  // Se aplica DESPUÉS de la pestaña de estado: la pestaña dice qué clase de
  // trabajo se mira y estos recortan dentro de esa clase.
  const recorta = (rows: Run[]): Run[] => rows.filter((run) => {
    if (provider && run.provider !== provider) return false;
    if (host && run.executionHost !== host) return false;
    if (recencia !== 'todo') {
      const desde = Date.now() - RECENCIA_DIAS[recencia] * 24 * 60 * 60 * 1000;
      if (new Date(run.createdAt).getTime() < desde) return false;
    }
    return true;
  });

  const visible = recorta(
    filter === 'activos' ? active
      : filter === 'atencion' ? attention
        : filter === 'terminados' ? all.filter((run) => ['completed', 'cancelled'].includes(run.status))
          : all,
  );
  const recortando = Boolean(provider || host || recencia !== 'todo');

  const run = detail.data?.run;
  // La cuenta que primero va a molestar: las métricas ya las devuelven ordenadas.
  const tightest = metrics.data?.usage?.[0];

  return (
    <div className="page">
      {/*
        * Sesión y trabajo se confunden, y con razón: los dos son «una conversación con un agente».
        * La diferencia es de quién es cada cosa y dónde vive, y decirla una vez aquí ahorra
        * explicarla cada vez que alguien pregunta qué está mirando. Va plegado porque el que ya lo
        * sabe no necesita leerlo cada visita.
        */}
      <details className="explainer">
        <summary>¿Qué es un trabajo, y en qué se diferencia de una sesión?</summary>
        <div className="explainer-body">
          <p>
            Una <strong>sesión</strong> vive en la máquina. La crea el agente —Claude, Codex,
            OpenCode— la primera vez que alguien habla con él, sigue existiendo aunque Jarvis esté
            apagado, y se puede continuar desde la terminal sin pasar por aquí. Las tienes en{' '}
            <Link to="/sessions">Sesiones</Link>.
          </p>
          <p>
            Un <strong>trabajo</strong> es una ejecución que lanzaste tú desde Jarvis sobre una de
            esas sesiones. Tiene destino (en qué máquina corrió), permiso (qué podía tocar), una
            línea de eventos y un resultado. Vive en Jarvis, no en la máquina, y es lo que se puede
            parar, reintentar y auditar.
          </p>
          <p className="small muted">
            Una sesión puede tener muchos trabajos; un trabajo pertenece siempre a una sesión. En
            esta pantalla están los de todas las sesiones, ordenados por cuándo pasaron; dentro de
            un workspace, sólo los suyos.
          </p>
        </div>
      </details>

      {/* Cuánto trabajo hay y en qué forma llega: el contexto antes de bajar a una fila. */}
      <div className="grid cols-4">
        <Card>
          <Stat value={active.length} label="en marcha"
            hint={active.length ? 'se están ejecutando ahora' : 'nada corriendo'} />
        </Card>
        <Card>
          <Stat value={attention.length} label="requieren que mires"
            hint={attention.length ? 'parados, fallados o sin tiempo' : 'ninguno pendiente'} />
          {/*
            * Dar por visto no arregla nada ni cambia el estado del trabajo: sólo deja de reclamar.
            * Sin esto, cuatro fallos de la semana pasada dejaban el aviso encendido para siempre y
            * el número acababa siendo ruido de fondo.
            */}
          {attention.length ? (
            <button type="button" className="btn small" style={{ marginTop: 10 }}
              disabled={acknowledge.isPending}
              onClick={() => acknowledge.mutate(null)}>
              <Glyph icon={ACTION_ICON.approve} />
              {acknowledge.isPending ? 'Marcando…' : 'Dar todos por vistos'}
            </button>
          ) : null}
        </Card>
        <Card>
          {/*
            * Aquí también se decide lanzar: se reintenta un trabajo fallido y se manda otro. Saber
            * que a la cuenta le queda un 8% después de pulsar es enterarse tarde, así que la
            * ventana más apretada de la flota ocupa el sitio de la duración típica cuando está
            * baja; si va sobrada, manda la duración, que es lo que se mira el resto del tiempo.
            */}
          {tightest && tightest.remainingPercent <= USAGE_LOW_PERCENT ? (
            <>
              <Stat
                value={`${tightest.remainingPercent}%`}
                label={`de ${usageWindowName(tightest.label)} en ${tightest.provider}`}
                hint={`${tightest.executionHost}${tightest.stale ? ' · último dato bueno' : ''}`}
              />
              <Meter value={tightest.remainingPercent} max={100} tone="danger" />
            </>
          ) : (
            <Stat
              value={metrics.data ? formatDuration(metrics.data.runs.medianDurationMs) : '—'}
              label="duración típica"
              hint={tightest
                ? `mediana de 24 h · cuota más justa ${tightest.remainingPercent}% (${tightest.provider})`
                : 'mediana de las últimas 24 h'}
            />
          )}
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

            {/* Los mismos ejes que en Sesiones. Van debajo de las pestañas porque
                la pestaña elige QUÉ clase de trabajo se mira y esto recorta dentro. */}
            <div className="row" style={{ flexWrap: 'wrap', gap: 8, padding: '10px 0 2px' }}>
              <label className="row small">
                <span className="muted">Agente</span>
                <select className="select control-sm" value={provider}
                  onChange={(event) => setProvider(event.target.value)}>
                  <option value="">Todos</option>
                  {providers.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </label>

              <label className="row small">
                <span className="muted">Host</span>
                <select className="select control-sm" value={host}
                  onChange={(event) => setHost(event.target.value)}>
                  <option value="">Todos</option>
                  {hosts.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </label>

              <label className="row small">
                <span className="muted">Cuándo</span>
                <select className="select control-md" value={recencia}
                  onChange={(event) => setRecencia(event.target.value as Recencia)}>
                  {Object.entries(RECENCIA_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>

              {recortando ? (
                <button type="button" className="btn small ghost"
                  onClick={() => { setProvider(''); setHost(''); setRecencia('todo'); }}>
                  <Glyph icon={ACTION_ICON.reject} />
                  Quitar filtros
                </button>
              ) : null}
            </div>
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
                      onClick={() => { setSelected(item.id); setCerrado(false); }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelected(item.id);
                          setCerrado(false);
                        }
                      }}>
                      <td>
                        <div className="lead">
                          <span className={`lead-mark ${ATTENTION.includes(item.status) ? 'danger' : ACTIVE.includes(item.status) ? 'accent' : ''}`}>
                            <Glyph icon={PROVIDER_ICON[item.provider] ?? NAV_ICON.runs} size={15} />
                          </span>
                          <span className="cell-main">
                            <span className="title truncate" title={item.promptPreview ?? undefined}>
                              {runTitle(item)}
                            </span>
                            <span className="row tight nowrap">
                              <RunStatusBadge status={item.status} />
                              <span className="tiny faint mono truncate">{item.id.slice(0, 10)}</span>
                            </span>
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
                        <span className="row tight nowrap" style={{ justifyContent: 'flex-end' }}>
                          <span className="small muted">
                            {relativeTime(item.finishedAt ?? item.startedAt ?? item.createdAt)}
                          </span>
                          {ATTENTION.includes(item.status) && !item.acknowledgedAt ? (
                            <button type="button" className="btn small ghost"
                              title="Dejar de reclamar atención. El trabajo no cambia."
                              onClick={(event) => {
                                event.stopPropagation();
                                acknowledge.mutate(item.id);
                              }}>
                              <Glyph icon={ACTION_ICON.approve} />
                              Visto
                            </button>
                          ) : null}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* En estrecho el velo cierra la hoja tocando fuera, como cualquier modal.
            En ancho no se pinta: el detalle es la columna lateral de siempre. */}
        {run ? (
          <button type="button" className="detail-sheet-backdrop" aria-label="Cerrar el detalle"
            onClick={() => { setSelected(null); setCerrado(true); }} />
        ) : null}

        {/* `detail-sheet` saca el detalle del flujo en pantallas estrechas, donde
            si no quedaba al final de toda la lista y no se veía al pulsar. */}
        <Card className={run ? 'detail-sheet is-open' : 'detail-sheet'}
          title={run ? 'Detalle del trabajo' : 'Nada seleccionado'} icon={ACTION_ICON.session}
          actions={run ? (
            <button type="button" className="btn small ghost"
              onClick={() => { setSelected(null); setCerrado(true); }}
              aria-label="Cerrar el detalle">
              <Glyph icon={ACTION_ICON.reject} />
            </button>
          ) : undefined}>
          {!run ? (
            <p className="small muted" style={{ margin: 0 }}>
              Elige un trabajo de la lista para ver dónde corrió, con qué permiso y qué dijo.
            </p>
          ) : (
            <div className="stack">
              <div className="stack" style={{ gap: 6 }}>
                <p style={{ margin: 0, fontWeight: 600, color: 'var(--text-strong)' }}>
                  {runTitle(run, 140)}
                </p>
                <div className="row">
                  <RunStatusBadge status={run.status} />
                  <span className="tiny faint mono truncate">{run.id}</span>
                </div>
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
              <ErrorNote error={cancel.error ?? retry.error ?? acknowledge.error}
                onRetry={() => void detail.refetch()} />

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
                {/*
                  * La `key` es lo que hace que cambiar de trabajo empiece de cero: compacto y
                  * todo plegado. Sin ella, el detalle desplegado del anterior se quedaba puesto
                  * —y peor, los tramos se reconocen por su `seq`, que vuelve a empezar en 0 en
                  * cada run, así que se desplegaba un tramo por parecerse al que se abrió antes.
                  */}
                <EventTimeline key={run.id} events={stream.events} limit={40} userMessage={run.promptPreview}
                  live={isRunLive(run.status)}
                  empty="Este trabajo no llegó a dejar ningún evento. Si terminó mal, el detalle está en su código de error." />
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
