/**
 * Cuenta y cuota del agente instalado en un host de ejecución.
 *
 * Los refrescos son a demanda: si ningún navegador autenticado pregunta, no se arranca ninguna
 * CLI. Varios navegadores comparten el mismo refresco en vuelo, así que un host y una cuenta se
 * sondean como mucho una vez por TTL. Sólo sobreviven los campos normalizados: credenciales y
 * salida cruda de terminal no salen de este módulo.
 *
 * El snapshot se persiste, que es la diferencia con el stack viejo: un reinicio ya no convierte
 * «desconocido temporal» en pantalla vacía.
 *
 * Contrato USAGE-01.
 */
import type { Database as Db } from 'better-sqlite3';
import type { Provider, UsageLimit, UsageSnapshot } from '@jarvis/contracts';
import { JarvisError } from '@jarvis/contracts';
import { remoteScript, shellQuote, sshExec, type SshConfig } from '@jarvis/agent-adapters';
import type { Clock } from '../platform/clock.js';

export interface UsageServiceDeps {
  db: Db;
  clock: Clock;
  sshConfig: SshConfig;
  ttlMs: number;
  probeTimeoutMs: number;
}

const limit = (
  label: string, usedPercent: number, windowMinutes: number | null,
  resetsAt: number | null, resetDescription: string | null = null,
): UsageLimit => ({
  label,
  usedPercent: Math.max(0, Math.min(100, Number(usedPercent))),
  remainingPercent: Math.max(0, Math.min(100, 100 - Number(usedPercent))),
  windowMinutes: windowMinutes !== null && Number.isFinite(Number(windowMinutes)) ? Number(windowMinutes) : null,
  resetsAt: resetsAt ? new Date(Number(resetsAt) * 1000).toISOString() : null,
  resetDescription,
});

const parseJsonLines = (text: string): Array<Record<string, unknown>> =>
  String(text).split(/\r?\n/).flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });

/** Quita secuencias ANSI y bloques de dibujo: lo que queda es texto que se puede leer. */
function cleanTerminal(text: string): string {
  return String(text)
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, ' ')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[█▌▐▛▜▝▔]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function claudeLimit(text: string, heading: string, label: string): UsageLimit | null {
  const start = text.toLowerCase().indexOf(heading.toLowerCase());
  if (start < 0) return null;
  const section = text.slice(start, start + 320);
  const usage = section.match(/(\d{1,3})\s*%\s*used/i);
  if (!usage) return null;
  const reset = section.match(/Resets\s*(.+?)(?=\s+Current\s+week|\s+What's|\s+Approx|\s+\+\d|$)/i);
  return limit(label, Number(usage[1]), null, null, reset?.[1]?.trim() ?? null);
}

interface ProbeResult {
  account: { email: string | null; plan: string | null; authMethod: string | null } | null;
  limits: UsageLimit[];
}

export class UsageService {
  readonly #deps: UsageServiceDeps;
  readonly #inFlight = new Map<string, Promise<UsageSnapshot>>();

  constructor(deps: UsageServiceDeps) {
    this.#deps = deps;
  }

  #ssh(host: string, command: string) {
    return sshExec({ host, command, config: this.#deps.sshConfig }, { timeoutMs: this.#deps.probeTimeoutMs });
  }

  #read(provider: Provider, executionHost: string): UsageSnapshot | null {
    const row = this.#deps.db.prepare(
      'SELECT * FROM usage_snapshots WHERE provider = ? AND execution_host = ?',
    ).get(provider, executionHost) as {
      provider: string; execution_host: string; account_json: string | null;
      limits_json: string; fetched_at: string; refresh_error: string | null;
    } | undefined;
    if (!row) return null;
    return {
      provider: row.provider as Provider,
      executionHost: row.execution_host,
      account: row.account_json ? JSON.parse(row.account_json) as UsageSnapshot['account'] : null,
      limits: JSON.parse(row.limits_json) as UsageLimit[],
      fetchedAt: row.fetched_at,
      stale: false,
      refreshError: row.refresh_error,
    };
  }

  #write(snapshot: UsageSnapshot): void {
    this.#deps.db.prepare(`INSERT INTO usage_snapshots
      (provider, execution_host, account_json, limits_json, fetched_at, refresh_error)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (provider, execution_host) DO UPDATE SET
        account_json = excluded.account_json, limits_json = excluded.limits_json,
        fetched_at = excluded.fetched_at, refresh_error = excluded.refresh_error`).run(
      snapshot.provider, snapshot.executionHost,
      snapshot.account ? JSON.stringify(snapshot.account) : null,
      JSON.stringify(snapshot.limits), snapshot.fetchedAt, snapshot.refreshError,
    );
  }

  /**
   * Devuelve el snapshot, refrescándolo sólo si venció.
   *
   * Si el refresco falla y hay un snapshot anterior, se devuelve ese marcado `stale` con el error:
   * un dato viejo y fechado es útil, una pantalla vacía no.
   */
  async get({ provider, executionHost }: { provider: Provider; executionHost: string }): Promise<UsageSnapshot> {
    if (provider !== 'claude' && provider !== 'codex') {
      throw new JarvisError('BAD_REQUEST', `usage is unavailable for provider: ${provider}`);
    }
    const key = `${provider}:${executionHost}`;
    const cached = this.#read(provider, executionHost);
    if (cached && this.#deps.clock.nowMs() - Date.parse(cached.fetchedAt) < this.#deps.ttlMs) {
      return cached;
    }

    let refresh = this.#inFlight.get(key);
    if (!refresh) {
      refresh = this.#refresh(provider, executionHost).finally(() => this.#inFlight.delete(key));
      this.#inFlight.set(key, refresh);
    }

    try {
      return await refresh;
    } catch (error) {
      if (cached) return { ...cached, stale: true, refreshError: (error as Error).message };
      throw error instanceof JarvisError
        ? error
        : new JarvisError('HOST_UNREACHABLE', (error as Error).message, { scope: { host: executionHost, provider } });
    }
  }

  async #refresh(provider: Provider, executionHost: string): Promise<UsageSnapshot> {
    const data = provider === 'codex'
      ? await this.#probeCodex(executionHost)
      : await this.#probeClaude(executionHost);
    const snapshot: UsageSnapshot = {
      provider,
      executionHost,
      account: data.account,
      limits: data.limits,
      fetchedAt: this.#deps.clock.nowIso(),
      stale: false,
      refreshError: null,
    };
    this.#write(snapshot);
    return snapshot;
  }

  async #probeCodex(host: string): Promise<ProbeResult> {
    const requests = [
      { method: 'initialize', id: 1, params: { clientInfo: { name: 'jarvis-core', title: null, version: '0.1.0' }, capabilities: null } },
      { method: 'account/read', id: 2, params: { refreshToken: false } },
      { method: 'account/rateLimits/read', id: 3 },
    ].map((message) => JSON.stringify(message));
    // stdin se mantiene abierto un momento: app-server sale con EOF antes de que terminen las
    // llamadas asíncronas de cuenta.
    const script = `{ printf '%s\\n' ${requests.map((request) => shellQuote(request)).join(' ')}; sleep 2; } | codex app-server --stdio`;
    const result = await this.#ssh(host, remoteScript({
      argv: ['sh', '-c', script], pathExtra: this.#deps.sshConfig.remotePath,
    }));
    const messages = parseJsonLines(result.stdout);
    const account = (messages.find((message) => message['id'] === 2)?.['result'] as { account?: Record<string, string> } | undefined)?.account;
    const quota = (messages.find((message) => message['id'] === 3)?.['result'] as { rateLimits?: Record<string, { usedPercent: number; windowDurationMins: number; resetsAt: number }> & { planType?: string } } | undefined)?.rateLimits;
    if (!account && !quota) throw new Error('Codex did not return account or rate-limit data');

    const limits: UsageLimit[] = [];
    if (quota?.['primary']) {
      const primary = quota['primary'];
      limits.push(limit(primary.windowDurationMins === 300 ? '5h' : 'primary', primary.usedPercent, primary.windowDurationMins, primary.resetsAt));
    }
    if (quota?.['secondary']) {
      const secondary = quota['secondary'];
      limits.push(limit(secondary.windowDurationMins === 10080 ? 'week' : 'secondary', secondary.usedPercent, secondary.windowDurationMins, secondary.resetsAt));
    }
    return {
      account: account ? {
        email: account['email'] ?? null,
        plan: account['planType'] ?? quota?.planType ?? null,
        authMethod: account['type'] ?? null,
      } : null,
      limits,
    };
  }

  async #probeClaude(host: string): Promise<ProbeResult> {
    const authCommand = remoteScript({
      argv: ['claude', 'auth', 'status', '--json'], pathExtra: this.#deps.sshConfig.remotePath,
    });
    // `/usage` es una pantalla local de la CLI. Un TTY desechable la lee sin gastar un turno de
    // modelo. El id de sesión fijo se borra después para que este sondeo no ensucie el índice.
    const probeId = '31e51cb8-f62a-4c31-a868-17231a26d78d';
    const usageScript = `if command -v script >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then `
      + `mkdir -p "$HOME/.cache/jarvis-usage" && cd "$HOME/.cache/jarvis-usage" && `
      + `{ sleep 1; printf '\\033[B\\r'; sleep 2; printf '/usage\\r'; sleep 5; printf '\\033'; sleep 1; printf '/exit\\r'; } `
      + `| timeout 12s script -qec 'claude --permission-mode plan --session-id ${probeId} --settings "{\\"disableRemoteControl\\":true}"' /dev/null; `
      + `find "$HOME/.claude/projects" -type f -name '${probeId}.jsonl' -delete 2>/dev/null || true; fi`;

    const [auth, usage] = await Promise.all([
      this.#ssh(host, authCommand),
      this.#ssh(host, remoteScript({ argv: ['sh', '-c', usageScript], pathExtra: this.#deps.sshConfig.remotePath })),
    ]);

    let account: ProbeResult['account'] = null;
    try {
      const parsed = JSON.parse(auth.stdout.trim()) as Record<string, string>;
      account = {
        email: parsed['email'] ?? null,
        plan: parsed['subscriptionType'] ?? null,
        authMethod: parsed['authMethod'] ?? parsed['apiProvider'] ?? null,
      };
    } catch {
      if (auth.code !== 0) throw new Error('Claude authentication status is unavailable');
    }

    const terminal = cleanTerminal(usage.stdout);
    const limits = [
      claudeLimit(terminal, 'Current session', 'session'),
      claudeLimit(terminal, 'Current week (all models)', 'week'),
    ].filter((value): value is UsageLimit => value !== null);
    return { account, limits };
  }

  /** Lo último que se sabe, sin sondear. Sirve para pintar Health sin gastar una CLI. */
  lastKnown(provider: Provider, executionHost: string): UsageSnapshot | null {
    return this.#read(provider, executionHost);
  }
}
