/**
 * Piezas compartidas de la interfaz.
 *
 * Cada estado se dice con palabra y forma, no sólo con color: quien no distingue el verde del
 * rojo tiene que poder operar esto igual.
 */
import type { JSX, ReactNode } from 'react';
import type { HostFreshness, Run, RunStatus, TargetPlan } from '@jarvis/contracts';
import { navigate } from '../router.js';
import { PERMISSION, RUN_STATUS } from './labels.js';
import { ACTION_ICON, Glyph, PERMISSION_ICON, RUN_STATUS_ICON } from './icons.jsx';

export function RunStatusBadge({ status }: { status: RunStatus }): JSX.Element {
  const label = RUN_STATUS[status];
  // El icono es la mitad del mensaje: sin él, «trabajando» y «falló» sólo se diferencian por el
  // color, y eso deja fuera a quien no lo distingue.
  return (
    <span className={`badge ${label.tone}`} title={label.help}>
      <Glyph icon={RUN_STATUS_ICON[status]} className={status === 'running' ? 'spin' : undefined} />
      {label.name}
    </span>
  );
}

/**
 * El destino y el permiso, siempre juntos y siempre antes de Send.
 *
 * Enviar trabajo a la máquina equivocada es el error caro de este producto; que la etiqueta y la
 * ejecución digan lo mismo es la mitad de la defensa, y la otra mitad es que se vea.
 */
export function TargetChip({ target }: { target: TargetPlan | undefined }): JSX.Element {
  if (!target) return <span className="badge neutral">destino desconocido</span>;
  const strategy = target.strategy === 'A'
    ? `en ${target.executionHost}, trabajando sobre ${target.workHost}`
    : `en ${target.executionHost}`;
  const permission = PERMISSION[target.permissionProfile];
  return (
    <>
      <span className="badge neutral" title={target.reason ?? undefined}>
        {target.provider} · {strategy}
      </span>
      <span className={`badge ${permission.tone}`} title={permission.help}>
        <Glyph icon={PERMISSION_ICON[target.permissionProfile]} />
        {permission.name}
      </span>
      {target.cwd ? <span className="badge neutral mono">{target.cwd}</span> : null}
    </>
  );
}

export function StaleNote({ freshness, stale }: { freshness?: HostFreshness[]; stale?: boolean }): JSX.Element | null {
  const failed = (freshness ?? []).filter((host) => host.status === 'failed' || host.status === 'stale');
  if (!stale && failed.length === 0) return null;
  return (
    <p className="stale-note" role="status">
      <Glyph icon={ACTION_ICON.timer} size={16} />
      <span>
        {stale ? 'Estos datos son los últimos buenos conocidos. ' : ''}
        {failed.map((host) => `${host.host}: ${host.error ?? 'sin sincronizar'}`).join(' · ')}
      </span>
    </p>
  );
}

export function ErrorNote({ error, action }: { error: unknown; action?: ReactNode }): JSX.Element | null {
  if (!error) return null;
  const typed = error as { code?: string; message?: string; requestId?: string; retryable?: boolean };
  return (
    <div className="error-note" role="alert">
      <strong className="row" style={{ gap: 6 }}>
        <Glyph icon={ACTION_ICON.error} size={16} />
        {typed.code ?? 'ERROR'}
      </strong>
      <p style={{ margin: '4px 0' }}>{typed.message ?? String(error)}</p>
      <p className="small muted" style={{ margin: 0 }}>
        {typed.retryable ? 'Se puede reintentar. ' : ''}
        {typed.requestId ? `petición ${typed.requestId}` : null}
      </p>
      {action ? <div style={{ marginTop: 8 }}>{action}</div> : null}
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }): JSX.Element {
  return (
    <div className="card empty" style={{ textAlign: 'center', padding: 28 }}>
      <Glyph icon={ACTION_ICON.empty} size={28} className="empty-glyph" />
      <p style={{ margin: 0, fontWeight: 600 }}>{title}</p>
      {hint ? <p className="muted small" style={{ margin: '6px 0 0' }}>{hint}</p> : null}
    </div>
  );
}

export function Loading({ rows = 3 }: { rows?: number }): JSX.Element {
  return (
    <div className="list" aria-busy="true" aria-live="polite">
      <span className="visually-hidden">Cargando…</span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton" style={{ height: 44 }} />
      ))}
    </div>
  );
}

export function Link({ to, children, ...rest }: { to: string; children: ReactNode } & Record<string, unknown>): JSX.Element {
  return (
    <a
      href={to}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

export function RunRow({ run, onOpen }: { run: Run; onOpen: (run: Run) => void }): JSX.Element {
  return (
    <button type="button" className="list-item" onClick={() => onOpen(run)}>
      <span className="row">
        <RunStatusBadge status={run.status} />
        <span className="small muted mono">{run.id.slice(0, 8)}</span>
        <span className="small muted">{run.provider} · {run.executionHost}</span>
        {run.strategy === 'A' ? <span className="badge warn">trabaja sobre {run.workHost}</span> : null}
      </span>
      <span className="small muted">
        {new Date(run.createdAt).toLocaleString()}
        {run.errorMessage ? ` · ${run.errorMessage}` : ''}
      </span>
    </button>
  );
}

export const relativeTime = (iso: string | null): string => {
  if (!iso) return 'nunca';
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (Number.isNaN(seconds)) return 'desconocido';
  if (seconds < 60) return `hace ${seconds}s`;
  if (seconds < 3600) return `hace ${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `hace ${Math.round(seconds / 3600)} h`;
  return `hace ${Math.round(seconds / 86_400)} d`;
};
