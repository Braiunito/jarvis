/**
 * Sesiones: explorar, supervisar y reanudar.
 *
 * Buscar es una consulta, no una navegación: filtrar aquí no puede cambiar el workspace activo ni
 * invalidar el que estabas mirando. Abrir una sesión es lo único que cambia de contexto, y es
 * atómico: o estás entero en A, o entero en B.
 *
 * El orden de la pantalla es el del flujo de retomar: primero cuánto hay y qué se movió hoy,
 * después la lista para localizar, y a la derecha la vista previa que evita abrir para mirar.
 */
import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import type { Run, SessionSummary } from '@jarvis/contracts';
import {
  useMetrics, useOpenWorkspace, useRuns, useSessions,
} from '../api/queries.js';
import { navigate } from '../router.js';
import { Empty, ErrorNote, Link, Loading, RunStatusBadge, StaleNote, relativeTime } from '../ui/bits.jsx';
import { Donut, Meter, SERIES_COLORS } from '../ui/charts.jsx';
import { ACTION_ICON, Glyph, NAV_ICON, PROVIDER_ICON, STATUS_ICON } from '../ui/icons.jsx';
import { usePageMeta } from '../ui/page-meta.jsx';
import { Card, DataRow, Stat } from '../ui/primitives.jsx';

type Availability = 'todas' | 'abiertas' | 'sin-abrir' | 'atencion';

const AVAILABILITY_LABEL: Record<Availability, string> = {
  todas: 'Todas',
  abiertas: 'Ya abiertas',
  'sin-abrir': 'Sin abrir',
  atencion: 'Con trabajo fallido',
};

export function ExplorerScreen(): JSX.Element {
  usePageMeta({ title: 'Sesiones', subtitle: 'Explora, supervisa y reanuda sesiones de agentes' });

  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('');
  const [host, setHost] = useState('');
  const [availability, setAvailability] = useState<Availability>('todas');
  const [selected, setSelected] = useState<SessionSummary | null>(null);

  const sessions = useSessions({
    ...(query ? { q: query } : {}),
    ...(provider ? { provider } : {}),
    ...(host ? { host } : {}),
  });
  const runs = useRuns();
  const metrics = useMetrics(24);
  const open = useOpenWorkspace();

  const rows = sessions.data?.sessions ?? [];
  const hosts = useMemo(() => [...new Set(rows.map((row) => row.ref.host))], [rows]);

  /** Qué workspaces tienen trabajo que se paró mal: es lo que convierte una lista en una alerta. */
  const attentionByWorkspace = useMemo(() => {
    const map = new Set<string>();
    for (const run of runs.data?.runs ?? []) {
      if (['failed', 'timed_out', 'waiting'].includes(run.status)) map.add(run.workspaceId);
    }
    return map;
  }, [runs.data]);

  const visible = rows.filter((row) => {
    if (availability === 'abiertas') return Boolean(row.workspaceId);
    if (availability === 'sin-abrir') return !row.workspaceId;
    if (availability === 'atencion') return row.workspaceId ? attentionByWorkspace.has(row.workspaceId) : false;
    return true;
  });

  const openedCount = rows.filter((row) => row.workspaceId).length;
  const attentionCount = rows.filter((row) => row.workspaceId && attentionByWorkspace.has(row.workspaceId)).length;
  const todayCount = rows.filter((row) =>
    row.lastActivityAt && Date.now() - Date.parse(row.lastActivityAt) < 24 * 3600_000).length;

  const selectedRuns: Run[] = selected?.workspaceId
    ? (runs.data?.runs ?? []).filter((run) => run.workspaceId === selected.workspaceId).slice(0, 4)
    : [];

  const filtersActive = Boolean(query || provider || host || availability !== 'todas');

  async function openSession(session: SessionSummary): Promise<void> {
    const result = await open.mutateAsync({
      ref: session.ref,
      cwd: session.cwd,
      title: session.title,
    });
    navigate(`/w/${result.workspace.id}`);
  }

  return (
    <div className="page">
      {/* Filtros: lo que reduce la lista, en una sola línea y siempre a la vista. */}
      <Card>
        <div className="row" style={{ gap: 10 }}>
          <span className="row tight faint" style={{ flex: '0 0 auto' }}>
            <Glyph icon={ACTION_ICON.filters} size={16} />
          </span>

          <div className="search-row">
            <Glyph icon={NAV_ICON.sessions} size={16} className="search-glyph" />
            <input
              className="input"
              placeholder="Buscar por título, mensaje, host o carpeta…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Buscar sesiones"
            />
          </div>

          <label className="row small">
            <span className="muted">Agente</span>
            <select className="select control-sm" value={provider}
              onChange={(event) => setProvider(event.target.value)}>
              <option value="">Todos</option>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
              <option value="opencode">OpenCode</option>
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
            <span className="muted">Estado</span>
            <select className="select control-md" value={availability}
              onChange={(event) => setAvailability(event.target.value as Availability)}>
              {Object.entries(AVAILABILITY_LABEL).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>

          {filtersActive ? (
            <button type="button" className="btn small ghost" onClick={() => {
              setQuery('');
              setProvider('');
              setHost('');
              setAvailability('todas');
            }}>
              <Glyph icon={ACTION_ICON.reject} />
              Limpiar filtros
            </button>
          ) : null}
        </div>
      </Card>

      <StaleNote stale={sessions.data?.stale} freshness={sessions.data?.freshness} />
      <ErrorNote error={sessions.error} />

      {/* Cuánto hay y qué se movió: el contexto antes de ponerse a buscar. */}
      <div className="grid cols-4">
        <Card>
          <Stat value={rows.length} label="sesiones indexadas"
            hint={sessions.data ? `índice consultado ${relativeTime(sessions.data.fetchedAt)}` : undefined} />
        </Card>
        <Card>
          <Stat value={openedCount} label="con workspace abierto" />
          <Meter value={openedCount} max={Math.max(1, rows.length)} tone="ok" />
        </Card>
        <Card>
          <Stat value={attentionCount} label="con trabajo fallido" />
          <Meter value={attentionCount} max={Math.max(1, rows.length)}
            tone={attentionCount ? 'danger' : 'ok'} />
        </Card>
        <Card>
          {metrics.data && metrics.data.runs.byProvider.length ? (
            <div className="row nowrap" style={{ gap: 12, alignItems: 'center' }}>
              <Donut size={92} caption="trabajos" total={metrics.data.runs.total}
                slices={metrics.data.runs.byProvider.map((item) => ({
                  key: item.provider,
                  value: item.runs,
                  label: item.provider,
                  color: SERIES_COLORS[item.provider] ?? SERIES_COLORS['otros'] as string,
                }))} />
              <div className="legend" style={{ flex: 1 }}>
                {metrics.data.runs.byProvider.slice(0, 3).map((item) => (
                  <div key={item.provider} className="row-item">
                    <span className="swatch" style={{ background: SERIES_COLORS[item.provider] ?? 'var(--text-faint)' }} />
                    <span className="truncate">{item.provider}</span>
                    <span className="faint">{item.percent}%</span>
                    <span />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <Stat value={todayCount} label="activas hoy" />
          )}
        </Card>
      </div>

      <div className="grid main-side">
        <Card className="flush">
          <header className="card-head" style={{ padding: '14px 14px 0', marginBottom: 8 }}>
            <h2>
              <Glyph icon={NAV_ICON.sessions} size={16} />
              {visible.length} {visible.length === 1 ? 'sesión' : 'sesiones'}
            </h2>
            {filtersActive ? <span className="pill">filtrado</span> : null}
          </header>

          {sessions.isLoading ? <div style={{ padding: 14 }}><Loading rows={5} /></div> : null}

          {!sessions.isLoading && visible.length === 0 ? (
            <Empty title="Ninguna sesión coincide"
              hint="Prueba con otras palabras, otro agente o quita los filtros." />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Sesión</th>
                    <th>Agente</th>
                    <th>Host y carpeta</th>
                    <th>Última actividad</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((session) => {
                    const key = `${session.ref.host}:${session.ref.provider}:${session.ref.sessionId}`;
                    const isSelected = selected
                      && selected.ref.sessionId === session.ref.sessionId
                      && selected.ref.host === session.ref.host;
                    const needsAttention = session.workspaceId
                      && attentionByWorkspace.has(session.workspaceId);
                    return (
                      <tr key={key} aria-selected={Boolean(isSelected)} tabIndex={0}
                        onClick={() => setSelected(session)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            setSelected(session);
                          }
                        }}>
                        <td>
                          <div className="lead">
                            <span className={`lead-mark ${needsAttention ? 'danger' : session.workspaceId ? 'accent' : ''}`}>
                              <Glyph icon={PROVIDER_ICON[session.ref.provider] ?? NAV_ICON.terminal} size={15} />
                            </span>
                            <span className="cell-main">
                              <span className="title truncate">{session.title ?? session.ref.sessionId}</span>
                              <span className="tiny faint truncate mono">{session.cwd ?? 'sin carpeta'}</span>
                            </span>
                          </div>
                        </td>
                        <td className="optional">
                          <span className="small">{session.ref.provider}</span>
                        </td>
                        <td data-secondary="true">
                          <span className="row tight nowrap small">
                            <Glyph icon={STATUS_ICON.host} size={13} />
                            {session.ref.host}
                          </span>
                        </td>
                        <td data-secondary="true">
                          <span className="small muted">{relativeTime(session.lastActivityAt)}</span>
                        </td>
                        <td>
                          {needsAttention ? (
                            <span className="badge danger">
                              <Glyph icon={ACTION_ICON.error} />
                              Con fallo
                            </span>
                          ) : session.workspaceId ? (
                            <span className="badge ok">
                              <Glyph icon={ACTION_ICON.open} />
                              Abierta
                            </span>
                          ) : (
                            <span className="badge neutral">Sin abrir</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Vista previa: para no tener que abrir un contexto sólo para mirarlo. */}
        <Card title={selected ? 'Vista previa' : 'Nada seleccionado'} icon={ACTION_ICON.open}
          actions={selected ? (
            <button type="button" className="btn small ghost" onClick={() => setSelected(null)}
              aria-label="Cerrar la vista previa">
              <Glyph icon={ACTION_ICON.reject} />
            </button>
          ) : undefined}>
          {!selected ? (
            <p className="small muted" style={{ margin: 0 }}>
              Elige una sesión de la lista para ver de qué iba antes de abrirla.
            </p>
          ) : (
            <div className="stack">
              <div>
                <h3 style={{ margin: 0, fontSize: 15.5, color: 'var(--text-strong)' }}>
                  {selected.title ?? selected.ref.sessionId}
                </h3>
                <p className="tiny faint mono" style={{ margin: '4px 0 0' }}>
                  {selected.ref.host} · {selected.ref.provider} · {selected.ref.sessionId}
                </p>
              </div>

              <div className="row">
                <button type="button" className="btn primary" disabled={open.isPending}
                  onClick={() => void openSession(selected)}>
                  <Glyph icon={ACTION_ICON.open} />
                  {open.isPending ? 'Abriendo…' : selected.workspaceId ? 'Ir al workspace' : 'Abrir workspace'}
                </button>
                <Link className="btn"
                  to={`/terminal?host=${encodeURIComponent(selected.ref.host)}&provider=${selected.ref.provider}&sessionId=${encodeURIComponent(selected.ref.sessionId)}`}>
                  <Glyph icon={NAV_ICON.terminal} />
                  Terminal
                </Link>
              </div>
              <ErrorNote error={open.error} />

              {selected.preview ? (
                <div className="note">
                  <Glyph icon={ACTION_ICON.message} size={15} />
                  <span>{selected.preview}</span>
                </div>
              ) : null}

              <div className="stack" style={{ gap: 7 }}>
                <DataRow label="Carpeta">
                  <span className="mono">{selected.cwd ?? '—'}</span>
                </DataRow>
                <DataRow label="Mensajes">{selected.messageCount ?? '—'}</DataRow>
                <DataRow label="Empezó">{relativeTime(selected.startedAt)}</DataRow>
                <DataRow label="Última actividad">{relativeTime(selected.lastActivityAt)}</DataRow>
              </div>

              {selected.workspaceId ? (
                <div>
                  <div className="spread" style={{ marginBottom: 7 }}>
                    <span className="small muted">Trabajos recientes</span>
                    <Link to={`/w/${selected.workspaceId}`} className="tiny">Ver todos →</Link>
                  </div>
                  {selectedRuns.length === 0 ? (
                    <p className="tiny faint" style={{ margin: 0 }}>Aún no se ha mandado nada aquí.</p>
                  ) : (
                    <div className="list">
                      {selectedRuns.map((run) => (
                        <Link key={run.id} to={`/runs/${run.id}`} className="list-item">
                          <span className="row tight nowrap">
                            <RunStatusBadge status={run.status} />
                            <span className="mono tiny truncate">{run.id.slice(0, 10)}</span>
                          </span>
                          <span className="tiny faint">{relativeTime(run.createdAt)}</span>
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <p className="tiny faint" style={{ margin: 0 }}>
                  Esta sesión aún no tiene workspace: abrirlo es lo que le da sitio en Jarvis.
                </p>
              )}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

