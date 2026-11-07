/**
 * Sesiones: la portada.
 *
 * Se agrupan por **dónde se ejecutaron**, que es como se piensa en ellas: «lo de jarvis», «lo de
 * wallet». Cada grupo es una tarjeta con el nombre corto de la carpeta —`jarvis`, no
 * `/var/www/jarvis`— y la ruta entera aparece al abrirlo, que es cuando hace falta. Todo va
 * ordenado por lo último que se movió, grupos y sesiones, porque casi siempre se viene a retomar.
 *
 * Tres niveles y un clic por nivel: grupo → sesión → abrir. Se cambió una tabla de cinco columnas
 * con cifras y vista previa lateral por esto a propósito: aquello había que leerlo; esto se recorre.
 *
 * El grupo abierto vive en la URL (`?g=jarvis`): al volver de una sesión se vuelve al mismo sitio.
 */
import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import type { SessionSummary } from '@jarvis/contracts';
import { useOpenWorkspace, useRuns, useSessions } from '../api/queries.js';
import { useRoute } from '../router.js';
import { terminalHref } from '../api/links.js';
import { Empty, ErrorNote, Link, Loading, StaleNote, relativeTime } from '../ui/bits.jsx';
import { ACTION_ICON, Glyph, NAV_ICON, PROVIDER_ICON, STATUS_ICON } from '../ui/icons.jsx';
import { NewSessionButton, openNewSession } from '../ui/new-session.jsx';
import { usePageMeta } from '../ui/page-meta.jsx';

/** El nombre corto de una carpeta: lo último de la ruta. */
export function folderName(cwd: string | null | undefined): string {
  if (!cwd) return 'sin carpeta';
  const parts = cwd.replace(/\/+$/, '').split('/').filter(Boolean);
  return parts.at(-1) ?? '/';
}

/** El nombre que hay que enseñar: el que se le puso aquí gana al que trae el índice. */
const sessionTitle = (session: SessionSummary): string =>
  session.workspaceTitle ?? session.title ?? session.ref.sessionId;

const sessionKey = (session: SessionSummary): string =>
  `${session.ref.host}:${session.ref.provider}:${session.ref.sessionId}`;

const activity = (session: SessionSummary): number =>
  Date.parse(session.lastActivityAt ?? session.startedAt ?? '') || 0;

export interface SessionGroup {
  name: string;
  sessions: SessionSummary[];
  /** Las rutas completas distintas que caen bajo este nombre, con su máquina. */
  paths: Array<{ host: string; cwd: string }>;
  hosts: string[];
  providers: string[];
  lastActivityAt: string | null;
}

/**
 * Agrupar por carpeta y ordenar por lo último.
 *
 * Se agrupa por el **nombre** y no por la ruta: `jarvis` en zeus y `jarvis` en goro1 son el mismo
 * proyecto para quien mira, y separarlos devolvería la lista larga que se quería quitar. Las rutas
 * se conservan en el grupo y se enseñan al abrirlo, así que no se pierde de dónde es cada una.
 */
export function groupSessions(rows: SessionSummary[]): SessionGroup[] {
  const groups = new Map<string, SessionSummary[]>();
  for (const row of rows) {
    const name = folderName(row.cwd);
    const list = groups.get(name) ?? [];
    list.push(row);
    groups.set(name, list);
  }
  return [...groups.entries()]
    .map(([name, sessions]) => {
      const sorted = [...sessions].sort((a, b) => activity(b) - activity(a));
      const paths = new Map<string, { host: string; cwd: string }>();
      for (const session of sorted) {
        if (session.cwd) paths.set(`${session.ref.host}|${session.cwd}`, { host: session.ref.host, cwd: session.cwd });
      }
      return {
        name,
        sessions: sorted,
        paths: [...paths.values()],
        hosts: [...new Set(sorted.map((session) => session.ref.host))],
        providers: [...new Set(sorted.map((session) => session.ref.provider))],
        lastActivityAt: sorted[0]?.lastActivityAt ?? sorted[0]?.startedAt ?? null,
      };
    })
    .sort((a, b) => (Date.parse(b.lastActivityAt ?? '') || 0) - (Date.parse(a.lastActivityAt ?? '') || 0));
}

export function SessionsScreen(): JSX.Element {
  usePageMeta({ title: 'Sesiones' });

  const route = useRoute();
  const openGroup = route.query.get('g');
  const [query, setQuery] = useState('');
  const [showEmpty, setShowEmpty] = useState(false);

  const sessions = useSessions(query ? { q: query } : {});
  const runs = useRuns();

  const rows = useMemo(() => sessions.data?.sessions ?? [], [sessions.data]);
  const empty = rows.filter((row) => row.empty);
  const groups = useMemo(
    () => groupSessions(showEmpty ? rows : rows.filter((row) => !row.empty)),
    [rows, showEmpty],
  );

  /** Qué workspaces tienen trabajo que se paró mal y nadie ha mirado. */
  const attention = useMemo(() => {
    const set = new Set<string>();
    for (const run of runs.data?.runs ?? []) {
      if (!run.acknowledgedAt && ['failed', 'timed_out', 'waiting'].includes(run.status)) set.add(run.workspaceId);
    }
    return set;
  }, [runs.data]);

  const toggleGroup = (name: string): void => {
    const params = new URLSearchParams(route.query);
    if (openGroup === name) params.delete('g'); else params.set('g', name);
    const search = params.toString();
    route.navigate(`${route.path}${search ? `?${search}` : ''}`, { replace: true });
  };

  return (
    <div className="page narrow sessions-page">
      <div className="toolbar">
        <div className="search-row grow">
          <Glyph icon={ACTION_ICON.search} size={16} className="search-glyph" />
          <input
            className="input"
            type="search"
            placeholder="Buscar por título, carpeta o máquina…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Buscar sesiones"
          />
        </div>
        <NewSessionButton className="btn primary" />
      </div>

      {sessions.data?.truncated ? (
        <p className="hint-line">
          Se ven las {rows.length} más recientes. Busca para llegar a las demás.
        </p>
      ) : null}
      <StaleNote stale={sessions.data?.stale} freshness={sessions.data?.freshness} />
      <ErrorNote error={sessions.error} onRetry={() => void sessions.refetch()} />

      {sessions.isLoading ? <Loading rows={5} shape="list" label="Buscando sesiones…" /> : null}

      {!sessions.isLoading && groups.length === 0 ? (
        query ? (
          <Empty icon={ACTION_ICON.search} title="Nada coincide"
            action={<button type="button" className="btn" onClick={() => setQuery('')}>Borrar la búsqueda</button>} />
        ) : sessions.data?.indexScannedAt == null ? (
          /*
           * Tras un reinicio el índice tarda unos minutos en recorrer la flota, y hasta entonces
           * «no hay sesiones» y «aún no he mirado» se verían igual. En el primer caso hay algo que
           * arreglar; en el segundo, sólo esperar.
           */
          <Empty icon={ACTION_ICON.timer} title="Todavía buscando sesiones en las máquinas"
            hint="Tarda unos minutos después de arrancar. Se llena solo." />
        ) : (
          <Empty icon={NAV_ICON.sessions} title="No hay sesiones en la flota"
            hint={`Último barrido ${relativeTime(sessions.data.indexScannedAt)}.`}
            action={<NewSessionButton />} />
        )
      ) : null}

      <div className="groups">
        {groups.map((group) => (
          <FolderGroup
            key={group.name}
            group={group}
            open={openGroup === group.name}
            onToggle={() => toggleGroup(group.name)}
            attention={attention}
          />
        ))}
      </div>

      {empty.length ? (
        <button type="button" className="linklike small faint-link" onClick={() => setShowEmpty((value) => !value)}
          title="Sesiones donde nadie llegó a escribir: el agente creó el fichero y nada más">
          {showEmpty
            ? 'Ocultar las vacías'
            : `${empty.length} ${empty.length === 1 ? 'sesión vacía oculta' : 'sesiones vacías ocultas'}`}
        </button>
      ) : null}
    </div>
  );
}

function ProviderIcons({ providers }: { providers: string[] }): JSX.Element {
  return (
    <span className="provider-icons" aria-label={providers.join(', ')}>
      {providers.map((provider) => (
        <Glyph key={provider} icon={PROVIDER_ICON[provider] ?? NAV_ICON.terminal} size={13} />
      ))}
    </span>
  );
}

function FolderGroup({ group, open, onToggle, attention }: {
  group: SessionGroup;
  open: boolean;
  onToggle: () => void;
  attention: Set<string>;
}): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  const latest = group.sessions[0];
  const failing = group.sessions.some((session) => session.workspaceId && attention.has(session.workspaceId));
  const count = group.sessions.length;

  return (
    <section className={`group-card ${open ? 'open' : ''}`}>
      <button type="button" className="group-head" aria-expanded={open} onClick={onToggle}>
        <span className="group-mark">
          <Glyph icon={open ? STATUS_ICON.folder : STATUS_ICON.folderClosed} size={18} />
        </span>
        <span className="group-main">
          <span className="group-title">
            <span className="truncate">{group.name}</span>
            {failing ? <span className="dot-status danger" title="Hay trabajo que se paró mal" /> : null}
            <span className="tiny faint nowrap group-when">{relativeTime(group.lastActivityAt)}</span>
          </span>
          <span className="group-sub">
            <span className="truncate">{count} {count === 1 ? 'sesión' : 'sesiones'} · {group.hosts.join(', ')}</span>
            <ProviderIcons providers={group.providers} />
          </span>
          {!open && latest ? <span className="group-latest truncate">{sessionTitle(latest)}</span> : null}
        </span>
      </button>

      {open ? (
        <div className="group-body">
          {group.paths.length ? (
            <div className="group-paths">
              {group.paths.map((path) => (
                <span key={`${path.host}|${path.cwd}`} className="path-chip" title={`${path.cwd} en ${path.host}`}>
                  <span className="faint">{path.host}:</span>
                  <span className="mono">{path.cwd}</span>
                </span>
              ))}
            </div>
          ) : null}
          <div className="session-list">
            {group.sessions.map((session) => (
              <SessionCard
                key={sessionKey(session)}
                session={session}
                open={selected === sessionKey(session)}
                onToggle={() => setSelected((value) => (value === sessionKey(session) ? null : sessionKey(session)))}
                failing={Boolean(session.workspaceId && attention.has(session.workspaceId))}
              />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function SessionCard({ session, open, onToggle, failing }: {
  session: SessionSummary;
  open: boolean;
  onToggle: () => void;
  failing: boolean;
}): JSX.Element {
  const route = useRoute();
  const openWorkspace = useOpenWorkspace();
  /*
   * Una sesión sin un solo turno no se puede continuar: el agente ni la reanuda ni reutiliza su
   * identificador. Lo que se ofrece primero es lo único que funciona: empezar otra en la misma
   * carpeta, con la máquina ya puesta.
   */
  const dead = session.resumable === false;

  async function go(): Promise<void> {
    if (session.workspaceId) {
      route.navigate(`/w/${session.workspaceId}`);
      return;
    }
    const result = await openWorkspace.mutateAsync({ ref: session.ref, cwd: session.cwd, title: session.title });
    route.navigate(`/w/${result.workspace.id}`);
  }

  return (
    <article className={`session-card ${open ? 'open' : ''}`}>
      <button type="button" className="session-head" aria-expanded={open} onClick={onToggle}>
        <Glyph icon={PROVIDER_ICON[session.ref.provider] ?? NAV_ICON.terminal} size={15} className="session-provider" />
        <span className="session-main">
          <span className="session-title truncate">{sessionTitle(session)}</span>
          <span className="session-sub truncate">
            {session.ref.host} · {session.ref.provider}
            {session.messageCount ? ` · ${session.messageCount} mensajes` : ''}
          </span>
        </span>
        <span className="session-side">
          {failing ? <span className="badge danger">con fallo</span>
            : session.empty ? <span className="badge neutral">vacía</span> : null}
          <span className="tiny faint nowrap">{relativeTime(session.lastActivityAt)}</span>
        </span>
      </button>

      {open ? (
        <div className="session-detail">
          <p className="mono small path-full" title="Dónde se ejecutó">
            <Glyph icon={STATUS_ICON.folder} size={13} />
            <span>{session.cwd ?? 'sin carpeta conocida'}</span>
          </p>
          {session.preview ? <p className="session-preview">{session.preview}</p> : null}
          {dead ? (
            <p className="tiny faint" style={{ margin: 0 }}>
              Nadie habló nunca en esta sesión, así que no hay nada que continuar.
            </p>
          ) : null}
          <div className="row">
            {dead ? (
              <button type="button" className="btn primary" onClick={() => openNewSession({
                host: session.ref.host, provider: session.ref.provider, cwd: session.cwd,
              })}>
                <Glyph icon={ACTION_ICON.new} />
                Empezar una aquí
              </button>
            ) : null}
            <button type="button" className={`btn ${dead ? '' : 'primary'}`} disabled={openWorkspace.isPending}
              onClick={() => void go()}>
              <Glyph icon={ACTION_ICON.open} />
              {openWorkspace.isPending ? 'Abriendo…' : 'Abrir'}
            </button>
            <Link className="btn" to={terminalHref({
              host: session.ref.host,
              provider: session.ref.provider,
              sessionId: session.ref.sessionId,
              from: session.workspaceId,
            })}>
              <Glyph icon={NAV_ICON.terminal} />
              Terminal
            </Link>
            {!dead ? (
              <button type="button" className="btn ghost" onClick={() => openNewSession({
                host: session.ref.host, provider: session.ref.provider, cwd: session.cwd,
              })} title="Empezar otra sesión en la misma carpeta y máquina">
                <Glyph icon={ACTION_ICON.new} />
                Nueva aquí
              </button>
            ) : null}
          </div>
          <ErrorNote error={openWorkspace.error} />
        </div>
      ) : null}
    </article>
  );
}
