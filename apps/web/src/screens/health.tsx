/**
 * Diagnóstico.
 *
 * Se puede copiar, y lo que se copia no lleva prompts, salida del agente ni secretos: sólo
 * versiones, estados por salto y códigos de error.
 */
import type { JSX } from 'react';
import { useState } from 'react';
import { useHealth, useHosts } from '../api/queries.js';
import { ErrorNote, Loading, relativeTime } from '../ui/bits.jsx';

export function HealthScreen(): JSX.Element {
  const health = useHealth();
  // Aquí sí interesa el estado real de cada máquina, aunque cueste una conexión por host.
  const hosts = useHosts({ probe: true });
  const [copied, setCopied] = useState(false);

  function copyDiagnostics(): void {
    const report = {
      at: new Date().toISOString(),
      core: health.data ? { version: health.data.version, status: health.data.status } : null,
      checks: health.data?.checks ?? {},
      hosts: (hosts.data?.hosts ?? []).map((host) => ({
        host: host.host,
        reachable: host.reachable,
        providers: host.providers,
        tmux: host.tmux,
        probedAt: host.probedAt,
        error: host.error ?? null,
      })),
    };
    void navigator.clipboard.writeText(JSON.stringify(report, null, 2)).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    });
  }

  return (
    <div className="page">
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Estado por salto</h2>
          <button type="button" className="btn small" onClick={copyDiagnostics}>
            {copied ? 'Copiado' : 'Copiar diagnóstico'}
          </button>
        </div>
        <p className="small muted">Sin prompts, sin salida de agente y sin credenciales.</p>
        {health.isLoading ? <Loading rows={4} /> : null}
        <ErrorNote error={health.error} />
        <div className="list">
          {Object.entries(health.data?.checks ?? {}).map(([name, check]) => (
            <div key={name} className="list-item" style={{ cursor: 'default' }}>
              <span className="row">
                <span className={`badge ${check.status === 'ok' ? 'ok' : check.status === 'failed' ? 'danger' : 'warn'}`}>
                  <span className="dot" aria-hidden="true" />{check.status}
                </span>
                <span className="mono small">{name}</span>
                {check.code ? <span className="small muted">{check.code}</span> : null}
              </span>
              {check.message ? <span className="small">{check.message}</span> : null}
              {check.lastOkAt ? <span className="small muted">último ok {relativeTime(check.lastOkAt)}</span> : null}
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Flota</h2>
        {hosts.isLoading ? <Loading rows={3} /> : null}
        <div className="list">
          {(hosts.data?.hosts ?? []).map((host) => (
            <div key={host.host} className="list-item" style={{ cursor: 'default' }}>
              <span className="row">
                <span className={`badge ${host.reachable ? (host.stale ? 'warn' : 'ok') : 'danger'}`}>
                  <span className="dot" aria-hidden="true" />{host.reachable ? (host.stale ? 'viejo' : 'ok') : 'inalcanzable'}
                </span>
                <span className="mono">{host.host}</span>
                {host.host === hosts.data?.bastionHost ? <span className="badge neutral">bastión</span> : null}
              </span>
              <span className="small muted">
                {host.providers.length ? `agentes: ${host.providers.join(', ')}` : 'sin CLI de agente'}
                {host.tmux ? ' · tmux' : ' · sin tmux'} · sondeado {relativeTime(host.probedAt)}
              </span>
              {host.error ? <span className="small" style={{ color: 'var(--danger)' }}>{host.error}</span> : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
