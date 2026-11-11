/**
 * El service worker y las notificaciones push de este dispositivo.
 *
 * Todo lo que depende de qué navegador es éste vive aquí, y la pantalla sólo pregunta «¿se puede?»
 * y «¿está activado?». Cada «no se puede» tiene nombre propio porque cada uno se arregla de una
 * forma distinta: sin HTTPS no hay nada que hacer desde el navegador, con el permiso denegado hay
 * que ir a los ajustes del sitio, y en iOS hay que instalar la aplicación primero.
 */

export const SERVICE_WORKER_URL = '/sw.js';

/**
 * Registra el service worker sin estorbar al arranque.
 *
 * Fuera de un contexto seguro el navegador no lo permite (localhost cuenta como seguro), y un
 * fallo aquí no puede tirar la consola: sin worker se pierde el push, no la aplicación.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  const register = (): void => {
    navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: '/' }).catch((error: unknown) => {
      console.warn('[jarvis] no se pudo registrar el service worker:', error);
    });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

const isIos = (): boolean =>
  /iPad|iPhone|iPod/.test(navigator.userAgent)
  // El iPad se presenta como un Mac de escritorio; lo delata la pantalla táctil.
  || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);

/** Abierta como aplicación instalada, no en una pestaña del navegador. */
export const isStandalone = (): boolean =>
  window.matchMedia?.('(display-mode: standalone)').matches
  || (navigator as Navigator & { standalone?: boolean }).standalone === true;

export type PushUnavailable = 'insecure' | 'ios-not-installed' | 'unsupported';

/** Por qué este dispositivo no puede recibir push, o `null` si sí puede. */
export function pushUnavailableReason(): PushUnavailable | null {
  if (!window.isSecureContext) return 'insecure';
  const hasApis = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  // En iOS las APIs sólo aparecen dentro de la aplicación instalada, así que se mira esto antes
  // que su ausencia: decir «tu navegador no puede» a un iPhone sería falso y no le diría qué hacer.
  if (isIos() && !isStandalone()) return 'ios-not-installed';
  if (!hasApis) return 'unsupported';
  return null;
}

export type PushPermission = NotificationPermission | 'unavailable';

export const notificationPermission = (): PushPermission =>
  'Notification' in window ? Notification.permission : 'unavailable';

/** Cómo se llama este dispositivo en la lista: «Chrome en Android», «Safari en iPhone»… */
export function deviceLabel(userAgent = navigator.userAgent): string {
  const ua = userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Firefox\//.test(ua) ? 'Firefox'
      : /OPR\//.test(ua) ? 'Opera'
        : /Chrome\//.test(ua) || /CriOS\//.test(ua) ? 'Chrome'
          : /Safari\//.test(ua) ? 'Safari'
            : 'Navegador';
  const system = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
      : /Android/.test(ua) ? 'Android'
        : /Windows/.test(ua) ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
            : /CrOS/.test(ua) ? 'ChromeOS'
              : /Linux/.test(ua) ? 'Linux'
                : 'otro sistema';
  return `${isStandalone() ? 'App' : browser} en ${system}`;
}

/**
 * El identificador que el core da a un dispositivo: el principio del sha256 del endpoint.
 *
 * El core no devuelve endpoints —con uno se puede mandar a ese dispositivo—, así que para saber
 * cuál de la lista es éste se calcula aquí la misma huella.
 */
export async function deviceIdOf(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const sameBytes = (a: ArrayBuffer | null | undefined, b: Uint8Array): boolean => {
  if (!a || a.byteLength !== b.byteLength) return false;
  const view = new Uint8Array(a);
  return view.every((byte, index) => byte === b[index]);
};

/** El worker activo, con plazo: `ready` no se resuelve nunca si el registro falló. */
async function activeRegistration(timeoutMs = 10_000): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: '/' });
  let timer = 0;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error('el service worker no llegó a activarse')), timeoutMs);
  });
  try {
    return await Promise.race([navigator.serviceWorker.ready, timeout]);
  } finally {
    window.clearTimeout(timer);
  }
}

/** La suscripción que ya tiene este navegador, si tiene alguna. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushUnavailableReason()) return null;
  const registration = await navigator.serviceWorker.getRegistration('/');
  return registration ? registration.pushManager.getSubscription() : null;
}

export class PushPermissionError extends Error {
  constructor(readonly permission: NotificationPermission) {
    super(permission === 'denied'
      ? 'El navegador tiene bloqueadas las notificaciones de este sitio.'
      : 'No se concedió el permiso de notificaciones.');
    this.name = 'PushPermissionError';
  }
}

/**
 * Pide permiso y suscribe este navegador con la clave VAPID del core.
 *
 * Tiene que llamarse desde un clic: Safari y Firefox rechazan pedir permiso sin un gesto, y
 * Chrome acaba silenciando a los sitios que lo piden al cargar. Si ya había una suscripción hecha
 * con otra clave —el core regeneró la suya— se descarta, porque con ella el servicio de push
 * rechazaría todo lo que se mandara.
 */
export async function subscribeThisDevice(publicKey: string): Promise<PushSubscriptionJSON> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new PushPermissionError(permission);
  const registration = await activeRegistration();
  const key = base64UrlToBytes(publicKey);
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameBytes(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe().catch(() => false);
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  return subscription.toJSON();
}

/** Deja de recibir en este navegador. Devuelve el endpoint que tenía, para borrarlo del core. */
export async function unsubscribeThisDevice(): Promise<string | null> {
  const subscription = await currentSubscription();
  if (!subscription) return null;
  const { endpoint } = subscription;
  await subscription.unsubscribe().catch(() => false);
  return endpoint;
}

/**
 * Lo que manda el worker a las ventanas abiertas: una alerta nueva, o adónde ir tras tocar una
 * notificación. Se escucha desde la aplicación; aquí sólo está la forma.
 */
export type WorkerMessage =
  | { type: 'jarvis:alert'; alert: unknown }
  | { type: 'jarvis:navigate'; url: string };

export function onWorkerMessage(listener: (message: WorkerMessage) => void): () => void {
  if (!('serviceWorker' in navigator)) return () => undefined;
  const handler = (event: MessageEvent): void => {
    const data = event.data as Partial<WorkerMessage> | null;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
    if (data.type === 'jarvis:alert' || data.type === 'jarvis:navigate') listener(data as WorkerMessage);
  };
  navigator.serviceWorker.addEventListener('message', handler);
  // Con `addEventListener` los mensajes se quedan en cola hasta que se pide empezar.
  navigator.serviceWorker.startMessages();
  return () => navigator.serviceWorker.removeEventListener('message', handler);
}
