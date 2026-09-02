/**
 * El armazón.
 *
 * La sesión se resuelve una vez y se vuelve a comprobar cuando una petición dice que ya no vale.
 * La URL manda: el workspace, el run o la terminal activos están ahí, no en un estado escondido.
 */
import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { get, post, UnauthenticatedError } from './api/client.js';
import { useRoute } from './router.js';
import { Link } from './ui/bits.jsx';
import { CommandPalette, openCommandPalette } from './ui/command-palette.jsx';
import { ACTION_ICON, Glyph, NAV_ICON } from './ui/icons.jsx';
import { useRuns } from './api/queries.js';
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

function Shell({ me, onLogout }: { me: Me; onLogout: () => void }): JSX.Element {
  const route = useRoute();
  const [section] = route.segments;
  const runs = useRuns();

  // Dos números distintos: lo que está en marcha y lo que se paró mal. Mezclarlos haría que el
  // segundo pasara desapercibido, que es justo el que hay que mirar.
  const working = (runs.data?.runs ?? []).filter((run) =>
    ['queued', 'preparing', 'running', 'cancelling'].includes(run.status)).length;
  const attention = (runs.data?.runs ?? []).filter((run) =>
    run.status === 'waiting' || run.status === 'failed' || run.status === 'timed_out').length;

  const content = (() => {
    if (section === 'sessions') return <ExplorerScreen />;
    if (section === 'w' && route.segments[1]) return <WorkspaceScreen workspaceId={route.segments[1]} />;
    if (section === 'runs') return <RunCenterScreen runId={route.segments[1] ?? null} />;
    if (section === 'terminal') return <TerminalScreen query={route.query} />;
    if (section === 'health') return <HealthScreen />;
    return <HomeScreen />;
  })();

  const current = (path: string): 'page' | undefined =>
    (path === '/' ? route.path === '/' : route.path.startsWith(path)) ? 'page' : undefined;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Jarvis</span>
        <nav className="nav" aria-label="Secciones">
          <Link to="/" aria-current={current('/')}>
            <Glyph icon={NAV_ICON.home} size={17} />
            <span className="nav-text">Inicio</span>
          </Link>
          <Link to="/sessions" aria-current={current('/sessions')}>
            <Glyph icon={NAV_ICON.sessions} size={17} />
            <span className="nav-text">Sesiones</span>
          </Link>
          <Link to="/runs" aria-current={current('/runs')}>
            <Glyph icon={NAV_ICON.runs} size={17} />
            <span className="nav-text">Trabajo</span>
            {attention > 0 ? (
              <span className="count attention" title={`${attention} necesitan que mires`}>{attention}</span>
            ) : working > 0 ? (
              <span className="count" title={`${working} en marcha`}>{working}</span>
            ) : null}
          </Link>
          <Link to="/terminal" aria-current={current('/terminal')}>
            <Glyph icon={NAV_ICON.terminal} size={17} />
            <span className="nav-text">Terminal</span>
          </Link>
          <Link to="/health" aria-current={current('/health')}>
            <Glyph icon={NAV_ICON.health} size={17} />
            <span className="nav-text">Salud</span>
          </Link>
        </nav>
        <div className="topbar-right">
          <button type="button" className="btn small palette-button" onClick={openCommandPalette}
            title="Buscar y saltar a cualquier sitio (Ctrl+K)">
            <Glyph icon={NAV_ICON.sessions} />
            <span className="palette-button-text">Ir a…</span>
            <span className="kbd">Ctrl K</span>
          </button>
          {me.insecureLogin ? (
            <span className="badge warn insecure-badge" role="status"
              title="La entrada por contraseña sobre HTTP sigue abierta: todo viaja en claro">
              <Glyph icon={ACTION_ICON.insecure} />
              <span className="insecure-text">HTTP sin cifrar</span>
              <span className="visually-hidden">La conexión no está cifrada</span>
            </span>
          ) : null}
          <span className="small muted topbar-user">{me.user.displayName}</span>
          <button type="button" className="btn small" onClick={onLogout}>
            <Glyph icon={ACTION_ICON.logout} />
            <span className="logout-text">Salir</span>
          </button>
        </div>
      </header>
      <main>{content}</main>
      <CommandPalette />
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
      <Shell
        me={me}
        onLogout={() => {
          void post('/auth/logout').finally(() => {
            queryClient.clear();
            setMe(null);
          });
        }}
      />
    </QueryClientProvider>
  );
}
