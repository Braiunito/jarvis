/**
 * Alertas: lo que alguien quiso que supieras aunque no estuvieras mirando.
 *
 * Arriba, si este dispositivo suena o no y por qué; debajo, la lista. Cada alerta dice tres cosas
 * de un vistazo y sin depender del color: cuánto importa (la forma del icono), quién la mandó —la
 * API con la clave o Jarvis mismo— y desde qué máquina.
 *
 * Abrir la lista no da nada por leído: una alerta crítica que se marca sola por haber pasado por
 * delante es una alerta que nadie leyó. Se marca al abrir su enlace, una a una o todas a la vez.
 */
import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
  ALERT_IMPORTANCES, alertImportanceRank, type Alert, type AlertImportance, type AlertOriginKind, type PushDevice,
} from '@jarvis/contracts';
import {
  useAlerts, useDeleteAlert, useMarkAlertsRead, usePushStatus, useRemovePushDevice, useSavePushSubscription,
  useSendTestAlert, type AlertFilter,
} from '../api/queries.js';
import {
  currentSubscription, deviceIdOf, deviceLabel, notificationPermission, PushPermissionError,
  pushUnavailableReason, subscribeThisDevice, unsubscribeThisDevice, type PushPermission,
} from '../api/push.js';
import { announce } from '../ui/announce.jsx';
import { Empty, ErrorNote, Loading, relativeTime } from '../ui/bits.jsx';
import { navigate } from '../router.js';
import { ALERT_ORIGIN_KIND, IMPORTANCE } from '../ui/labels.js';
import {
  ACTION_ICON, ALERT_ORIGIN_ICON, BELL_ICON, Glyph, IMPORTANCE_ICON, NAV_ICON, STATUS_ICON,
} from '../ui/icons.jsx';
import { usePageMeta } from '../ui/page-meta.jsx';
import { Card, Segmented } from '../ui/primitives.jsx';

/**
 * Adónde lleva el enlace de una alerta, o `null` si no es algo que se deba abrir.
 *
 * El enlace lo escribe quien manda la alerta, y por la API eso es cualquiera con la clave: sólo se
 * aceptan rutas de esta consola y direcciones http(s). Un `javascript:` pintado como enlace sería
 * código ajeno ejecutándose con la sesión de quien lo toca.
 */
export function alertTarget(link: string | null): { internal: string } | { external: string } | null {
  if (!link) return null;
  if (link.startsWith('/') && !link.startsWith('//')) return { internal: link };
  try {
    const url = new URL(link);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.origin === window.location.origin) return { internal: `${url.pathname}${url.search}${url.hash}` };
    return { external: url.href };
  } catch {
    return null;
  }
}

const absoluteTime = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'medium' });
};

type KindFilter = 'all' | AlertOriginKind;

export function AlertsScreen(): JSX.Element {
  usePageMeta({ title: 'Alertas' });

  const [importance, setImportance] = useState<AlertImportance[]>([]);
  const [kind, setKind] = useState<KindFilter>('all');
  const [host, setHost] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);

  const filter = useMemo<AlertFilter>(() => ({
    ...(importance.length ? { importance: [...importance].sort((a, b) => alertImportanceRank(a) - alertImportanceRank(b)) } : {}),
    ...(kind !== 'all' ? { kind } : {}),
    ...(host ? { host } : {}),
    ...(unreadOnly ? { unread: true } : {}),
  }), [importance, kind, host, unreadOnly]);

  const list = useAlerts(filter);
  const markRead = useMarkAlertsRead();
  const remove = useDeleteAlert();

  const pages = list.data?.pages ?? [];
  const alerts = pages.flatMap((page) => page.alerts);
  const first = pages[0];
  const unread = first?.unread ?? 0;
  // Las máquinas del historial, más la elegida: si el filtro deja la lista vacía, el desplegable
  // no puede perder justo la opción que hay puesta.
  const hosts = [...new Set([...(first?.hosts ?? []), ...(host ? [host] : [])])].sort();
  const filtered = importance.length > 0 || kind !== 'all' || host !== '' || unreadOnly;

  const toggleImportance = (value: AlertImportance): void => {
    setImportance((current) => (current.includes(value)
      ? current.filter((item) => item !== value)
      : [...current, value]));
  };

  const markAll = (): void => {
    markRead.mutate({ all: true }, {
      onSuccess: ({ updated }) => announce(updated === 1 ? 'Una alerta marcada como leída' : `${updated} alertas marcadas como leídas`),
    });
  };

  return (
    <div className="page narrow">
      <PushCard />

      <Card
        title="Alertas"
        icon={NAV_ICON.alerts}
        {...(unread > 0 ? { count: `${unread} sin leer`, countTone: 'attention' as const } : {})}
        actions={unread > 0 ? (
          <button type="button" className="btn small" onClick={markAll} disabled={markRead.isPending}>
            <Glyph icon={ACTION_ICON.markRead} />
            Marcar todo leído
          </button>
        ) : null}
      >
        <div className="alert-filters" role="group" aria-label="Filtrar alertas">
          <div className="alert-importance-filter" role="group" aria-label="Importancia">
            {ALERT_IMPORTANCES.map((value) => (
              <button key={value} type="button"
                className={`filter-toggle ${IMPORTANCE[value].tone}`}
                aria-pressed={importance.includes(value)}
                title={IMPORTANCE[value].help}
                onClick={() => toggleImportance(value)}>
                <Glyph icon={IMPORTANCE_ICON[value]} />
                {IMPORTANCE[value].name}
              </button>
            ))}
          </div>
          <Segmented<KindFilter>
            label="Origen"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'all', label: 'Todo origen' },
              { value: 'api', label: ALERT_ORIGIN_KIND.api.name, icon: ALERT_ORIGIN_ICON.api, hint: ALERT_ORIGIN_KIND.api.help },
              { value: 'jarvis', label: ALERT_ORIGIN_KIND.jarvis.name, icon: ALERT_ORIGIN_ICON.jarvis, hint: ALERT_ORIGIN_KIND.jarvis.help },
            ]}
          />
          <label className="alert-host-filter">
            <span className="visually-hidden">Máquina</span>
            <select className="select" value={host} onChange={(event) => setHost(event.target.value)}>
              <option value="">Todas las máquinas</option>
              {hosts.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <button type="button" className="filter-toggle" aria-pressed={unreadOnly}
            onClick={() => setUnreadOnly((value) => !value)}>
            <Glyph icon={BELL_ICON.unread} />
            Sólo sin leer
          </button>
          {filtered ? (
            <button type="button" className="linklike small" onClick={() => {
              setImportance([]); setKind('all'); setHost(''); setUnreadOnly(false);
            }}>
              Quitar filtros
            </button>
          ) : null}
        </div>

        {list.isLoading ? <Loading rows={4} shape="list" label="Cargando alertas…" /> : null}
        <ErrorNote error={list.error} onRetry={() => void list.refetch()} />

        {!list.isLoading && !list.error && alerts.length === 0 ? (
          <Empty tight
            icon={BELL_ICON.idle}
            title={filtered ? 'Ninguna alerta con estos filtros' : 'Todavía no hay alertas'}
            hint={filtered
              ? 'Quita algún filtro para ver el resto.'
              : 'Aparecen aquí cuando termina o falla un trabajo, cuando algo de la flota deja de responder, o cuando alguien las manda por la API con la clave.'}
          />
        ) : null}

        {alerts.length > 0 ? (
          <ul className="alert-list">
            {alerts.map((alert) => (
              <AlertRow key={alert.id} alert={alert}
                onRead={() => markRead.mutate({ ids: [alert.id] })}
                onRemove={() => remove.mutate(alert.id, { onSuccess: () => announce('Alerta borrada') })}
                busy={remove.isPending && remove.variables === alert.id} />
            ))}
          </ul>
        ) : null}

        <ErrorNote error={markRead.error ?? remove.error} />

        {list.hasNextPage ? (
          <button type="button" className="btn small rows-more" onClick={() => void list.fetchNextPage()}
            disabled={list.isFetchingNextPage}>
            <Glyph icon={STATUS_ICON.clock} />
            {list.isFetchingNextPage ? 'Cargando…' : 'Ver más antiguas'}
          </button>
        ) : null}
      </Card>
    </div>
  );
}

function AlertRow({ alert, onRead, onRemove, busy }: {
  alert: Alert;
  onRead: () => void;
  onRemove: () => void;
  busy: boolean;
}): JSX.Element {
  const label = IMPORTANCE[alert.importance];
  const kind = ALERT_ORIGIN_KIND[alert.origin.kind];
  const target = alertTarget(alert.link);
  const unread = alert.readAt === null;
  // Abrir el enlace es leerla; si ya estaba leída no hace falta otra petición.
  const openLink = (): void => { if (unread) onRead(); };

  return (
    <li className={`alert-row ${label.tone} ${unread ? 'unread' : ''}`}>
      <span className={`alert-mark ${label.tone}`} title={`${label.name}: ${label.help}`}>
        <Glyph icon={IMPORTANCE_ICON[alert.importance]} size={16} />
      </span>
      <div className="alert-main">
        <p className="alert-title">
          {unread ? <span className="visually-hidden">Sin leer: </span> : null}
          {alert.title}
        </p>
        {alert.body ? <p className="alert-body">{alert.body}</p> : null}
        <div className="alert-meta">
          <span className={`badge ${label.tone}`}>
            <Glyph icon={IMPORTANCE_ICON[alert.importance]} />
            {label.name}
          </span>
          <span className="badge neutral" title={kind.help}>
            <Glyph icon={ALERT_ORIGIN_ICON[alert.origin.kind]} />
            {kind.name}
          </span>
          <span className="badge neutral mono" title="La máquina donde nació">
            <Glyph icon={STATUS_ICON.host} />
            {alert.origin.host}
          </span>
          {alert.origin.app ? (
            <span className="badge neutral mono" title="Quién la mandó">{alert.origin.app}</span>
          ) : null}
          <time className="tiny faint nowrap" dateTime={alert.createdAt} title={absoluteTime(alert.createdAt)}>
            {relativeTime(alert.createdAt)}
          </time>
          {alert.pushedTo > 0 ? (
            <span className="tiny faint nowrap" title="Llegó como notificación a estos dispositivos">
              · a {alert.pushedTo} {alert.pushedTo === 1 ? 'dispositivo' : 'dispositivos'}
            </span>
          ) : null}
        </div>
      </div>
      <div className="alert-actions">
        {target && 'internal' in target ? (
          // Un `<a>` propio y no `Link`: el `onClick` de quien lo usa sustituiría al de `Link`, y
          // entonces el enlace marcaría la alerta pero recargaría la página entera.
          <a href={target.internal} className="btn small" onClick={(event) => {
            openLink();
            if (event.metaKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            navigate(target.internal);
          }}>
            <Glyph icon={ACTION_ICON.go} />
            Abrir
          </a>
        ) : null}
        {target && 'external' in target ? (
          <a href={target.external} className="btn small" target="_blank" rel="noopener noreferrer"
            onClick={openLink} title={target.external}>
            <Glyph icon={ACTION_ICON.external} />
            Abrir
          </a>
        ) : null}
        {unread ? (
          <button type="button" className="btn small icon ghost" onClick={onRead}
            aria-label={`Marcar como leída: ${alert.title}`} title="Marcar como leída">
            <Glyph icon={ACTION_ICON.approve} />
          </button>
        ) : null}
        <button type="button" className="btn small icon ghost" onClick={onRemove} disabled={busy}
          aria-label={`Borrar: ${alert.title}`} title="Borrar">
          <Glyph icon={ACTION_ICON.remove} />
        </button>
      </div>
    </li>
  );
}

const UNAVAILABLE: Record<string, string> = {
  insecure: 'Esta página no viaja cifrada (HTTPS), y sin cifrado el navegador no permite notificaciones push. Las alertas siguen apareciendo aquí.',
  'ios-not-installed': 'En iPhone y iPad las notificaciones sólo llegan a la aplicación instalada. Añádela a la pantalla de inicio desde Compartir → «Añadir a pantalla de inicio», ábrela desde ahí y vuelve a esta pantalla.',
  unsupported: 'Este navegador no admite notificaciones push. Las alertas siguen apareciendo aquí y en el contador de arriba.',
};

const DENIED = 'Las notificaciones de este sitio están bloqueadas en el navegador. Desbloquéalas en los ajustes del sitio —el candado de la barra de direcciones, o Ajustes → Notificaciones en el móvil— y vuelve a activarlas aquí.';

/** Desde qué importancia suena un dispositivo. `low` no está: ésa no suena nunca, en ninguno. */
const MIN_IMPORTANCE_OPTIONS = (['normal', 'high', 'critical'] as const).map((value) => ({
  value,
  label: value === 'normal' ? 'Todas' : value === 'high' ? 'Alta o más' : 'Sólo críticas',
  icon: IMPORTANCE_ICON[value],
  hint: value === 'normal'
    ? 'Suenan las normales, las altas y las críticas. Las de importancia baja nunca suenan.'
    : value === 'high' ? 'Sólo suenan las altas y las críticas.' : 'Sólo suenan las críticas.',
}));

/**
 * Las notificaciones de este dispositivo: si suena, desde qué importancia, y en qué otros sitios.
 *
 * El estado se pregunta al navegador —¿hay suscripción?— y al core —¿la conoce?—, porque pueden
 * no coincidir: una suscripción que el core borró al rebotar sigue viva en el navegador, y ahí lo
 * honesto es decir «no suena» y ofrecer activarla otra vez.
 */
function PushCard(): JSX.Element {
  const reason = useMemo(() => pushUnavailableReason(), []);
  const status = usePushStatus();
  const save = useSavePushSubscription();
  const removeDevice = useRemovePushDevice();
  const test = useSendTestAlert();

  const [permission, setPermission] = useState<PushPermission>(() => notificationPermission());
  /** `undefined` mientras se pregunta al navegador; `null` si no tiene suscripción. */
  const [endpoint, setEndpoint] = useState<string | null | undefined>(reason ? null : undefined);
  const [thisId, setThisId] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [showDevices, setShowDevices] = useState(false);

  useEffect(() => {
    if (reason) return;
    let alive = true;
    currentSubscription()
      .then((subscription) => { if (alive) setEndpoint(subscription?.endpoint ?? null); })
      .catch(() => { if (alive) setEndpoint(null); });
    return () => { alive = false; };
  }, [reason]);

  useEffect(() => {
    if (!endpoint) { setThisId(null); return; }
    let alive = true;
    void deviceIdOf(endpoint).then((id) => { if (alive) setThisId(id); });
    return () => { alive = false; };
  }, [endpoint]);

  const devices = status.data?.devices ?? [];
  const mine = thisId ? devices.find((device) => device.id === thisId) ?? null : null;
  const active = Boolean(endpoint && mine);
  const minImportance = mine?.minImportance ?? 'normal';

  async function register(min: AlertImportance): Promise<void> {
    const publicKey = status.data?.publicKey;
    if (!publicKey) throw new Error('El core no ha dado su clave de notificaciones todavía.');
    const json = await subscribeThisDevice(publicKey);
    setPermission(notificationPermission());
    if (!json.endpoint || !json.keys?.['p256dh'] || !json.keys['auth']) {
      throw new Error('El navegador devolvió una suscripción incompleta.');
    }
    await save.mutateAsync({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys['p256dh'], auth: json.keys['auth'] },
      minImportance: min,
      label: deviceLabel(),
    });
    setEndpoint(json.endpoint);
  }

  const run = (action: () => Promise<void>, done: string): void => {
    setWorking(true);
    setProblem(null);
    action()
      .then(() => announce(done))
      .catch((error: unknown) => {
        if (error instanceof PushPermissionError) setPermission(error.permission);
        setProblem(error instanceof PushPermissionError && error.permission === 'denied'
          ? DENIED
          : (error as Error).message || String(error));
      })
      .finally(() => setWorking(false));
  };

  const activate = (): void => run(() => register(minImportance), 'Notificaciones activadas en este dispositivo');

  const deactivate = (): void => run(async () => {
    const gone = endpoint ?? await unsubscribeThisDevice();
    if (gone) await removeDevice.mutateAsync({ endpoint: gone }).catch(() => undefined);
    await unsubscribeThisDevice();
    setEndpoint(null);
  }, 'Notificaciones desactivadas en este dispositivo');

  const changeMin = (value: AlertImportance): void =>
    run(() => register(value), `Avisará desde importancia ${IMPORTANCE[value].name.toLowerCase()}`);

  const forget = (device: PushDevice): void => run(async () => {
    await removeDevice.mutateAsync({ id: device.id });
    if (device.id === thisId) {
      await unsubscribeThisDevice();
      setEndpoint(null);
    }
  }, `Quitado: ${device.label ?? device.service}`);

  const sendTest = (): void => {
    setProblem(null);
    test.mutate(undefined, {
      onSuccess: (alert) => announce(alert.pushedTo > 0
        ? `Prueba enviada a ${alert.pushedTo} ${alert.pushedTo === 1 ? 'dispositivo' : 'dispositivos'}`
        : 'Prueba creada; no hay ningún dispositivo que la reciba'),
    });
  };

  const [tone, icon, headline] = reason
    ? ['neutral', BELL_ICON.off, 'Este dispositivo no puede recibir notificaciones'] as const
    : permission === 'denied'
      ? ['warn', BELL_ICON.off, 'Notificaciones bloqueadas en este navegador'] as const
      : endpoint === undefined
        ? ['neutral', BELL_ICON.idle, 'Comprobando este dispositivo…'] as const
        : active
          ? ['ok', BELL_ICON.ringing, 'Este dispositivo recibe las alertas'] as const
          : ['neutral', BELL_ICON.off, 'Las alertas no suenan en este dispositivo'] as const;

  return (
    <section className={`card push-card ${tone}`} aria-labelledby="push-card-title">
      <div className="push-head">
        <Glyph icon={icon} size={20} />
        <div className="grow">
          <h2 id="push-card-title">{headline}</h2>
          <span className="small muted">
            {reason || permission === 'denied'
              ? 'Las alertas se siguen viendo aquí y en el contador de arriba.'
              : active
                ? `Como «${mine?.label ?? 'este dispositivo'}». ${MIN_IMPORTANCE_OPTIONS.find((option) => option.value === minImportance)?.hint ?? ''}`
                : 'Actívalas para enterarte con la consola cerrada: un trabajo que termina, una máquina que cae.'}
          </span>
        </div>
        {!reason && permission !== 'denied' && endpoint !== undefined ? (
          active ? (
            <button type="button" className="btn small" onClick={deactivate} disabled={working}>
              <Glyph icon={BELL_ICON.off} />
              Desactivar
            </button>
          ) : (
            <button type="button" className="btn small primary" onClick={activate}
              disabled={working || !status.data?.publicKey}>
              <Glyph icon={BELL_ICON.ringing} />
              {working ? 'Activando…' : 'Activar'}
            </button>
          )
        ) : null}
      </div>

      {reason ? <p className="note"><Glyph icon={ACTION_ICON.info} size={16} /><span>{UNAVAILABLE[reason]}</span></p> : null}
      {!reason && permission === 'denied' ? (
        <p className="note warn"><Glyph icon={ACTION_ICON.error} size={16} /><span>{DENIED}</span></p>
      ) : null}
      {problem && problem !== DENIED ? (
        <p className="note danger" role="alert"><Glyph icon={ACTION_ICON.error} size={16} /><span>{problem}</span></p>
      ) : null}
      <ErrorNote error={status.error ?? save.error ?? test.error} onRetry={() => void status.refetch()} />

      {active ? (
        <div className="push-settings">
          <span className="small muted">Avisar desde</span>
          <Segmented<AlertImportance>
            label="Importancia mínima que suena en este dispositivo"
            value={minImportance}
            onChange={changeMin}
            options={MIN_IMPORTANCE_OPTIONS}
          />
        </div>
      ) : null}

      <div className="push-foot">
        <button type="button" className="btn small" onClick={sendTest} disabled={test.isPending || devices.length === 0}
          title={devices.length === 0 ? 'No hay ningún dispositivo que la reciba' : 'Crea una alerta de prueba y la manda a todos los dispositivos'}>
          <Glyph icon={ACTION_ICON.test} />
          {test.isPending ? 'Enviando…' : 'Enviar una prueba'}
        </button>
        {devices.length > 0 ? (
          <button type="button" className="linklike small" aria-expanded={showDevices}
            onClick={() => setShowDevices((value) => !value)}>
            {showDevices ? 'Ocultar dispositivos' : `${devices.length} ${devices.length === 1 ? 'dispositivo recibe' : 'dispositivos reciben'} alertas`}
          </button>
        ) : (
          <span className="small muted">Ningún dispositivo recibe alertas todavía.</span>
        )}
      </div>

      {showDevices && devices.length > 0 ? (
        <div className="rows push-devices">
          {devices.map((device) => (
            <div key={device.id} className={`line-row ${device.lastError ? 'bad' : ''}`}>
              <span className={`badge ${device.lastError ? 'warn' : 'neutral'}`}>
                <Glyph icon={ACTION_ICON.device} />
                {device.id === thisId ? 'este' : IMPORTANCE[device.minImportance].name}
              </span>
              <span className="line-main">
                <span className="truncate">{device.label ?? 'Sin nombre'}</span>
                <span className="tiny faint truncate">
                  {device.service}
                  {` · desde ${IMPORTANCE[device.minImportance].name.toLowerCase()}`}
                  {device.lastOkAt ? ` · última entrega ${relativeTime(device.lastOkAt)}` : ' · sin entregas todavía'}
                  {device.lastError ? ` · ${device.lastError}` : ''}
                </span>
              </span>
              <button type="button" className="btn small icon ghost" onClick={() => forget(device)} disabled={working}
                aria-label={`Quitar ${device.label ?? device.service}`} title="Dejar de mandar alertas a este dispositivo">
                <Glyph icon={ACTION_ICON.remove} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
