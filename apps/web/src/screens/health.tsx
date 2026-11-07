/**
 * Salud: dónde duele y desde cuándo.
 *
 * Una frase arriba —todo bien o qué no— y debajo, en filas cortas, cada comprobación y cada
 * máquina. Aquí vive también lo que antes ocupaba la portada y la barra de abajo: la cuota de las
 * cuentas y los datos del sistema. Se miran cuando algo va raro, no cada vez que se entra.
 *
 * El diagnóstico se puede copiar y no lleva prompts, salida del agente ni secretos: sólo
 * versiones, estados por salto y códigos de error, así que se puede pegar en cualquier chat.
 */
import type { JSX } from 'react';
import { useState } from 'react';
import { useHealth, useHosts, useMetrics } from '../api/queries.js';
import { ErrorNote, Loading, relativeTime } from '../ui/bits.jsx';
import { Meter } from '../ui/charts.jsx';
import { checkName, HEALTH, USAGE_LOW_PERCENT, usageWindowName } from '../ui/labels.js';
import { ACTION_ICON, Glyph, HEALTH_ICON, NAV_ICON, PROVIDER_ICON } from '../ui/icons.jsx';
import { usePageMeta } from '../ui/page-meta.jsx';
import { Card, formatDuration } from '../ui/primitives.jsx';

const SUMMARY: Record<string, string> = {
  ok: 'Todo bien',
  degraded: 'Algo va a medias',
  failed: 'Algo está caído',
};

export function HealthScreen(): JSX.Element {
  usePageMeta({ title: 'Salud' });

  const health = useHealth();
  // Aquí sí interesa el estado real de cada máquina, aunque cueste una conexión por host.
  const hosts = useHosts({ probe: true });
  const metrics = useMetrics(24);
  const [copied, setCopied] = useState(false);
  const [showAllChecks, setShowAllChecks] = useState(false);

  const checks = Object.entries(health.data?.checks ?? {});
  const okCount = checks.filter(([, check]) => check.status === 'ok').length;
  const fleet = hosts.data?.hosts ?? [];
  const usage = metrics.data?.usage ?? [];
  const system = health.data?.system;
  const insecure = window.location.protocol !== 'https:';
  const status = health.data?.status;
  const tone = status === 'ok' ? 'ok' : status === 'degraded' ? 'warn' : status ? 'danger' : 'neutral';

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
    <div className="page narrow">
      {insecure ? (
        <p className="note warn" role="status">
          <Glyph icon={ACTION_ICON.insecure} size={16} />
          <span>
            Esta página no viaja cifrada: las passkeys no funcionan y la entrada por contraseña queda
            abierta. Con certificado, se apaga.
          </span>
        </p>
      ) : null}

      <div className={`health-summary ${tone}`}>
        <Glyph icon={HEALTH_ICON[status ?? 'unknown'] ?? HEALTH_ICON['unknown'] as never} size={22} />
        <div className="grow">
          <strong>{status ? SUMMARY[status] ?? status : 'Comprobando…'}</strong>
          <span className="small muted">
            {okCount} de {checks.length} comprobaciones bien
            {' · '}
            {fleet.filter((host) => host.reachable).length} de {fleet.length} máquinas responden
          </span>
        </div>
        <button type="button" className="btn small" onClick={copyDiagnostics}
          title="Sin prompts, sin salida de agente y sin credenciales: se puede pegar donde haga falta">
          <Glyph icon={copied ? ACTION_ICON.approve : ACTION_ICON.copy} />
          {copied ? 'Copiado' : 'Copiar diagnóstico'}
        </button>
      </div>

      <Card title="Comprobaciones" icon={NAV_ICON.health}>
        {health.isLoading ? <Loading rows={4} shape="list" label="Sondeando el core…" /> : null}
        <ErrorNote error={health.error} onRetry={() => void health.refetch()} />
        <div className="rows">
          {(showAllChecks ? checks : checks.filter(([, check]) => check.status !== 'ok')).map(([name, check]) => (
            <div key={name} className={`line-row ${check.status === 'ok' ? '' : 'bad'}`}>
              <span className={`badge ${HEALTH[check.status]?.tone ?? 'neutral'}`}>
                <Glyph icon={HEALTH_ICON[check.status] ?? HEALTH_ICON['unknown'] as never} />
                {HEALTH[check.status]?.name ?? check.status}
              </span>
              <span className="line-main">
                <span className="truncate">{checkName(name).title}</span>
                <span className="tiny faint mono truncate">
                  {name}
                  {check.code ? ` · ${check.code}` : ''}
                  {check.message ? ` · ${check.message}` : ''}
                </span>
              </span>
              <span className="tiny faint nowrap">
                {check.lastOkAt ? `ok ${relativeTime(check.lastOkAt)}` : 'sin ok conocido'}
              </span>
            </div>
          ))}
          {/*
            * Lo que va bien, plegado: se cuenta y se puede abrir. Diez filas verdes para encontrar
            * la roja era justo lo que esta pantalla no debería obligar a hacer.
            */}
          {okCount > 0 ? (
            <button type="button" className="linklike small rows-more" onClick={() => setShowAllChecks((value) => !value)}>
              {showAllChecks ? 'Ocultar las que van bien' : `Ver las ${okCount} que van bien`}
            </button>
          ) : null}
        </div>
      </Card>

      <Card title="Máquinas" icon={ACTION_ICON.hosts}>
        {hosts.isLoading ? <Loading rows={3} shape="list" label="Sondeando las máquinas…" /> : null}
        <ErrorNote error={hosts.error} onRetry={() => void hosts.refetch()} />
        <div className="rows">
          {fleet.map((host) => (
            <div key={host.host} className={`line-row ${host.reachable ? '' : 'bad'}`}>
              <span className={`badge ${host.reachable ? (host.stale ? 'warn' : 'ok') : 'danger'}`}>
                <Glyph icon={host.reachable
                  ? (host.stale ? HEALTH_ICON['stale'] as never : HEALTH_ICON['ok'] as never)
                  : HEALTH_ICON['failed'] as never} />
                {host.reachable ? (host.stale ? 'sin refrescar' : 'responde') : 'no responde'}
              </span>
              <span className="line-main">
                <span className="mono truncate">
                  {host.host}
                  {host.host === hosts.data?.bastionHost ? <span className="faint"> · bastión</span> : null}
                </span>
                <span className="tiny faint truncate">
                  {host.error ? host.error.slice(0, 80) : (
                    `${host.providers.length ? host.providers.join(', ') : 'sin agentes'}${host.tmux ? ' · tmux' : ' · sin tmux'}`
                  )}
                </span>
              </span>
              <span className="tiny faint nowrap">{relativeTime(host.probedAt)}</span>
            </div>
          ))}
          {!hosts.isLoading && fleet.length === 0 ? (
            <p className="small muted" style={{ margin: 0 }}>
              No hay máquinas declaradas: se añaden en la configuración del core (JARVIS_HOSTS).
            </p>
          ) : null}
        </div>
      </Card>

      {/*
        * La cuota de cada cuenta: la ventana más apretada, que es la que va a molestar primero.
        * El detalle por ventana sigue en la cabecera de cada sesión, que es donde se manda trabajo.
        */}
      {usage.length ? (
        <Card title="Cuota de las cuentas" icon={ACTION_ICON.filters}>
          <div className="rows">
            {usage.map((account) => {
              const low = account.remainingPercent <= USAGE_LOW_PERCENT;
              return (
                <div key={`${account.provider}:${account.executionHost}`} className="quota-row">
                  <span className="row tight nowrap small" style={{ minWidth: 0 }}>
                    <Glyph icon={PROVIDER_ICON[account.provider] ?? NAV_ICON.runs} size={13} />
                    <span>{account.provider}</span>
                    <span className="faint truncate">{account.executionHost}</span>
                  </span>
                  <Meter value={account.remainingPercent} max={100} tone={low ? 'danger' : 'ok'} />
                  <span className={`tiny nowrap ${low ? 'danger-text' : 'faint'}`}>
                    {account.remainingPercent}% de {usageWindowName(account.label)}
                    {account.stale ? ' · viejo' : ''}
                  </span>
                </div>
              );
            })}
          </div>
        </Card>
      ) : null}

      {system ? (
        <p className="tiny faint system-line">
          core {health.data?.version} · en pie {formatDuration(system.uptimeSeconds * 1000)}
          {' · '}bastión {system.bastionHost} · {system.hosts} máquinas · SQLite {system.sqlite} · Node {system.node}
        </p>
      ) : null}
    </div>
  );
}
