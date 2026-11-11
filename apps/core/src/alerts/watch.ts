/**
 * Lo que Jarvis cuenta por su cuenta: el origen `jarvis` de las alertas.
 *
 * Dos fuentes, y las dos se enganchan desde `services.ts` sin que los servicios vigilados sepan
 * que existen las alertas:
 *
 *   · los trabajos que terminan — bien, mal o cancelados —, con la máquina donde corrieron;
 *   · la salud, mirada cada pocos minutos, que avisa cuando algo **cambia** de estado y no cada
 *     vez que se mira: un host apagado una semana es una alerta, no dos mil.
 */
import type { Health, HealthCheck, Run } from '@jarvis/contracts';
import type { AlertService } from './service.js';

const snippet = (text: string | null | undefined, max = 300): string | null => {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

/** Cómo se llama el trabajo en una notificación: el título del workspace, o lo que se pidió. */
export function runAlert(run: Run, name: string | null, alerts: AlertService,
  hostName: (host: string) => string = (host) => host): void {
  const what = snippet(name, 80) ?? snippet(run.promptPreview, 80) ?? run.id;
  const origin = { kind: 'jarvis' as const, host: hostName(run.executionHost), app: `runs/${run.provider}` };
  const link = `/runs/${run.id}`;
  if (run.status === 'completed') {
    alerts.notify({ title: `Terminó: ${what}`, body: snippet(run.resultSummary), importance: 'normal', link, origin });
  } else if (run.status === 'failed' || run.status === 'timed_out') {
    alerts.notify({
      title: `${run.status === 'timed_out' ? 'Se pasó de tiempo' : 'Falló'}: ${what}`,
      body: snippet(run.errorMessage ?? run.resultSummary) ?? (run.errorCode ? `Código ${run.errorCode}` : null),
      importance: 'high', link, origin,
    });
  } else if (run.status === 'cancelled') {
    alerts.notify({ title: `Cancelado: ${what}`, body: null, importance: 'low', link, origin });
  }
}

type Tone = 'ok' | 'bad';
const toneOf = (check: HealthCheck): Tone | null =>
  check.status === 'ok' ? 'ok'
    : check.status === 'failed' || check.status === 'degraded' ? 'bad'
      : null; // `stale` y `unknown` no dicen nada nuevo: ni se avisa ni se olvida lo anterior.

/** Qué decir de cada comprobación, en las palabras de la pantalla de Salud. */
function describe(key: string, check: HealthCheck): { title: string; recovered: string; critical: boolean } {
  if (key.startsWith('ssh:')) {
    const host = key.slice(4);
    return { title: `${host} no responde`, recovered: `${host} vuelve a responder`, critical: false };
  }
  if (key === 'database') {
    return { title: 'La base del core falla', recovered: 'La base del core vuelve a estar bien', critical: true };
  }
  if (key === 'aisessions') {
    return { title: 'El índice de sesiones no responde', recovered: 'El índice de sesiones vuelve a responder', critical: false };
  }
  if (key === 'runs') {
    return { title: 'Hay trabajos que no confirman su cancelación', recovered: 'Las cancelaciones pendientes se confirmaron', critical: false };
  }
  return { title: `Salud: ${key} con problemas`, recovered: `Salud: ${key} vuelve a estar bien`, critical: check.status === 'failed' };
}

/**
 * Vigila la salud y avisa de los cambios.
 *
 * Un fallo tiene que verse **dos veces seguidas** antes de avisar: un sondeo SSH que se corta una
 * vez no es un host caído, y una notificación en falso enseña a ignorar las de verdad. La primera
 * vuelta sólo aprende cómo está todo: arrancar el core no puede disparar una alerta por cada host
 * que ya estaba apagado antes.
 */
export class HealthWatch {
  readonly #snapshot: () => Promise<Health>;
  readonly #alerts: AlertService;
  readonly #host: string;
  readonly #intervalMs: number;
  /** Lo último confirmado de cada comprobación, y cuántas veces seguidas se vio lo contrario. */
  readonly #state = new Map<string, { tone: Tone; pending: number }>();
  #timer: NodeJS.Timeout | null = null;
  #first = true;

  constructor({ snapshot, alerts, host, intervalMs }: {
    snapshot: () => Promise<Health>;
    alerts: AlertService;
    /** La máquina donde vive el core: es de donde salen estas alertas. */
    host: string;
    intervalMs: number;
  }) {
    this.#snapshot = snapshot;
    this.#alerts = alerts;
    this.#host = host;
    this.#intervalMs = intervalMs;
  }

  start(): void {
    if (this.#intervalMs <= 0 || this.#timer) return;
    this.#timer = setInterval(() => { void this.tick(); }, this.#intervalMs);
    this.#timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async tick(): Promise<void> {
    let health: Health;
    try {
      health = await this.#snapshot();
    } catch {
      return; // Si no se puede ni mirar, lo dirá Salud; aquí no hay nada fiable que contar.
    }
    for (const [key, check] of Object.entries(health.checks)) {
      const tone = toneOf(check);
      if (!tone) continue;
      const known = this.#state.get(key);
      if (!known || this.#first) {
        this.#state.set(key, { tone, pending: 0 });
        continue;
      }
      if (tone === known.tone) {
        known.pending = 0;
        continue;
      }
      known.pending += 1;
      if (known.pending < 2) continue;
      this.#state.set(key, { tone, pending: 0 });
      const words = describe(key, check);
      this.#alerts.notify(tone === 'bad'
        ? {
          title: words.title,
          body: snippet(check.message ?? null),
          importance: words.critical ? 'critical' : 'high',
          link: '/health',
          origin: { kind: 'jarvis', host: this.#host, app: 'salud' },
        }
        : {
          title: words.recovered,
          importance: 'low',
          link: '/health',
          origin: { kind: 'jarvis', host: this.#host, app: 'salud' },
        });
    }
    this.#first = false;
  }
}
