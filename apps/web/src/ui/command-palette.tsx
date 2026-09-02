/**
 * La paleta de comandos.
 *
 * Es el atajo del flujo que más se repite: volver a un contexto. Con Ctrl+K se escribe lo que se
 * recuerda —el nombre de un workspace, un host, «salud»— y se llega sin pasar por tres pantallas.
 *
 * Busca en lo que ya está cargado y, además, en el índice de sesiones: retomar trabajo no debería
 * exigir saber si esa sesión ya se abrió alguna vez.
 */
import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Command } from 'cmdk';
import { useHosts, useOpenWorkspace, useSessions, useWorkspaces } from '../api/queries.js';
import { navigate } from '../router.js';
import { relativeTime } from './bits.jsx';
import { openNewSession } from './new-session.jsx';
import { ACTION_ICON, Glyph, NAV_ICON } from './icons.jsx';

/** Abrir la paleta desde cualquier parte, sin pasar el estado por media aplicación. */
export const openCommandPalette = (): void => {
  window.dispatchEvent(new Event('jarvis:palette'));
};

export function CommandPalette(): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const workspaces = useWorkspaces();
  const hosts = useHosts();
  const openWorkspace = useOpenWorkspace();
  // Buscar en el índice sólo cuando hay algo escrito: cada pulsación no puede costar una consulta.
  const sessions = useSessions(query.length >= 3 ? { q: query } : {});

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((previous) => !previous);
      }
      if (event.key === 'Escape') setOpen(false);
    };
    // Hay navegadores que se quedan Ctrl+K para su propia barra, así que además hay un botón: un
    // atajo que a veces no llega no puede ser la única puerta.
    const onRequest = (): void => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('jarvis:palette', onRequest);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('jarvis:palette', onRequest);
    };
  }, []);

  const go = (to: string): void => {
    setOpen(false);
    setQuery('');
    navigate(to);
  };

  const knownWorkspaces = workspaces.data?.workspaces ?? [];
  const openedKeys = useMemo(
    () => new Set(knownWorkspaces.map((workspace) =>
      `${workspace.ref.host}|${workspace.ref.provider}|${workspace.ref.sessionId}`)),
    [knownWorkspaces],
  );

  if (!open) return null;

  return (
    <div className="palette-backdrop" role="presentation" onClick={() => setOpen(false)}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Ir a"
        onClick={(event) => event.stopPropagation()}>
        <Command shouldFilter label="Ir a">
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Ir a un workspace, una sesión, un host…"
          />
          <Command.List>
            <Command.Empty>
              {query.length >= 3 ? 'Nada con ese nombre.' : 'Escribe para buscar también en el índice.'}
            </Command.Empty>

            <Command.Group heading="Continuar">
              {knownWorkspaces.slice(0, 6).map((workspace) => (
                <Command.Item
                  key={workspace.id}
                  value={`${workspace.title ?? ''} ${workspace.ref.sessionId} ${workspace.ref.host}`}
                  onSelect={() => go(`/w/${workspace.id}`)}
                >
                  <span className="row" style={{ gap: 8, flexWrap: 'nowrap', minWidth: 0 }}>
                    <Glyph icon={ACTION_ICON.open} />
                    <span className="palette-label">{workspace.title ?? workspace.ref.sessionId}</span>
                  </span>
                  <span className="palette-hint">
                    {workspace.ref.provider} · {workspace.ref.host} · {relativeTime(workspace.lastOpenedAt)}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>

            {query.length >= 3 ? (
              <Command.Group heading="Sesiones del índice">
                {(sessions.data?.sessions ?? [])
                  .filter((session) => !openedKeys.has(
                    `${session.ref.host}|${session.ref.provider}|${session.ref.sessionId}`,
                  ))
                  // Una sesión donde nadie llegó a hablar no es un sitio al que volver: el agente
                  // escribió el fichero al arrancar y ahí se quedó.
                  .filter((session) => !session.empty)
                  .slice(0, 6)
                  .map((session) => (
                    <Command.Item
                      key={`${session.ref.host}:${session.ref.sessionId}`}
                      value={`${session.title ?? ''} ${session.ref.sessionId}`}
                      onSelect={() => {
                        void openWorkspace.mutateAsync({
                          ref: session.ref, cwd: session.cwd, title: session.title,
                        }).then((result) => go(`/w/${result.workspace.id}`));
                      }}
                    >
                      <span className="row" style={{ gap: 8, flexWrap: 'nowrap', minWidth: 0 }}>
                        <Glyph icon={ACTION_ICON.session} />
                        <span className="palette-label">
                          {session.workspaceTitle ?? session.title ?? session.ref.sessionId}
                        </span>
                      </span>
                      <span className="palette-hint">
                        abrir · {session.ref.provider} · {session.ref.host}
                      </span>
                    </Command.Item>
                  ))}
              </Command.Group>
            ) : null}

            <Command.Group heading="Terminales">
              {(hosts.data?.hosts ?? []).filter((host) => host.tmux).map((host) => (
                <Command.Item
                  key={host.host}
                  value={`terminal ${host.host}`}
                  onSelect={() => go(`/terminal?host=${encodeURIComponent(host.host)}`)}
                >
                  <span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                    <Glyph icon={NAV_ICON.terminal} />
                    Terminal en {host.host}
                  </span>
                  <span className="palette-hint">{host.providers.join(', ') || 'sin agentes'}</span>
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Group heading="Empezar">
              <Command.Item value="nueva sesion empezar de cero estrenar"
                onSelect={() => { setOpen(false); openNewSession(); }}>
                <span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                  <Glyph icon={ACTION_ICON.new} />
                  Empezar una sesión desde cero
                </span>
                <span className="palette-hint">elige agente, máquina y carpeta</span>
              </Command.Item>
            </Command.Group>

            <Command.Group heading="Ir a">
              <Command.Item value="inicio portada" onSelect={() => go('/')}>
                <span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                  <Glyph icon={NAV_ICON.home} />Inicio
                </span>
              </Command.Item>
              <Command.Item value="sesiones buscar" onSelect={() => go('/sessions')}>
                <span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                  <Glyph icon={NAV_ICON.sessions} />Buscar sesiones
                </span>
              </Command.Item>
              <Command.Item value="runs trabajo" onSelect={() => go('/runs')}>
                <span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                  <Glyph icon={NAV_ICON.runs} />Trabajo en curso
                </span>
              </Command.Item>
              <Command.Item value="salud diagnostico" onSelect={() => go('/health')}>
                <span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                  <Glyph icon={NAV_ICON.health} />Salud y diagnóstico
                </span>
              </Command.Item>
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
