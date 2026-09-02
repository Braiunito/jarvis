/**
 * Piezas compartidas de la interfaz.
 *
 * Cada estado se dice con palabra y forma, no sólo con color: quien no distingue el verde del
 * rojo tiene que poder operar esto igual.
 *
 * Los tres estados que más se repiten —vacío, cargando, error— viven aquí y tienen una regla cada
 * uno: un vacío dice qué hacer, un esqueleto tiene la forma de lo que viene, y un error ofrece la
 * siguiente acción. Un callejón sin salida no es un estado, es un fallo de diseño.
 */
import type { JSX, ReactNode } from 'react';
import { useState } from 'react';
import type { HostFreshness, Run, RunStatus, TargetPlan } from '@jarvis/contracts';
import { navigate } from '../router.js';
import { PERMISSION, RUN_STATUS } from './labels.js';
import { ACTION_ICON, Glyph, NAV_ICON, PERMISSION_ICON, RUN_STATUS_ICON } from './icons.jsx';

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
        {failed.length ? ' · ' : ''}
        <Link to="/health" className="tiny">ver qué salto falla →</Link>
      </span>
    </p>
  );
}

/** Errores de conexión: los que se diagnostican en Salud y no reintentando a ciegas. */
const CONNECTIVITY = ['HOST_UNREACHABLE', 'TMUX_MISSING', 'PROVIDER_MISSING', 'INDEX_UNAVAILABLE', 'SSH_FAILED'];

/**
 * Un error con salida.
 *
 * Decir «falló» y quedarse ahí deja a la persona con el ratón en el aire. Aquí siempre hay al
 * menos un camino: reintentar cuando el servidor dice que se puede, mirar Salud cuando el fallo
 * es de conexión, y copiar el diagnóstico —código, mensaje, petición y hora— para pedir ayuda sin
 * transcribir nada a mano. Lo que se copia no lleva prompts ni salida del agente.
 */
export function ErrorNote({ error, action, onRetry }: {
  error: unknown;
  action?: ReactNode;
  onRetry?: () => void;
}): JSX.Element | null {
  const [copied, setCopied] = useState(false);
  if (!error) return null;
  const typed = error as { code?: string; message?: string; requestId?: string; retryable?: boolean };
  const code = typed.code ?? 'ERROR';
  const connectivity = CONNECTIVITY.includes(code);

  const copy = (): void => {
    const report = JSON.stringify({
      at: new Date().toISOString(),
      code,
      message: typed.message ?? String(error),
      requestId: typed.requestId ?? null,
      where: window.location.pathname,
    }, null, 2);
    void navigator.clipboard.writeText(report).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    });
  };

  return (
    <div className="error-note" role="alert">
      <strong className="row" style={{ gap: 6 }}>
        <Glyph icon={ACTION_ICON.error} size={16} />
        {code}
      </strong>
      <p style={{ margin: '4px 0' }}>{typed.message ?? String(error)}</p>
      {typed.requestId ? (
        <p className="tiny faint mono" style={{ margin: 0 }}>petición {typed.requestId}</p>
      ) : null}
      <div className="row" style={{ marginTop: 9 }}>
        {onRetry && typed.retryable !== false ? (
          <button type="button" className="btn small" onClick={onRetry}>
            <Glyph icon={ACTION_ICON.retry} />
            Reintentar
          </button>
        ) : null}
        {connectivity ? (
          <Link to="/health" className="btn small">
            <Glyph icon={NAV_ICON.health} />
            Ver qué salto falla
          </Link>
        ) : null}
        <button type="button" className="btn small ghost" onClick={copy}>
          <Glyph icon={copied ? ACTION_ICON.approve : ACTION_ICON.copy} />
          {copied ? 'Copiado' : 'Copiar diagnóstico'}
        </button>
        {action}
      </div>
    </div>
  );
}

/**
 * Un vacío que dice qué hacer.
 *
 * «No hay nada» es la mitad de la información; la otra mitad es si eso es normal, y qué hace
 * falta para que deje de estarlo. Por eso `hint` no es opcional en la práctica y hay sitio para
 * la acción que lo resuelve.
 */
export function Empty({ title, hint, action, icon, tight }: {
  title: string;
  hint?: string;
  action?: ReactNode;
  icon?: typeof ACTION_ICON.empty;
  tight?: boolean;
}): JSX.Element {
  return (
    <div className={`card empty ${tight ? 'tight' : ''}`}>
      <Glyph icon={icon ?? ACTION_ICON.empty} size={tight ? 18 : 28} className="empty-glyph" />
      <p style={{ margin: 0, fontWeight: 600, color: 'var(--text)' }}>{title}</p>
      {hint ? <p className="muted small" style={{ margin: 0 }}>{hint}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export type SkeletonShape = 'list' | 'table' | 'stats' | 'timeline' | 'text';

/**
 * La espera, con la forma de lo que viene.
 *
 * Se anuncia una vez —«cargando»— y no en cada fila: un lector de pantalla que repite lo mismo
 * cinco veces es ruido, no información.
 */
export function Loading({ rows = 3, shape = 'list', label = 'Cargando…' }: {
  rows?: number;
  shape?: SkeletonShape;
  label?: string;
}): JSX.Element {
  const items = Array.from({ length: rows }, (_, index) => index);

  if (shape === 'stats') {
    return (
      <div className="sk-stats" aria-busy="true" aria-live="polite">
        <span className="visually-hidden">{label}</span>
        {items.map((index) => (
          <div key={index} className="sk-stat">
            <div className="skeleton value" />
            <div className="skeleton line" style={{ width: '70%' }} />
          </div>
        ))}
      </div>
    );
  }

  if (shape === 'timeline') {
    return (
      <div className="sk-timeline" aria-busy="true" aria-live="polite">
        <span className="visually-hidden">{label}</span>
        {items.map((index) => (
          <div key={index} className="sk-event">
            <div className="time skeleton line" style={{ width: 52, marginTop: 14 }} />
            <div className="skeleton dot" />
            <div className="body">
              <div className="skeleton line" style={{ width: '38%' }} />
              <div className="skeleton line" style={{ width: `${70 - index * 7}%` }} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (shape === 'text') {
    return (
      <div className="sk-rows" aria-busy="true" aria-live="polite">
        <span className="visually-hidden">{label}</span>
        {items.map((index) => (
          <div key={index} className="skeleton line" style={{ width: `${94 - index * 11}%` }} />
        ))}
      </div>
    );
  }

  // `list` y `table` comparten forma: marca a la izquierda, dos líneas y un dato a la derecha.
  return (
    <div className="sk-rows" aria-busy="true" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      {items.map((index) => (
        <div key={index} className="sk-row">
          <div className="skeleton mark" />
          <div className="grow">
            <div className="skeleton line" style={{ width: `${58 - index * 6}%` }} />
            <div className="skeleton line" style={{ width: `${38 - index * 4}%` }} />
          </div>
          {shape === 'table' ? <div className="tail"><div className="skeleton line" style={{ width: '100%' }} /></div> : null}
        </div>
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
