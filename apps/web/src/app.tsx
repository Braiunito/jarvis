/**
 * El armazón.
 *
 * A la izquierda, los destinos y el estado de la conexión: lo que hay que poder ver siempre.
 * Arriba, dónde estoy y el buscador que lleva a cualquier sitio. Abajo, la barra de estado, que
 * es lo que se mira cuando algo va raro. En un teléfono el carril baja y se queda en iconos.
 *
 * El orden de los destinos sigue los flujos, no las entidades: primero volver a lo de siempre
 * (Inicio, Sesiones), después vigilar lo que corre (Trabajo), intervenir (Terminal) y por último
 * diagnosticar (Salud).
 *
 * La URL manda: el workspace, el run o la terminal activos están ahí, no en un estado escondido.
 */
import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { get, post, UnauthenticatedError } from './api/client.js';
import { useHealth, useMetrics, useRuns } from './api/queries.js';
import { useRoute } from './router.js';
import { Announcer } from './ui/announce.jsx';
import { Link } from './ui/bits.jsx';
import { CommandPalette, openCommandPalette } from './ui/command-palette.jsx';
import { ACTION_ICON, Glyph, NAV_ICON, PLAN_STATUS_ICON, STATUS_ICON } from './ui/icons.jsx';
import { PageMetaProvider, usePageMetaValue } from './ui/page-meta.jsx';
import { formatDuration } from './ui/primitives.jsx';
import { LoginScreen } from './screens/login.jsx';
import { HomeScreen } from './screens/home.jsx';
import { ExplorerScreen } from './screens/explorer.jsx';
import { WorkspaceScreen } from './screens/workspace.jsx';
import { RunCenterScreen } from './screens/runs.jsx';
import { HealthScreen } from './screens/health.jsx';
import { TerminalScreen } from './screens/terminal.jsx';

interface Me {
  authenticated: boolean;
  user: { username: string; displayName: string };
  insecureLogin?: boolean;
}

/**
 * Los defaults se ponen aquí, no se aceptan.
 *
 * Un 401 no se reintenta: significa que hay que volver al login, y reintentarlo sólo retrasa
 * enterarse. Un error de red sí, una vez.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => !(error instanceof UnauthenticatedError) && failureCount < 1,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      staleTime: 10_000,
    },
    mutations: { retry: 0 },
  },
});

const RAIL_KEY = 'jarvis.rail.collapsed';

function Rail({ working, attention, insecure }: {
  working: number;
  attention: number;
  insecure: boolean;
}): JSX.Element {
  const route = useRoute();
  const health = useHealth();
  const [collapsed, setCollapsed] = useState(() => window.localStorage.getItem(RAIL_KEY) === '1');

  useEffect(() => {
    document.querySelector('.shell')?.classList.toggle('collapsed', collapsed);
    window.localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  const current = (path: string): 'page' | undefined =>
    (path === '/' ? route.path === '/' : route.path.startsWith(path)) ? 'page' : undefined;

  const status = health.data?.status ?? 'unknown';
  const tone = status === 'ok' ? 'ok' : status === 'degraded' ? 'warn' : status === 'failed' ? 'danger' : 'neutral';

  return (
    <aside className="rail">
      <div className="rail-brand">
        <span className="rail-mark"><Glyph icon={NAV_ICON.brand} size={17} /></span>
        <span>Jarvis</span>
      </div>

      <nav className="nav" aria-label="Secciones">
        <Link to="/" aria-current={current('/')}>
          <Glyph icon={NAV_ICON.home} size={17} />
          <span>Inicio</span>
        </Link>
        <Link to="/sessions" aria-current={current('/sessions')}>
          <Glyph icon={NAV_ICON.sessions} size={17} />
          <span>Sesiones</span>
        </Link>
        <Link to="/runs" aria-current={current('/runs')}>
          <Glyph icon={NAV_ICON.runs} size={17} />
          <span>Trabajo</span>
          {attention > 0 ? (
            <span className="count attention" title={`${attention} necesitan que mires`}>{attention}</span>
          ) : working > 0 ? (
            <span className="count" title={`${working} en marcha`}>{working}</span>
          ) : null}
        </Link>
        <Link to="/terminal" aria-current={current('/terminal')}>
          <Glyph icon={NAV_ICON.terminal} size={17} />
          <span>Terminal</span>
        </Link>
        <Link to="/health" aria-current={current('/health')}>
          <Glyph icon={NAV_ICON.health} size={17} />
          <span>Salud</span>
          {insecure ? <span className="count attention" title="La conexión no está cifrada">!</span> : null}
        </Link>
      </nav>

      <div className="rail-status">
        <span className="line">
          <span className={`badge ${tone}`} style={{ padding: 0, border: 0, background: 'none' }}>
            <span className="dot" aria-hidden="true" />
          </span>
          {status === 'ok' ? 'Conectado' : status === 'unknown' ? 'Conectando…' : 'Con incidencias'}
        </span>
        <span className="muted">core {health.data?.version ?? '—'}</span>
      </div>

      <button type="button" className="rail-collapse" onClick={() => setCollapsed((value) => !value)}
        title={collapsed ? 'Ampliar el menú' : 'Colapsar el menú'}
        aria-label={collapsed ? 'Ampliar el menú' : 'Colapsar el menú'}>
        <Glyph icon={collapsed ? ACTION_ICON.expand : ACTION_ICON.collapse} />
        <span>Colapsar</span>
      </button>
    </aside>
  );
}

/** Lo que se mira cuando algo va raro: dónde estamos, desde cuándo y con qué. */
function StatusBar(): JSX.Element | null {
  const health = useHealth();
  const system = health.data?.system;
  if (!system) return null;

  return (
    <footer className="statusbar">
      <span className="item">
        <Glyph icon={NAV_ICON.terminal} size={14} />
        Entorno <strong>{system.bastionHost}</strong>
      </span>
      <span className="item">
        <Glyph icon={ACTION_ICON.hosts} size={14} />
        Hosts <strong>{system.hosts}</strong>
      </span>
      <span className="item">
        <Glyph icon={STATUS_ICON.clock} size={14} />
        En pie <strong>{formatDuration(system.uptimeSeconds * 1000)}</strong>
      </span>
      <span className="item">
        <Glyph icon={ACTION_ICON.database} size={14} />
        SQLite <strong>{system.sqlite}</strong>
      </span>
      <span className="item">
        <Glyph icon={ACTION_ICON.node} size={14} />
        Node <strong>{system.node}</strong>
      </span>
    </footer>
  );
}

function Shell({ me, onLogout }: { me: Me; onLogout: () => void }): JSX.Element {
  const route = useRoute();
  const [section] = route.segments;
  const runs = useRuns();
  const metrics = useMetrics(24);
  const meta = usePageMetaValue();

  // Dos números distintos: lo que está en marcha y lo que se paró mal. Mezclarlos haría que el
  // segundo pasara desapercibido, que es justo el que hay que mirar.
  const working = (runs.data?.runs ?? []).filter((run) =>
    ['queued', 'preparing', 'running', 'cancelling'].includes(run.status)).length;
  const attention = (runs.data?.runs ?? []).filter((run) =>
    run.status === 'waiting' || run.status === 'failed' || run.status === 'timed_out').length;
  const waitingApproval = metrics.data?.plans.waitingApproval ?? 0;

  const content = (() => {
    if (section === 'sessions') return <ExplorerScreen />;
    if (section === 'w' && route.segments[1]) return <WorkspaceScreen workspaceId={route.segments[1]} />;
    if (section === 'runs') return <RunCenterScreen runId={route.segments[1] ?? null} />;
    if (section === 'terminal') return <TerminalScreen query={route.query} />;
    if (section === 'health') return <HealthScreen />;
    return <HomeScreen />;
  })();

  return (
    <div className="shell">
      {/* Lo primero del orden de tabulación: cinco destinos antes del contenido son once saltos. */}
      <a className="skip-link" href="#contenido"
        onClick={(event) => {
          event.preventDefault();
          const main = document.getElementById('contenido');
          main?.focus();
          main?.scrollIntoView();
        }}>
        Saltar al contenido
      </a>
      <Rail working={working} attention={attention} insecure={Boolean(me.insecureLogin)} />

      <div className="workarea">
        <header className="topbar">
          <div className="page-heading">
            {meta.parent ? (
              <p className="row tight" style={{ gap: 5 }}>
                <Link to={meta.parent.to}>{meta.parent.label}</Link>
                <Glyph icon={ACTION_ICON.chevron} size={13} />
                <span className="truncate">{meta.title}</span>
              </p>
            ) : null}
            <h1 className="truncate">{meta.title}</h1>
            {meta.subtitle && !meta.parent ? <p>{meta.subtitle}</p> : null}
          </div>

          <button type="button" className="topbar-search" onClick={openCommandPalette}
            aria-label="Buscar y saltar a cualquier sitio">
            <Glyph icon={NAV_ICON.sessions} size={16} />
            <span className="grow">Buscar sesiones, hosts, trabajos…</span>
            <span className="kbd">Ctrl K</span>
          </button>

          <div className="topbar-right">
            {/*
              * Lo que espera una decisión tuya no puede vivir sólo en la pantalla donde nació:
              * un plan parado en un workspace que no estás mirando no se entera nadie.
              */}
            {waitingApproval > 0 ? (
              <Link to="/" className="chip warn"
                title="Hay planes parados esperando que autorices algo">
                <Glyph icon={PLAN_STATUS_ICON['waiting_approval'] as never} />
                <span className="chip-text">
                  {waitingApproval === 1 ? '1 espera tu permiso' : `${waitingApproval} esperan tu permiso`}
                </span>
              </Link>
            ) : null}
            {me.insecureLogin ? (
              <Link to="/health" className="chip warn"
                title="La entrada por contraseña sobre HTTP sigue abierta: todo viaja en claro">
                <Glyph icon={ACTION_ICON.insecure} />
                <span className="chip-text">HTTP sin cifrar</span>
              </Link>
            ) : (
              <span className="chip ok" title="La conexión con el gateway está cifrada">
                <Glyph icon={ACTION_ICON.secure} />
                <span className="chip-text">Conexión segura</span>
              </span>
            )}
            <span className="chip topbar-user">
              <span className="avatar">{me.user.displayName.slice(0, 1).toUpperCase()}</span>
              <strong>{me.user.displayName}</strong>
            </span>
            <button type="button" className="btn small" onClick={onLogout}>
              <Glyph icon={ACTION_ICON.logout} />
              <span className="chip-text">Salir</span>
            </button>
          </div>
        </header>

        <main id="contenido" tabIndex={-1}>{content}</main>
        <StatusBar />
      </div>

      <CommandPalette />
      <Announcer />
    </div>
  );
}

export function App(): JSX.Element {
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);

  const refresh = useCallback(() => {
    get<Me>('/auth/me')
      .then((value) => setMe(value))
      .catch(() => setMe(null))
      .finally(() => setChecked(true));
  }, []);

  useEffect(refresh, [refresh]);

  // Cualquier 401 en cualquier consulta devuelve a la pantalla de entrada: no tiene sentido
  // seguir pintando datos de una sesión que ya no existe.
  useEffect(() => {
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.query.state.error instanceof UnauthenticatedError) setMe(null);
    });
    return unsubscribe;
  }, []);

  if (!checked) return <div className="page"><p className="muted">Comprobando la sesión…</p></div>;
  if (!me) return <LoginScreen onAuthenticated={refresh} />;

  return (
    <QueryClientProvider client={queryClient}>
      <PageMetaProvider>
        <Shell
          me={me}
          onLogout={() => {
            void post('/auth/logout').finally(() => {
              queryClient.clear();
              setMe(null);
            });
          }}
        />
      </PageMetaProvider>
    </QueryClientProvider>
  );
}
