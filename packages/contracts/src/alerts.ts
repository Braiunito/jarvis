import { Type, type Static } from '@sinclair/typebox';
import { Iso8601 } from './common.js';

/**
 * Alertas: lo que Jarvis —o cualquiera con la clave— quiere que sepas aunque no estés mirando.
 *
 * Se distinguen por dos ejes que no se mezclan:
 *
 *   · **importancia**, que decide si suena: `low` sólo se apunta, `normal` y `high` llegan como
 *     notificación, y `critical` además se queda en pantalla hasta que la quitas;
 *   · **origen**, que dice quién la mandó: por la API con la clave (`api`, desde cualquier
 *     máquina) o el propio Jarvis (`jarvis`, al terminar un trabajo o caerse un host). La máquina
 *     va aparte, en `host`, y `app` nombra al remitente concreto («claude-code», «backup»…).
 */
export const ALERT_IMPORTANCES = ['low', 'normal', 'high', 'critical'] as const;
export type AlertImportance = (typeof ALERT_IMPORTANCES)[number];
export const AlertImportanceSchema = Type.Union(ALERT_IMPORTANCES.map((value) => Type.Literal(value)));

/** De menos a más: sirve para comparar con un mínimo (`rank(a) >= rank(min)`). */
export const alertImportanceRank = (importance: AlertImportance): number =>
  ALERT_IMPORTANCES.indexOf(importance);

export const ALERT_ORIGIN_KINDS = ['api', 'jarvis'] as const;
export type AlertOriginKind = (typeof ALERT_ORIGIN_KINDS)[number];
export const AlertOriginKindSchema = Type.Union(ALERT_ORIGIN_KINDS.map((value) => Type.Literal(value)));

/** Un nombre de máquina o de remitente: corto y sin nada que haya que escapar al pintarlo. */
const Label = Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._@:/ -]+$' });

export const AlertOrigin = Type.Object({
  kind: AlertOriginKindSchema,
  /** La máquina donde nació: `braian`, `zeus`, `goro2`… */
  host: Type.String(),
  /** Quién la mandó dentro de esa máquina, si lo dijo. */
  app: Type.Union([Type.String(), Type.Null()]),
});
export type AlertOrigin = Static<typeof AlertOrigin>;

export const Alert = Type.Object({
  id: Type.String(),
  createdAt: Iso8601,
  importance: AlertImportanceSchema,
  title: Type.String(),
  body: Type.Union([Type.String(), Type.Null()]),
  /** Ruta de la consola (`/runs/run_…`) o URL absoluta a la que lleva tocarla. */
  link: Type.Union([Type.String(), Type.Null()]),
  origin: AlertOrigin,
  readAt: Type.Union([Iso8601, Type.Null()]),
  /** A cuántos dispositivos se entregó como notificación; 0 si no se mandó a ninguno. */
  pushedTo: Type.Integer({ minimum: 0 }),
});
export type Alert = Static<typeof Alert>;

/**
 * Lo que se manda por la API para crear una alerta.
 *
 * El origen `kind` no se acepta: quien entra por la API es `api`, siempre, y sólo el core puede
 * firmar algo como `jarvis`. `host` sí lo declara quien llama, porque es lo que sabe.
 */
export const CreateAlertRequest = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
  body: Type.Optional(Type.String({ maxLength: 4000 })),
  importance: Type.Optional(AlertImportanceSchema),
  host: Type.Optional(Label),
  app: Type.Optional(Label),
  link: Type.Optional(Type.String({ maxLength: 500 })),
}, { additionalProperties: false });
export type CreateAlertRequest = Static<typeof CreateAlertRequest>;

export const AlertList = Type.Object({
  alerts: Type.Array(Alert),
  /** Sin leer en total, no sólo en esta página. */
  unread: Type.Integer({ minimum: 0 }),
  /** La más grave de las no leídas, para dar color al icono sin pedir la lista entera. */
  unreadTop: Type.Union([AlertImportanceSchema, Type.Null()]),
  /** Máquinas y remitentes que aparecen en el historial: los filtros salen de aquí. */
  hosts: Type.Array(Type.String()),
});
export type AlertList = Static<typeof AlertList>;

export const MarkAlertsReadRequest = Type.Object({
  ids: Type.Optional(Type.Array(Type.String(), { maxItems: 500 })),
  /** Todas las no leídas, sin listarlas. */
  all: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export type MarkAlertsReadRequest = Static<typeof MarkAlertsReadRequest>;

/** La suscripción tal y como la da `PushSubscription.toJSON()`, más lo que decide quien la crea. */
export const PushSubscriptionRequest = Type.Object({
  endpoint: Type.String({ minLength: 10, maxLength: 2000, pattern: '^https://' }),
  keys: Type.Object({
    p256dh: Type.String({ minLength: 20, maxLength: 200 }),
    auth: Type.String({ minLength: 8, maxLength: 100 }),
  }),
  /** Por debajo de esto no suena en este dispositivo. `normal` por defecto. */
  minImportance: Type.Optional(AlertImportanceSchema),
  /** Cómo se llama el dispositivo en la lista: «Pixel», «Firefox en braian»… */
  label: Type.Optional(Type.String({ maxLength: 80 })),
});
export type PushSubscriptionRequest = Static<typeof PushSubscriptionRequest>;

export const PushDevice = Type.Object({
  /** Un resumen del endpoint, no el endpoint: con él se podría mandar a ese dispositivo. */
  id: Type.String(),
  label: Type.Union([Type.String(), Type.Null()]),
  service: Type.String(),
  minImportance: AlertImportanceSchema,
  createdAt: Iso8601,
  lastOkAt: Type.Union([Iso8601, Type.Null()]),
  lastError: Type.Union([Type.String(), Type.Null()]),
});
export type PushDevice = Static<typeof PushDevice>;

export const PushStatus = Type.Object({
  /** La clave pública VAPID, en base64url: la que pide `pushManager.subscribe`. */
  publicKey: Type.String(),
  devices: Type.Array(PushDevice),
});
export type PushStatus = Static<typeof PushStatus>;

/**
 * Lo que viaja dentro de cada notificación push, cifrado. El service worker lo lee para pintar
 * la notificación y para saber adónde llevar al tocarla.
 */
export interface AlertPushPayload {
  id: string;
  title: string;
  body: string | null;
  importance: AlertImportance;
  origin: AlertOrigin;
  link: string | null;
  createdAt: string;
}
