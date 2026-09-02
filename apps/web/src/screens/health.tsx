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
import { checkName, HEALTH } from '../ui/labels.js';
import { ACTION_ICON, Glyph, HEALTH_ICON } from '../ui/icons.jsx';

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
            <Glyph icon={copied ? ACTION_ICON.approve : ACTION_ICON.copy} />
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
                <span className={`badge ${HEALTH[check.status]?.tone ?? 'neutral'}`}>
                  <Glyph icon={HEALTH_ICON[check.status] ?? HEALTH_ICON['unknown'] as never} />
                  {HEALTH[check.status]?.name ?? check.status}
                </span>
                <span>{checkName(name).title}</span>
                <span className="mono small muted">{name}</span>
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
                  <Glyph icon={host.reachable
                    ? (host.stale ? HEALTH_ICON['stale'] as never : HEALTH_ICON['ok'] as never)
                    : HEALTH_ICON['failed'] as never} />
                  {host.reachable ? (host.stale ? 'sin refrescar' : 'bien') : 'no responde'}
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
