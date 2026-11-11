/**
 * El armazón.
 *
 * Tres destinos en el carril: Sesiones —que es la portada, porque casi siempre se viene a
 * retomar algo—, Trabajo y Terminal. Arriba, dónde estoy, el buscador, la campana de Alertas y
 * el escudo, que es el estado de todo y la única puerta a Salud. En un teléfono el carril baja,
 * se queda en iconos y Sesiones pasa al centro, entre Trabajo y Terminal.
 *
 * Lo que había además —una portada de tarjetas, el asistente, la barra de estado de abajo— se
 * quitó: duplicaba lo que ya dicen estas cuatro pantallas y obligaba a leer más para lo mismo.
 *
 * La URL manda: el workspace, el run o la terminal activos están ahí, no en un estado escondido.
 */
import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { get, post, UnauthenticatedError } from './api/client.js';
import { onWorkerMessage } from './api/push.js';
import { keys, useAlertBadge, useHealth, useMetrics, useRuns } from './api/queries.js';
import { navigate, useRoute } from './router.js';
import { Announcer } from './ui/announce.jsx';
import { Link } from './ui/bits.jsx';
import { CommandPalette, openCommandPalette } from './ui/command-palette.jsx';
import { NewSessionDialog } from './ui/new-session.jsx';
import { ACTION_ICON, BELL_ICON, Glyph, NAV_ICON, SHIELD_ICON } from './ui/icons.jsx';
import { IMPORTANCE } from './ui/labels.js';
import { PageMetaProvider, usePageMetaValue } from './ui/page-meta.jsx';
import { LoginScreen } from './screens/login.jsx';
import { EnrollScreen } from './screens/enroll.jsx';
import { Boundary } from './ui/boundary.jsx';
import { SessionsScreen } from './screens/explorer.jsx';
import { WorkspaceScreen } from './screens/workspace.jsx';
import { RunCenterScreen } from './screens/runs.jsx';
import { HealthScreen } from './screens/health.jsx';
import { TerminalScreen } from './screens/terminal.jsx';
import { AlertsScreen } from './screens/alerts.jsx';

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

function Rail({ working, attention, terminals }: {
  working: number;
  attention: number;
  /** Terminales abiertas, o null si todavía no se ha contado ninguna vez. */
  terminals: number | null;
}): JSX.Element {
  const route = useRoute();
  const [collapsed, setCollapsed] = useState(() => window.localStorage.getItem(RAIL_KEY) === '1');

  useEffect(() => {
    document.querySelector('.shell')?.classList.toggle('collapsed', collapsed);
    window.localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  /** Una sesión abierta (`/w/…`) sigue siendo «Sesiones»: es donde se llegó. */
  const sessionsActive = route.path === '/' || route.path.startsWith('/sessions') || route.path.startsWith('/w/');
  const current = (path: string): 'page' | undefined =>
    (path === '/' ? sessionsActive : route.path.startsWith(path)) ? 'page' : undefined;

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
        <Link to="/runs" className="nav-runs" aria-current={current('/runs')}>
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
      </nav>

      <button type="button" className="rail-collapse" onClick={() => setCollapsed((value) => !value)}
        title={collapsed ? 'Ampliar el menú' : 'Colapsar el menú'}
        aria-label={collapsed ? 'Ampliar el menú' : 'Colapsar el menú'}>
        <Glyph icon={collapsed ? ACTION_ICON.expand : ACTION_ICON.collapse} />
        <span>Colapsar</span>
      </button>
    </aside>
  );
}

/**
 * El escudo: el estado de todo y la única puerta a Salud.
 *
 * Antes Salud tenía su sitio en el carril y además había aquí un chip cuando la conexión no era
 * segura, y abajo un «Conectado»: tres sitios para una sola pregunta, «¿va todo bien?». Ahora es
 * uno, y siempre en el mismo sitio.
 *
 * Con todo en orden es un escudo verde con la palabra en gris, que no pide que lo mires. Cuando
 * algo falla cambian la forma, el color y la palabra, y la palabra dice lo más grave: entrar sin
 * autenticación pesa más que un host caído, y un fallo más que ir por HTTP. Lo demás se cuenta en
 * el `title`, para no hacer un chip de tres líneas.
 *
 * Sin autenticación es más grave que sin cifrar: sin cifrar, alguien que ya está en la red puede
 * leer lo que pasa; sin autenticación, cualquiera que llegue **es** tú.
 */
function HealthShield({ me }: { me: Me }): JSX.Element {
  const route = useRoute();
  const health = useHealth();
  const status = health.data?.status ?? null;
  const unreachable = !health.data && health.isError;

  const problems: string[] = [];
  if (me.testNoAuth) problems.push('Modo de pruebas: no se pide autenticación. Cualquiera que llegue a esta red entra como tú, y detrás está la clave de la flota.');
  if (unreachable) problems.push('El core no responde a la comprobación de salud.');
  if (status === 'failed') problems.push('Alguna comprobación ha fallado.');
  if (me.insecureLogin) problems.push('La entrada por contraseña sobre HTTP sigue abierta: todo viaja en claro.');
  if (status === 'degraded') problems.push('Alguna comprobación va con problemas.');

  const [tone, icon, word] = me.testNoAuth
    ? ['danger', SHIELD_ICON.insecure, 'Sin autenticación'] as const
    : unreachable
      ? ['danger', SHIELD_ICON.danger, 'Sin respuesta'] as const
      : status === 'failed'
        ? ['danger', SHIELD_ICON.danger, 'Con fallos'] as const
        : me.insecureLogin
          ? ['warn', SHIELD_ICON.insecure, 'HTTP sin cifrar'] as const
          : status === 'degraded'
            ? ['warn', SHIELD_ICON.warn, 'Con avisos'] as const
            : status === 'ok'
              ? ['ok', SHIELD_ICON.ok, 'Salud'] as const
              : ['neutral', SHIELD_ICON.neutral, 'Salud'] as const;

  const summary = problems.length > 0
    ? problems.join(' ')
    : status === 'ok' ? 'Todo en orden.' : 'Comprobando…';

  return (
    <Link to="/health" className={`chip health-shield ${tone}`}
      aria-current={route.path.startsWith('/health') ? 'page' : undefined}
      aria-label={word === 'Salud' ? `Salud: ${summary}` : `Salud: ${word}`}
      title={`${summary} Abre Salud.`}>
      <Glyph icon={icon} />
      <span className="chip-text">{word}</span>
    </Link>
  );
}

/**
 * La campana, al lado del escudo: lo que alguien quiso que supieras, y la puerta a Alertas.
 *
 * Mismo patrón que el escudo y por lo mismo: un solo sitio, siempre igual, que no pide atención
 * cuando no hay nada. Sin nada sin leer es una campana gris; con algo, el número y el tono de la
 * más grave de las pendientes —una normal no pinta igual que una crítica—, y la forma cambia
 * además del color.
 *
 * Instalada como aplicación, el mismo número va al icono de la pantalla de inicio.
 */
function AlertsBell(): JSX.Element {
  const route = useRoute();
  const badge = useAlertBadge();
  const unread = badge.data?.unread ?? 0;
  const top = badge.data?.unreadTop ?? null;

  useEffect(() => {
    const app = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    try {
      if (unread > 0) void app.setAppBadge?.(unread).catch(() => undefined);
      else void app.clearAppBadge?.().catch(() => undefined);
    } catch {
      // Un navegador sin insignias no tiene por qué saberlo nadie.
    }
  }, [unread]);

  const label = top ? IMPORTANCE[top] : null;
  const tone = unread === 0 || !label ? 'quiet' : label.tone;
  const icon = unread === 0 ? BELL_ICON.idle
    : top === 'high' || top === 'critical' ? BELL_ICON.ringing : BELL_ICON.unread;
  const count = unread > 99 ? '99+' : String(unread);
  const summary = unread === 0
    ? 'Ninguna alerta sin leer.'
    : `${unread} sin leer${label ? `; la más grave, de importancia ${label.name.toLowerCase()}` : ''}.`;

  return (
    <Link to="/alerts" className={`chip alerts-bell ${tone}`}
      aria-current={route.path.startsWith('/alerts') ? 'page' : undefined}
      aria-label={`Alertas: ${summary}`}
      title={`${summary} Abre Alertas.`}>
      <Glyph icon={icon} />
      <span className="chip-text">Alertas</span>
      {unread > 0 ? <span className="alerts-count" aria-hidden="true">{count}</span> : null}
    </Link>
  );
}

/**
 * Lo que cuenta el service worker a la ventana abierta.
 *
 * Una alerta nueva invalida todo lo de alertas para que la campana cambie sin esperar al sondeo;
 * tocar una notificación con la consola abierta la lleva a su enlace sin recargar.
 */
function useWorkerMessages(): void {
  const client = useQueryClient();
  useEffect(() => onWorkerMessage((message) => {
    if (message.type === 'jarvis:alert') void client.invalidateQueries({ queryKey: keys.alerts });
    if (message.type === 'jarvis:navigate' && message.url.startsWith('/') && !message.url.startsWith('//')) {
      navigate(message.url);
      void client.invalidateQueries({ queryKey: keys.alerts });
    }
  }), [client]);
}

function Shell({ me, onLogout }: { me: Me; onLogout: () => void }): JSX.Element {
  const route = useRoute();
  const [section] = route.segments;
  const runs = useRuns();
  const metrics = useMetrics(24);
  const meta = usePageMetaValue();
  useWorkerMessages();

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
      if (section === 'alerts') return <AlertsScreen />;
      // `/sessions` sigue valiendo: hay enlaces viejos guardados que apuntan ahí.
      return <SessionsScreen />;
    })();
    return <Boundary what={`la pantalla «${meta.title}»`} key={section}>{pantalla}</Boundary>;
  })();

  return (
    <div className="shell">
      {/* Lo primero del orden de tabulación: el carril y la cabecera antes del contenido son muchos saltos. */}
      <a className="skip-link" href="#contenido"
        onClick={(event) => {
          event.preventDefault();
          const main = document.getElementById('contenido');
          main?.focus();
          main?.scrollIntoView();
        }}>
        Saltar al contenido
      </a>
      <Rail working={working} attention={attention} terminals={openTerminals} />

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
            <AlertsBell />
            <HealthShield me={me} />
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
