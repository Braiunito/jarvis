/**
 * Salud: dónde duele y desde cuándo.
 *
 * Se puede copiar, y lo que se copia no lleva prompts, salida del agente ni secretos: sólo
 * versiones, estados por salto y códigos de error. Esa contención es el motivo de que se pueda
 * pegar en un chat sin pensárselo.
 */
import type { JSX } from 'react';
import { useState } from 'react';
import { useHealth, useHosts } from '../api/queries.js';
import { ErrorNote, Loading, relativeTime } from '../ui/bits.jsx';
import { Meter } from '../ui/charts.jsx';
import { checkName, HEALTH } from '../ui/labels.js';
import { ACTION_ICON, Glyph, HEALTH_ICON, NAV_ICON, STATUS_ICON } from '../ui/icons.jsx';
import { usePageMeta } from '../ui/page-meta.jsx';
import { Card, Stat, formatDuration } from '../ui/primitives.jsx';

export function HealthScreen(): JSX.Element {
  usePageMeta({ title: 'Salud', subtitle: 'El estado de cada salto, con su evidencia' });

  const health = useHealth();
  // Aquí sí interesa el estado real de cada máquina, aunque cueste una conexión por host.
  const hosts = useHosts({ probe: true });
  const [copied, setCopied] = useState(false);

  const checks = Object.entries(health.data?.checks ?? {});
  const okChecks = checks.filter(([, check]) => check.status === 'ok').length;
  const fleet = hosts.data?.hosts ?? [];
  const reachable = fleet.filter((host) => host.reachable).length;
  const system = health.data?.system;
  const insecure = window.location.protocol !== 'https:';

  function copyDiagnostics(): void {
    const report = {
      at: new Date().toISOString(),
      core: health.data ? { version: health.data.version, status: health.data.status } : null,
      checks: health.data?.checks ?? {},
      hosts: fleet.map((host) => ({
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
      {insecure ? (
        <p className="note warn" role="status">
          <Glyph icon={ACTION_ICON.insecure} size={16} />
          <span>
            Esta página no viaja cifrada. Mientras siga así, las passkeys no funcionan —el
            navegador no las expone fuera de un contexto seguro— y la entrada por contraseña
            queda abierta. Con certificado, se apaga.
          </span>
        </p>
      ) : null}

      <div className="grid cols-4">
        <Card>
          <Stat value={okChecks} label={`de ${checks.length} comprobaciones bien`} />
          <Meter value={okChecks} max={Math.max(1, checks.length)}
            tone={okChecks === checks.length ? 'ok' : 'danger'} />
        </Card>
        <Card>
          <Stat value={reachable} label={`de ${fleet.length} máquinas responden`} />
          <Meter value={reachable} max={Math.max(1, fleet.length)}
            tone={reachable === fleet.length ? 'ok' : 'warn'} />
        </Card>
        <Card>
          <Stat value={system ? formatDuration(system.uptimeSeconds * 1000) : '—'} label="el core lleva en pie"
            hint={health.data ? `versión ${health.data.version}` : undefined} />
        </Card>
        <Card>
          <Stat value={system?.sqlite ?? '—'} label="SQLite"
            hint={system ? `Node ${system.node}` : undefined} />
        </Card>
      </div>

      <Card title="Estado por salto" icon={NAV_ICON.health} count={checks.length}
        actions={
          <button type="button" className="btn small" onClick={copyDiagnostics}>
            <Glyph icon={copied ? ACTION_ICON.approve : ACTION_ICON.copy} />
            {copied ? 'Copiado' : 'Copiar diagnóstico'}
          </button>
        }>
        <p className="small muted" style={{ margin: '0 0 10px' }}>
          Sin prompts, sin salida de agente y sin credenciales: es seguro pegarlo donde haga falta.
        </p>
        {health.isLoading ? <Loading rows={4} /> : null}
        <ErrorNote error={health.error} />
        <div className="list">
          {checks.map(([name, check]) => (
            <div key={name} className="list-item" style={{ cursor: 'default' }}>
              <span className="row tight nowrap" style={{ minWidth: 0 }}>
                <span className={`badge ${HEALTH[check.status]?.tone ?? 'neutral'}`}>
                  <Glyph icon={HEALTH_ICON[check.status] ?? HEALTH_ICON['unknown'] as never} />
                  {HEALTH[check.status]?.name ?? check.status}
                </span>
                <span className="cell-main">
                  <span className="title truncate">{checkName(name).title}</span>
                  <span className="tiny faint mono truncate">
                    {name}
                    {check.code ? ` · ${check.code}` : ''}
                    {check.message ? ` · ${check.message}` : ''}
                  </span>
                </span>
              </span>
              <span className="tiny faint nowrap">
                {check.lastOkAt ? `último ok ${relativeTime(check.lastOkAt)}` : 'sin ok conocido'}
              </span>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Flota" icon={ACTION_ICON.hosts} count={fleet.length}>
        <p className="small muted" style={{ margin: '0 0 10px' }}>
          Sondeada de verdad: una conexión por máquina para saber qué agentes tiene instalados.
        </p>
        {hosts.isLoading ? <Loading rows={3} /> : null}
        <div className="list">
          {fleet.map((host) => (
            <div key={host.host} className="list-item" style={{ cursor: 'default' }}>
              <span className="row tight nowrap" style={{ minWidth: 0 }}>
                <span className={`badge ${host.reachable ? (host.stale ? 'warn' : 'ok') : 'danger'}`}>
                  <Glyph icon={host.reachable
                    ? (host.stale ? HEALTH_ICON['stale'] as never : HEALTH_ICON['ok'] as never)
                    : HEALTH_ICON['failed'] as never} />
                  {host.reachable ? (host.stale ? 'sin refrescar' : 'responde') : 'no responde'}
                </span>
                <span className="cell-main">
                  <span className="row tight nowrap">
                    <Glyph icon={STATUS_ICON.host} size={13} />
                    <span className="mono">{host.host}</span>
                    {host.host === hosts.data?.bastionHost ? (
                      <span className="badge neutral">bastión</span>
                    ) : null}
                  </span>
                  <span className="tiny faint truncate">
                    {host.providers.length ? `agentes: ${host.providers.join(', ')}` : 'sin CLI de agente'}
                    {host.tmux ? ' · con tmux' : ' · sin tmux'}
                  </span>
                </span>
              </span>
              <span className="row tight nowrap">
                {host.error ? <span className="badge danger">{host.error.slice(0, 40)}</span> : null}
                <span className="tiny faint">sondeado {relativeTime(host.probedAt)}</span>
              </span>
            </div>
          ))}
          {!hosts.isLoading && fleet.length === 0 ? (
            <p className="muted small" style={{ margin: 0 }}>
              No hay ninguna máquina en la lista blanca todavía.
            </p>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
