/**
 * El service worker de Jarvis: notificaciones y nada más.
 *
 * No cachea ni sirve nada sin red. Una consola que enseña el estado de máquinas reales no tiene
 * nada útil que decir desconectada, y una caché vieja delante de la API es la forma más rápida de
 * enseñar un «todo bien» que ya no es verdad. Por eso no hay `fetch` handler: el navegador va a la
 * red como si este fichero no existiera, salvo para lo que sólo puede hacer él —recibir un push
 * con la pestaña cerrada.
 *
 * JavaScript plano y sin build: Vite lo copia tal cual desde `public/`, y así su URL no cambia
 * entre despliegues, que es lo que necesita el navegador para reconocerlo como el mismo worker y
 * actualizarlo en vez de registrar otro.
 */

/* global self, URL, fetch */

const ICON = '/icons/icon-192.png';
const BADGE = '/icons/badge-72.png';

const ORIGIN_KIND = { api: 'API', jarvis: 'Jarvis' };

/** «API · braian · claude-code»: quién la mandó, para cuando no trae cuerpo. */
function originLine(origin) {
  if (!origin) return '';
  return [ORIGIN_KIND[origin.kind] || origin.kind, origin.host, origin.app].filter(Boolean).join(' · ');
}

self.addEventListener('install', () => {
  // Un worker nuevo no tiene que esperar a que se cierren todas las pestañas: no sirve páginas,
  // así que no hay versiones mezcladas que proteger.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let alert = null;
  try {
    alert = event.data ? event.data.json() : null;
  } catch {
    alert = null;
  }
  /*
   * Un push sin carga legible se enseña igual.
   *
   * Con `userVisibleOnly` el navegador exige una notificación por cada push; si no se pinta
   * ninguna, Chrome pone la suya genérica («este sitio se ha actualizado en segundo plano») y a la
   * larga retira el permiso. Mejor una genérica nuestra que lleve a la lista.
   */
  if (!alert || typeof alert !== 'object' || !alert.title) {
    alert = { id: `push-${Date.now()}`, title: 'Jarvis', body: 'Hay una alerta nueva.', importance: 'normal', link: '/alerts' };
  }

  const origin = originLine(alert.origin);
  const critical = alert.importance === 'critical';
  const options = {
    body: alert.body || origin,
    tag: alert.id,
    icon: ICON,
    badge: BADGE,
    data: { id: alert.id, link: alert.link || null },
    // Lo crítico se queda en pantalla hasta que alguien lo quite: es justo lo que no se puede
    // perder por mirar el móvil dos segundos tarde.
    requireInteraction: critical,
    renotify: critical,
    timestamp: alert.createdAt ? Date.parse(alert.createdAt) || Date.now() : Date.now(),
  };

  event.waitUntil(Promise.all([
    self.registration.showNotification(alert.title, options),
    // Las ventanas abiertas se enteran sin esperar a su próximo sondeo.
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) client.postMessage({ type: 'jarvis:alert', alert });
    }),
  ]));
});

/** Adónde lleva tocar: su enlace si lo tiene, y si no, la lista de alertas. */
function targetOf(data) {
  const link = data && typeof data.link === 'string' ? data.link : '';
  if (!link) return { url: '/alerts', external: false };
  try {
    const url = new URL(link, self.location.origin);
    return { url: url.href, external: url.origin !== self.location.origin };
  } catch {
    return { url: '/alerts', external: false };
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = targetOf(data);

  // Marcarla leída es un extra: si falla —sin sesión, sin red— abrir tiene que seguir funcionando.
  const markRead = data.id && !String(data.id).startsWith('push-')
    ? fetch('/api/alerts/read', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [data.id] }),
    }).catch(() => undefined)
    : Promise.resolve();

  const open = (async () => {
    if (target.external) {
      await self.clients.openWindow(target.url);
      return;
    }
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const mine = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (mine) {
      /*
       * Se reutiliza la ventana que ya está abierta —abrir otra en cada toque llena el móvil de
       * copias de la misma consola— y se le pide a la propia aplicación que cambie de ruta. Con
       * `client.navigate()` se recargaría la página entera, y además sólo funciona si este worker
       * ya la controla, cosa que no pasa en la primera visita.
       */
      let client = mine;
      try {
        client = (await mine.focus()) || mine;
      } catch {
        // Sin foco se puede seguir: la ruta cambia igual y se verá al volver a la ventana.
      }
      const path = new URL(target.url).pathname + new URL(target.url).search;
      client.postMessage({ type: 'jarvis:navigate', url: path });
      return;
    }
    await self.clients.openWindow(target.url);
  })();

  event.waitUntil(Promise.all([markRead, open]));
});
