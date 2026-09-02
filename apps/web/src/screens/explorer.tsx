/**
 * Explorador de sesiones.
 *
 * Buscar es una consulta, no una navegación: filtrar aquí no puede cambiar el workspace activo
 * ni invalidar el que ya estabas mirando. Abrir una sesión es lo único que cambia de contexto, y
 * es atómico: o estás entero en A, o entero en B.
 */
import type { JSX } from 'react';
import { useState } from 'react';
import { useOpenWorkspace, useSessions } from '../api/queries.js';
import { navigate } from '../router.js';
import { Empty, ErrorNote, Loading, StaleNote, relativeTime } from '../ui/bits.jsx';
import { ACTION_ICON, Glyph, NAV_ICON } from '../ui/icons.jsx';
import type { SessionSummary } from '@jarvis/contracts';

export function ExplorerScreen(): JSX.Element {
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('');
  const [selected, setSelected] = useState<SessionSummary | null>(null);
  const sessions = useSessions({ ...(query ? { q: query } : {}), ...(provider ? { provider } : {}) });
  const open = useOpenWorkspace();

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
      <div className="card">
        <div className="row search-row">
          <Glyph icon={NAV_ICON.sessions} size={17} className="search-glyph" />
          <input
            className="input"
            style={{ flex: '1 1 240px' }}
            placeholder="Buscar en prompts y respuestas…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Buscar sesiones"
          />
          <select className="select control-md" value={provider}
            onChange={(event) => setProvider(event.target.value)} aria-label="Filtrar por proveedor">
            <option value="">Todos</option>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
            <option value="opencode">OpenCode</option>
          </select>
        </div>
        <p className="small muted" style={{ margin: '8px 0 0' }} aria-live="polite">
          {sessions.data ? `${sessions.data.sessions.length} sesiones · índice consultado ${relativeTime(sessions.data.fetchedAt)}` : ' '}
        </p>
      </div>

      <StaleNote stale={sessions.data?.stale} freshness={sessions.data?.freshness} />
      <ErrorNote error={sessions.error} />

      <div className="grid-2" style={{ marginTop: 12 }}>
        <div className="card">
          <h2>Sesiones</h2>
          {sessions.isLoading ? <Loading rows={5} /> : null}
          {!sessions.isLoading && (sessions.data?.sessions.length ?? 0) === 0 ? (
            <Empty title="Ninguna sesión coincide" hint="Prueba con otras palabras o quita el filtro de proveedor." />
          ) : null}
          <div className="list">
            {(sessions.data?.sessions ?? []).map((session) => (
              <button
                key={`${session.ref.host}:${session.ref.provider}:${session.ref.sessionId}`}
                type="button"
                className="list-item"
                aria-current={selected?.ref.sessionId === session.ref.sessionId}
                onClick={() => setSelected(session)}
              >
                <span className="title">{session.title ?? session.ref.sessionId}</span>
                <span className="small muted">
                  {session.ref.provider} · {session.ref.host}
                  {session.cwd ? ` · ${session.cwd}` : ''} · {relativeTime(session.lastActivityAt)}
                </span>
                {session.workspaceId ? <span className="badge ok">ya abierta</span> : null}
              </button>
            ))}
          </div>
        </div>

        <div className="card">
          <h2>Vista previa</h2>
          {!selected ? (
            <p className="muted small" style={{ margin: 0 }}>Elige una sesión para ver de qué iba antes de abrirla.</p>
          ) : (
            <div className="stack">
              <div>
                <p style={{ margin: 0, fontWeight: 600 }}>{selected.title ?? selected.ref.sessionId}</p>
                <p className="small muted mono" style={{ margin: '4px 0 0' }}>
                  {selected.ref.host} · {selected.ref.provider} · {selected.ref.sessionId}
                </p>
              </div>
              {selected.preview ? <p className="small" style={{ margin: 0 }}>{selected.preview}</p> : null}
              <dl className="small muted" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 10px', margin: 0 }}>
                <dt>Directorio</dt><dd className="mono" style={{ margin: 0 }}>{selected.cwd ?? '—'}</dd>
                <dt>Mensajes</dt><dd style={{ margin: 0 }}>{selected.messageCount ?? '—'}</dd>
                <dt>Última actividad</dt><dd style={{ margin: 0 }}>{relativeTime(selected.lastActivityAt)}</dd>
              </dl>
              <button type="button" className="btn primary" disabled={open.isPending}
                onClick={() => void openSession(selected)}>
                <Glyph icon={ACTION_ICON.open} />
                {open.isPending ? 'Abriendo…' : selected.workspaceId ? 'Ir al workspace' : 'Abrir workspace'}
              </button>
              <ErrorNote error={open.error} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
