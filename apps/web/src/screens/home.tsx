/**
 * Centro de comandos.
 *
 * El orden es el de los flujos, no el del modelo de datos:
 *
 *   1. **retomar** — seguir donde lo dejaste, arriba del todo, porque casi nunca se empieza de
 *      cero: se vuelve;
 *   2. **vigilar** — qué está en marcha y qué se ha parado mal, separados a propósito: mezclarlos
 *      hace que lo segundo pase desapercibido;
 *   3. **diagnosticar** — la salud de la flota, agrupada por dependencia;
 *   4. **delegar / intervenir** — workspaces recientes, reparto del trabajo y las cuatro acciones
 *      que se repiten.
 */
import type { JSX } from 'react';
import type { Health, Run, Workspace } from '@jarvis/contracts';
import { useHealth, useMetrics, useRuns, useWorkspaces } from '../api/queries.js';
import { Empty, Link, Loading, RunStatusBadge, relativeTime } from '../ui/bits.jsx';
import { Donut, Meter, Sparkbars, SERIES_COLORS } from '../ui/charts.jsx';
import {
  ACTION_ICON, Glyph, HEALTH_ICON, NAV_ICON, PROVIDER_ICON, RUN_STATUS_ICON, STATUS_ICON,
} from '../ui/icons.jsx';
import { HEALTH, USAGE_LOW_PERCENT, usageWindowName } from '../ui/labels.js';
import { openNewSession } from '../ui/new-session.jsx';
import { usePageMeta } from '../ui/page-meta.jsx';
import { Card, formatDuration, Stat } from '../ui/primitives.jsx';

const HEALTH_SUMMARY: Record<Health['status'], string> = {
  ok: 'todo bien',
  degraded: 'algo a medias',
  failed: 'algo caído',
};

const healthTone = (status: Health['status']): string =>
  status === 'ok' ? 'ok' : status === 'degraded' ? 'warn' : 'danger';

/** Los checks se agrupan por lo que son: una lista de trece líneas no se lee, se sufre. */
function groupChecks(health: Health | undefined): Array<{
  key: string;
  label: string;
  icon: typeof HEALTH_ICON[string];
  ok: number;
  total: number;
  worst: string;
}> {
  if (!health) return [];
  const groups: Record<string, { label: string; icon: typeof HEALTH_ICON[string]; entries: string[] }> = {
    hosts: { label: 'Máquinas', icon: ACTION_ICON.hosts, entries: [] },
    core: { label: 'Core y base de datos', icon: ACTION_ICON.database, entries: [] },
    index: { label: 'Índice de sesiones', icon: STATUS_ICON.folder, entries: [] },
    work: { label: 'Trabajo en curso', icon: NAV_ICON.runs, entries: [] },
  };

  for (const [key, check] of Object.entries(health.checks)) {
    const group = key.startsWith('ssh:') ? 'hosts'
      : key === 'aisessions' ? 'index'
        : key === 'runs' || key === 'runnerSweep' ? 'work'
          : 'core';
    groups[group]?.entries.push(check.status);
  }

  const rank = ['ok', 'stale', 'degraded', 'unknown', 'failed'];
  return Object.entries(groups)
    .filter(([, group]) => group.entries.length > 0)
    .map(([key, group]) => ({
      key,
      label: group.label,
      icon: group.icon,
      ok: group.entries.filter((status) => status === 'ok').length,
      total: group.entries.length,
      worst: group.entries.reduce((worst, status) =>
        rank.indexOf(status) > rank.indexOf(worst) ? status : worst, 'ok'),
    }));
}

function ResumeCard({ workspace, lastRun }: { workspace: Workspace; lastRun: Run | undefined }): JSX.Element {
  return (
    <Card className="accent">
      <div className="grid main-side" style={{ gap: 16 }}>
        <div className="lead">
          <span className="lead-mark big accent"><Glyph icon={NAV_ICON.terminal} size={22} /></span>
          <div className="stack" style={{ gap: 7 }}>
            <span className="tiny muted row tight">
              <Glyph icon={ACTION_ICON.go} size={13} />
              Seguir donde lo dejaste
            </span>
            <h2 style={{ margin: 0, fontSize: 19, letterSpacing: '-0.02em', color: 'var(--text-strong)' }}>
              {workspace.title ?? workspace.ref.sessionId}
            </h2>
            <p className="small muted" style={{ margin: 0 }}>
              {workspace.ref.host} · {workspace.ref.provider} · {workspace.ref.sessionId}
              {workspace.cwd ? ` · ${workspace.cwd}` : ''}
            </p>
            <p className="tiny faint" style={{ margin: 0 }}>
              Abierto {relativeTime(workspace.lastOpenedAt)}
            </p>
            <div className="row" style={{ marginTop: 4 }}>
              <Link to={`/w/${workspace.id}`} className="btn primary">
                <Glyph icon={ACTION_ICON.open} />
                Abrir workspace
              </Link>
              <Link to={`/terminal?host=${encodeURIComponent(workspace.ref.host)}&provider=${workspace.ref.provider}&sessionId=${encodeURIComponent(workspace.ref.sessionId)}`}
                className="btn">
                <Glyph icon={NAV_ICON.terminal} />
                Abrir terminal
              </Link>
            </div>
          </div>
        </div>

        <div className="stack">
          <span className="tiny muted">Último trabajo aquí</span>
          {lastRun ? (
            <>
              <div className="row tight">
                <RunStatusBadge status={lastRun.status} />
                <span className="mono tiny muted">{lastRun.id.slice(0, 10)}</span>
                <span className="tiny faint">{relativeTime(lastRun.finishedAt ?? lastRun.createdAt)}</span>
              </div>
              <div className="mono tiny truncate" style={{
                padding: '8px 10px', borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-sunken)', border: '1px solid var(--border)',
              }}>
                {lastRun.provider} · {lastRun.executionHost}
                {lastRun.model ? ` · ${lastRun.model}` : ''}
              </div>
              <Link to={`/runs/${lastRun.id}`} className="small">Ver la ejecución →</Link>
            </>
          ) : (
            <p className="small muted" style={{ margin: 0 }}>Todavía no has mandado nada aquí.</p>
          )}
        </div>
      </div>
    </Card>
  );
}

export function HomeScreen(): JSX.Element {
  usePageMeta({ title: 'Centro de comandos', subtitle: 'Qué hay abierto, qué corre y qué pide algo de ti' });

  const workspaces = useWorkspaces();
  const runs = useRuns();
  const health = useHealth();
  const metrics = useMetrics(24);

  const all = runs.data?.runs ?? [];
  const active = all.filter((run) => ['queued', 'preparing', 'running', 'cancelling'].includes(run.status));
  // Lo dado por visto deja de reclamar aquí también: si la portada y el carril cuentan cosas
  // distintas, el aviso deja de significar nada.
  const attention = all.filter((run) =>
    !run.acknowledgedAt && ['failed', 'timed_out', 'waiting'].includes(run.status));
  const recent = workspaces.data?.workspaces ?? [];
  const last = recent[0];
  const lastRun = last ? all.find((run) => run.workspaceId === last.id) : undefined;

  const providers = metrics.data?.runs.byProvider ?? [];
  const usage = metrics.data?.usage ?? [];
  const groups = groupChecks(health.data);

  return (
    <div className="page">
      {last ? <ResumeCard workspace={last} lastRun={lastRun} /> : (
        <Card>
          <div className="empty">
            <Glyph icon={ACTION_ICON.empty} size={30} className="empty-glyph" />
            <strong>Todavía no has abierto ninguna sesión</strong>
            <p className="small muted" style={{ margin: 0 }}>
              Busca una en el explorador y ábrela: el workspace es lo que conserva su contexto.
            </p>
            <Link to="/sessions" className="btn primary" style={{ marginTop: 6 }}>
              <Glyph icon={NAV_ICON.sessions} />
              Buscar sesiones
            </Link>
          </div>
        </Card>
      )}

      {/* Vigilar: lo que corre y lo que se rompió, separados. */}
      <div className="grid cols-3">
        <Card title="En marcha" icon={NAV_ICON.runs} count={active.length}
          actions={<Link to="/runs" className="small">Ver todo →</Link>}>
          {runs.isLoading ? <Loading rows={2} shape="list" label="Cargando el trabajo en curso…" /> : null}
          {!runs.isLoading && active.length === 0 ? (
            <Empty
              tight
              icon={NAV_ICON.runs}
              title="Nada ejecutándose ahora mismo"
              hint="Cuando mandes algo desde un workspace, lo verás aquí mientras dure."
            />
          ) : null}
          <div className="list">
            {active.slice(0, 4).map((run) => (
              <Link key={run.id} to={`/runs/${run.id}`} className="list-item">
                <span className="row tight nowrap">
                  <RunStatusBadge status={run.status} />
                  <span className="small truncate">{run.provider} · {run.executionHost}</span>
                </span>
                <span className="tiny faint">iniciado {relativeTime(run.startedAt ?? run.createdAt)}</span>
              </Link>
            ))}
          </div>
        </Card>

        <Card title="Requieren atención" icon={ACTION_ICON.error}
          count={attention.length} countTone={attention.length ? 'attention' : undefined}
          actions={<Link to="/runs" className="small">Ver todo →</Link>}>
          {attention.length === 0 ? (
            <Empty
              tight
              icon={ACTION_ICON.approve}
              title="Nada parado esperándote"
              hint="Aquí caen los trabajos que fallaron, se quedaron sin tiempo o esperan una decisión tuya."
            />
          ) : null}
          <div className="list">
            {attention.slice(0, 4).map((run) => (
              <Link key={run.id} to={`/runs/${run.id}`} className="list-item">
                <span className="row tight nowrap">
                  <RunStatusBadge status={run.status} />
                  <span className="small truncate">{run.errorMessage ?? run.errorCode ?? 'sin detalle'}</span>
                </span>
                <span className="tiny faint">
                  {run.provider} · {run.executionHost} · {relativeTime(run.finishedAt ?? run.createdAt)}
                </span>
              </Link>
            ))}
          </div>
        </Card>

        <Card title="Salud de la flota" icon={NAV_ICON.health}
          actions={
            <span className={`badge ${healthTone(health.data?.status ?? 'failed')}`}>
              <Glyph icon={HEALTH_ICON[health.data?.status ?? 'unknown'] ?? HEALTH_ICON['unknown'] as never} />
              {health.data ? HEALTH_SUMMARY[health.data.status] : '—'}
            </span>
          }>
          {health.isLoading ? <Loading rows={3} shape="list" label="Comprobando la salud…" /> : null}
          <div className="list">
            {groups.map((group) => (
              <div key={group.key} className="list-item plain">
                <span className="row nowrap" style={{ justifyContent: 'space-between' }}>
                  <span className="row tight nowrap">
                    <Glyph icon={group.icon} />
                    <span className="small">{group.label}</span>
                  </span>
                  <span className="row tight nowrap">
                    <span className={`badge ${HEALTH[group.worst]?.tone ?? 'neutral'}`}>
                      <Glyph icon={HEALTH_ICON[group.worst] ?? HEALTH_ICON['unknown'] as never} />
                      {HEALTH[group.worst]?.name ?? group.worst}
                    </span>
                    <span className="tiny faint">{group.ok}/{group.total}</span>
                  </span>
                </span>
                <Meter value={group.ok} max={group.total}
                  tone={group.worst === 'ok' ? 'ok' : group.worst === 'failed' ? 'danger' : 'warn'} />
              </div>
            ))}
          </div>
          <div className="card-foot">
            <Link to="/health" className="small">Ver el detalle por salto →</Link>
          </div>
        </Card>
      </div>

      {/* Entender: cuánto trabajo hubo, de quién y cuánto duró. */}
      <div className="grid cols-3">
        <Card title="Actividad" icon={STATUS_ICON.activity}
          actions={<span className="tiny faint">últimas 24 h</span>}>
          <Stat
            value={metrics.data?.runs.total ?? '—'}
            label="trabajos lanzados"
            delta={metrics.data?.runs.deltaPercent ?? null}
            hint={metrics.data ? `mediana ${formatDuration(metrics.data.runs.medianDurationMs)} · total ${formatDuration(metrics.data.runs.totalDurationMs)}` : undefined}
          />
          <div style={{ marginTop: 12 }}>
            <Sparkbars
              label={`Trabajos por hora en las últimas ${metrics.data?.window.hours ?? 24} horas`}
              points={(metrics.data?.runs.buckets ?? []).map((bucket) => ({
                at: bucket.at, value: bucket.runs, bad: bucket.failed,
              }))}
            />
            <div className="spread tiny faint" style={{ marginTop: 4 }}>
              <span>-24 h</span>
              <span>ahora</span>
            </div>
          </div>
        </Card>

        <Card title="Reparto por agente" icon={ACTION_ICON.delegate}>
          {providers.length === 0 ? (
            <p className="small muted" style={{ margin: 0 }}>Sin trabajos en el periodo.</p>
          ) : (
            <div className="row nowrap" style={{ gap: 16, alignItems: 'center' }}>
              <Donut
                caption="trabajos"
                total={metrics.data?.runs.total ?? 0}
                slices={providers.map((item) => ({
                  key: item.provider,
                  value: item.runs,
                  label: item.provider,
                  color: SERIES_COLORS[item.provider] ?? SERIES_COLORS['otros'] as string,
                }))}
              />
              <div className="legend" style={{ flex: 1 }}>
                {providers.map((item) => (
                  <div key={item.provider} className="row-item">
                    <span className="swatch" style={{ background: SERIES_COLORS[item.provider] ?? 'var(--text-faint)' }} />
                    <span className="truncate">{item.provider}</span>
                    <span className="muted">{item.runs}</span>
                    <span className="faint">{item.percent}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/*
            * La cuota, donde ya se habla de agentes.
            *
            * Estaba sólo dentro de un workspace, y desde la portada también se decide lanzar
            * trabajo: enterarse de que a una cuenta le queda un 8% **después** de mandar algo es
            * enterarse tarde. Se enseña la ventana más apretada de cada cuenta; el detalle por
            * ventana sigue en el workspace, que es donde hace falta.
            */}
          {usage.length ? (
            <div style={{ marginTop: providers.length ? 14 : 0 }}>
              <p className="tiny faint" style={{ margin: '0 0 8px' }}>Cuota de las cuentas</p>
              <div className="stack" style={{ gap: 8 }}>
                {usage.slice(0, 4).map((account) => (
                  <div key={`${account.provider}:${account.executionHost}`}>
                    <div className="spread" style={{ gap: 8 }}>
                      <span className="row tight nowrap small" style={{ minWidth: 0 }}>
                        <Glyph icon={PROVIDER_ICON[account.provider] ?? NAV_ICON.runs} size={13} />
                        <span className="truncate">{account.provider}</span>
                        <span className="tiny faint truncate">{account.executionHost}</span>
                      </span>
                      <span className={`tiny ${account.remainingPercent <= USAGE_LOW_PERCENT ? 'danger-text' : 'faint'}`}>
                        {account.remainingPercent}% de {usageWindowName(account.label)}
                        {account.stale ? ' · viejo' : ''}
                      </span>
                    </div>
                    <Meter
                      value={account.remainingPercent}
                      max={100}
                      tone={account.remainingPercent <= USAGE_LOW_PERCENT ? 'danger' : 'ok'}
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </Card>

        <Card title="Acciones rápidas" icon={ACTION_ICON.new}>
          <div className="grid cols-2" style={{ gap: 8 }}>
            {/* Empezar de cero va primero: es lo que no se podía hacer y lo que más se busca. */}
            <button type="button" className="btn tall primary" onClick={() => openNewSession()}>
              <Glyph icon={ACTION_ICON.new} />
              Empezar una sesión
            </button>
            <Link to="/sessions" className="btn tall">
              <Glyph icon={NAV_ICON.sessions} />
              Buscar una sesión
            </Link>
            <Link to="/runs" className="btn tall">
              <Glyph icon={NAV_ICON.runs} />
              Ver el trabajo
            </Link>
            <Link to="/terminal" className="btn tall">
              <Glyph icon={NAV_ICON.terminal} />
              Abrir una terminal
            </Link>
          </div>
          {metrics.data && metrics.data.plans.waitingApproval > 0 ? (
            <div className="note warn" style={{ marginTop: 10 }}>
              <Glyph icon={ACTION_ICON.error} size={16} />
              <span>
                {metrics.data.plans.waitingApproval} objetivo(s) esperando tu permiso para seguir.
              </span>
            </div>
          ) : null}
        </Card>
      </div>

      {/* Retomar: el resto de contextos abiertos. */}
      <Card title="Workspaces recientes" icon={ACTION_ICON.open}
        count={metrics.data?.workspaces.total}
        actions={<Link to="/sessions" className="small">Explorar sesiones →</Link>}>
        {workspaces.isLoading ? <Loading rows={3} shape="list" label="Cargando los workspaces…" /> : null}
        {!workspaces.isLoading && recent.length === 0 ? (
          <Empty
            icon={ACTION_ICON.open}
            title="Todavía no has abierto ningún workspace"
            hint="Un workspace es una sesión de agente con sitio en Jarvis: su borrador, su historial y sus trabajos. Se crea al abrir una sesión del índice."
            action={
              <Link to="/sessions" className="btn primary">
                <Glyph icon={NAV_ICON.sessions} />
                Buscar una sesión
              </Link>
            }
          />
        ) : null}
        <div className="grid cols-3">
          {recent.slice(0, 6).map((workspace) => (
            <Link key={workspace.id} to={`/w/${workspace.id}`} className="list-item">
              <span className="row tight nowrap">
                <Glyph icon={RUN_STATUS_ICON.completed} size={13} />
                <span className="title truncate">{workspace.title ?? workspace.ref.sessionId}</span>
              </span>
              <span className="tiny faint truncate">
                {workspace.ref.provider} · {workspace.ref.host}
                {workspace.cwd ? ` · ${workspace.cwd}` : ''}
              </span>
              <span className="tiny faint">abierto {relativeTime(workspace.lastOpenedAt)}</span>
            </Link>
          ))}
        </div>
      </Card>
    </div>
  );
}

