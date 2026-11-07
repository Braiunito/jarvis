/**
 * El armazón.
 *
 * Cuatro destinos y nada más: Sesiones —que es la portada, porque casi siempre se viene a
 * retomar algo—, Trabajo, Terminal y Salud. Arriba, dónde estoy y el buscador. En un teléfono el
 * carril baja y se queda en iconos.
 *
 * Lo que había además —una portada de tarjetas, el asistente, la barra de estado de abajo— se
 * quitó: duplicaba lo que ya dicen estas cuatro pantallas y obligaba a leer más para lo mismo.
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
import { NewSessionDialog } from './ui/new-session.jsx';
import { ACTION_ICON, Glyph, NAV_ICON } from './ui/icons.jsx';
import { PageMetaProvider, usePageMetaValue } from './ui/page-meta.jsx';
import { LoginScreen } from './screens/login.jsx';
import { EnrollScreen } from './screens/enroll.jsx';
import { Boundary } from './ui/boundary.jsx';
import { SessionsScreen } from './screens/explorer.jsx';
import { WorkspaceScreen } from './screens/workspace.jsx';
import { RunCenterScreen } from './screens/runs.jsx';
import { HealthScreen } from './screens/health.jsx';
import { TerminalScreen } from './screens/terminal.jsx';

interface Me {
  authenticated: boolean;
  user: { username: string; displayName: string };
  insecureLogin?: boolean;
  /**
   * El modo de pruebas: no se pidió nada para entrar.
   *
   * Se enseña **mientras se trabaja** y no sólo al entrar, porque con este modo nadie pasa por el
   * login: un aviso que viviera en la pantalla de acceso no lo vería nunca nadie. Lo peligroso de
   * este modo no es tenerlo, es olvidarlo puesto.
   */
  testNoAuth?: boolean;
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

function Rail({ working, attention, insecure, terminals }: {
  working: number;
  attention: number;
  insecure: boolean;
  /** Terminales abiertas, o null si todavía no se ha contado ninguna vez. */
  terminals: number | null;
}): JSX.Element {
  const route = useRoute();
  const health = useHealth();
  const [collapsed, setCollapsed] = useState(() => window.localStorage.getItem(RAIL_KEY) === '1');

  useEffect(() => {
    document.querySelector('.shell')?.classList.toggle('collapsed', collapsed);
    window.localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  /** Una sesión abierta (`/w/…`) sigue siendo «Sesiones»: es donde se llegó. */
  const sessionsActive = route.path === '/' || route.path.startsWith('/sessions') || route.path.startsWith('/w/');
  const current = (path: string): 'page' | undefined =>
    (path === '/' ? sessionsActive : route.path.startsWith(path)) ? 'page' : undefined;

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
          {/*
            * Sólo cuando se ha contado de verdad: un cero que en realidad es «no lo sé» hace creer
            * que no hay nada abierto, y eso es peor que no enseñar nada.
            */}
          {terminals !== null && terminals > 0 ? (
            <span className="count" title={`${terminals} sesión(es) de terminal abiertas`}>{terminals}</span>
          ) : null}
        </Link>
        <Link to="/health" aria-current={current('/health')}>
          <Glyph icon={NAV_ICON.health} size={17} />
          <span>Salud</span>
          {insecure ? <span className="count attention" title="La conexión no está cifrada">!</span> : null}
          {!insecure && tone !== 'ok' && tone !== 'neutral' ? (
            <span className={`count ${tone === 'danger' ? 'attention' : 'warn'}`} title="Algo no va bien">!</span>
          ) : null}
        </Link>
      </nav>

      <div className="rail-status">
        <span className={`dot-status ${tone}`} aria-hidden="true" />
        <span className="truncate">
          {status === 'ok' ? 'Conectado' : status === 'unknown' ? 'Conectando…' : 'Con incidencias'}
        </span>
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
    !run.acknowledgedAt
    && (run.status === 'waiting' || run.status === 'failed' || run.status === 'timed_out')).length;
  const terminals = metrics.data?.terminals;
  const openTerminals = terminals && terminals.at !== null ? terminals.open : null;

  /*
   * La última red, por pantalla.
   *
   * Los anillos de dentro —cada turno de un hilo— hacen que un dato malo caiga solo. Éste es
   * para lo que nadie previó: sin él, cualquier excepción de render deja la ventana **en blanco**,
   * sin navegación y sin forma de irse a otro sitio, que es la peor cara que puede poner una consola.
   * Va por sección y no en la raíz para que el carril, la cabecera y los demás destinos sobrevivan:
   * lo que falla es una pantalla, no la aplicación.
   */
  const content = (() => {
    const pantalla = (() => {
      if (section === 'w' && route.segments[1]) return <WorkspaceScreen workspaceId={route.segments[1]} />;
      if (section === 'runs') return <RunCenterScreen runId={route.segments[1] ?? null} />;
      if (section === 'terminal') return <TerminalScreen query={route.query} />;
      if (section === 'health') return <HealthScreen />;
      // `/sessions` sigue valiendo: hay enlaces viejos guardados que apuntan ahí.
      return <SessionsScreen />;
    })();
    return <Boundary what={`la pantalla «${meta.title}»`} key={section}>{pantalla}</Boundary>;
  })();

  return (
    <div className="shell">
      {/* Lo primero del orden de tabulación: cuatro destinos antes del contenido son nueve saltos. */}
      <a className="skip-link" href="#contenido"
        onClick={(event) => {
          event.preventDefault();
          const main = document.getElementById('contenido');
          main?.focus();
          main?.scrollIntoView();
        }}>
        Saltar al contenido
      </a>
      <Rail working={working} attention={attention}
        insecure={Boolean(me.insecureLogin) || Boolean(me.testNoAuth)}
        terminals={openTerminals} />

      <div className="workarea">
        <header className="topbar">
          <div className="page-heading">
            {/* Las migas y el título en una línea: «Sesiones › app». Repetirlo en dos era ruido. */}
            {meta.parent ? (
              <span className="crumb">
                <Link to={meta.parent.to}>{meta.parent.label}</Link>
                <Glyph icon={ACTION_ICON.chevron} size={14} />
              </span>
            ) : null}
            <h1 className="truncate">{meta.title}</h1>
          </div>

          <button type="button" className="topbar-search" onClick={openCommandPalette}
            aria-label="Buscar y saltar a cualquier sitio">
            <Glyph icon={ACTION_ICON.search} size={16} />
            <span className="grow">Buscar…</span>
            <span className="kbd">Ctrl K</span>
          </button>

          <div className="topbar-right">
            {/*
              * Sólo se dice algo cuando hay algo que decir.
              *
              * Sin autenticación es más grave que sin cifrar: sin cifrar, alguien que ya está en
              * la red puede leer lo que pasa; sin autenticación, cualquiera que llegue **es** tú.
              * Por eso va en rojo y lo dice con esas palabras. Con todo en orden no se pinta nada:
              * un «conexión segura» fijo es una etiqueta que se deja de leer al segundo día.
              */}
            {me.testNoAuth ? (
              <Link to="/health" className="chip danger"
                title="Modo de pruebas: no se pide autenticación. Cualquiera que llegue a esta red
                  entra como tú, y detrás está la clave de la flota.">
                <Glyph icon={ACTION_ICON.insecure} />
                <span className="chip-text">Sin autenticación</span>
              </Link>
            ) : me.insecureLogin ? (
              <Link to="/health" className="chip warn"
                title="La entrada por contraseña sobre HTTP sigue abierta: todo viaja en claro">
                <Glyph icon={ACTION_ICON.insecure} />
                <span className="chip-text">HTTP sin cifrar</span>
              </Link>
            ) : null}
            <span className="avatar" title={me.user.displayName} aria-hidden="true">
              {me.user.displayName.slice(0, 1).toUpperCase()}
            </span>
            <button type="button" className="btn small icon ghost" onClick={onLogout}
              aria-label={`Salir (${me.user.displayName})`} title="Salir">
              <Glyph icon={ACTION_ICON.logout} />
            </button>
          </div>
        </header>

        <main id="contenido" tabIndex={-1}>{content}</main>
      </div>

      <CommandPalette />
      <NewSessionDialog />
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
  /*
   * `/enroll` va ANTES de la comprobación de sesión, y tiene que ser así: quien
   * llega con un código de enrolamiento todavía no puede entrar —esa es la
   * situación—, así que mandarlo al login lo dejaba sin ningún sitio donde
   * escribirlo. Lo que protege esta ruta es el código, que caduca a los 15
   * minutos y muere en su primer uso correcto.
   */
  if (window.location.pathname.replace(/\/+$/, '') === '/enroll') return <EnrollScreen />;
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
