/**
 * La flota: qué hosts hay, qué tienen instalado y si responden.
 *
 * Las capacidades se cachean en memoria (TTL) y se persisten, para que una sonda fallida no borre
 * lo que ya sabíamos: se sirve el último resultado bueno marcado como viejo.
 */
import type { Database as Db } from 'better-sqlite3';
import type { HostCapabilities, Provider } from '@jarvis/contracts';
import type { CapabilityCache } from '@jarvis/agent-adapters';
import type { Clock } from '../platform/clock.js';

export interface FleetServiceDeps {
  db: Db;
  clock: Clock;
  capabilities: CapabilityCache;
  hosts: readonly string[];
  bastionHost: string;
}

interface CapabilityRow {
  host: string;
  binaries_json: string;
  providers_json: string;
  tmux: number;
  probed_at: string;
  error: string | null;
}

export class FleetService {
  readonly #deps: FleetServiceDeps;

  constructor(deps: FleetServiceDeps) {
    this.#deps = deps;
  }

  #persist(capabilities: HostCapabilities, error: string | null): void {
    this.#deps.db.prepare(`INSERT INTO host_capabilities
      (host, binaries_json, providers_json, tmux, probed_at, error)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (host) DO UPDATE SET binaries_json = excluded.binaries_json,
        providers_json = excluded.providers_json, tmux = excluded.tmux,
        probed_at = excluded.probed_at, error = excluded.error`).run(
      capabilities.host, JSON.stringify(capabilities.binaries), JSON.stringify(capabilities.providers),
      capabilities.tmux ? 1 : 0, capabilities.probedAt, error,
    );
  }

  #lastKnown(host: string): HostCapabilities | null {
    const row = this.#deps.db.prepare('SELECT * FROM host_capabilities WHERE host = ?')
      .get(host) as CapabilityRow | undefined;
    if (!row) return null;
    return {
      host: row.host,
      reachable: !row.error,
      binaries: JSON.parse(row.binaries_json) as Record<string, string | null>,
      providers: JSON.parse(row.providers_json) as Provider[],
      tmux: row.tmux === 1,
      probedAt: row.probed_at,
      stale: true,
      error: row.error,
    };
  }

  /** Un host. Nunca lanza por una sonda fallida si hay algo anterior que enseñar. */
  async describe(host: string, { force = false }: { force?: boolean } = {}): Promise<HostCapabilities> {
    try {
      const capabilities = await this.#deps.capabilities.detect(host, { force });
      this.#persist(capabilities, null);
      return capabilities;
    } catch (error) {
      const message = (error as Error).message;
      const previous = this.#lastKnown(host);
      if (previous) return { ...previous, reachable: false, stale: true, error: message };
      return {
        host,
        reachable: false,
        binaries: {},
        providers: [],
        tmux: false,
        probedAt: this.#deps.clock.nowIso(),
        stale: true,
        error: message,
      };
    }
  }

  async list({ force = false }: { force?: boolean } = {}): Promise<HostCapabilities[]> {
    return Promise.all(this.#deps.hosts.map((host) => this.describe(host, { force })));
  }

  /**
   * Lo que ya se sabe, sin tocar la red.
   *
   * Un host del que nunca se supo nada sale como «desconocido», no como «caído»: no es lo mismo, y
   * decir lo segundo sin haber mirado sería mentir.
   */
  known(): HostCapabilities[] {
    return this.#deps.hosts.map((host) => this.#lastKnown(host) ?? {
      host,
      reachable: false,
      binaries: {},
      providers: [],
      tmux: false,
      probedAt: this.#deps.clock.nowIso(),
      stale: true,
      error: null,
    });
  }

  get hosts(): readonly string[] { return this.#deps.hosts; }
  get bastionHost(): string { return this.#deps.bastionHost; }
}
