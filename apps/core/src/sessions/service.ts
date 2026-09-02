/**
 * Sesiones descubiertas: buscar, previsualizar y saber cuándo se miró por última vez.
 *
 * Jarvis no posee estas sesiones: las posee el CLI remoto. Aquí sólo se traducen a `SessionRef`
 * y se les cuelga el workspace correspondiente si ya existe.
 */
import type { HostFreshness, Provider, SessionRef, SessionSearchResult, SessionSummary, TranscriptMessage } from '@jarvis/contracts';
import { JarvisError } from '@jarvis/contracts';
import type { Clock } from '../platform/clock.js';
import { classifyMessage } from './message-kind.js';
import type { WorkspaceRepository } from '../workspaces/repository.js';
import { freshnessFrom, rowToSummary, type SessionIndex, type SessionQuery } from './index-client.js';

export interface SessionServiceDeps {
  index: SessionIndex;
  workspaces: WorkspaceRepository;
  clock: Clock;
  bastionHost: string;
}

export class SessionService {
  readonly #deps: SessionServiceDeps;

  constructor(deps: SessionServiceDeps) {
    this.#deps = deps;
  }

  /**
   * Buscar nunca cambia nada: devuelve referencias y dice si lo que enseña está viejo.
   *
   * Que un host falle no vacía la lista de los demás; se marca su frescura y ya.
   */
  async search(query: SessionQuery): Promise<SessionSearchResult> {
    const { index, workspaces, clock, bastionHost } = this.#deps;
    /*
     * Cuántas sesiones se piden al índice.
     *
     * El valor de antes eran las 50 que trae el índice por defecto, y con 73 sesiones en la flota
     * eso significaba que 23 no aparecían nunca en el explorador —sin decirlo—. Una lista recortada
     * en silencio hace concluir que lo que falta no existe. Se pide bastante más y, cuando aun así
     * se llena, se avisa.
     */
    const limit = query.limit ?? 300;
    const [list, hosts, status] = await Promise.all([
      index.list({ ...query, limit }),
      index.hosts().catch(() => ({ rows: [], stale: true, error: 'the index did not answer' })),
      // Cuándo barrió el índice. Va aquí y no en otra llamada porque su único uso es explicar una
      // lista vacía, y quien la mira la está mirando ahora.
      index.status?.().catch(() => ({ lastScanAt: null })) ?? Promise.resolve({ lastScanAt: null }),
    ]);

    const known = new Map(workspaces.all().map((workspace) => [
      `${workspace.ref.host}|${workspace.ref.provider}|${workspace.ref.sessionId}`,
      workspace,
    ]));

    const sessions: SessionSummary[] = list.rows.map((row) => {
      const summary = rowToSummary(row, bastionHost);
      const key = `${summary.ref.host}|${summary.ref.provider}|${summary.ref.sessionId}`;
      const workspace = known.get(key);
      return {
        ...summary,
        workspaceId: workspace?.id ?? null,
        workspaceTitle: workspace?.title ?? null,
      };
    });

    const freshness: HostFreshness[] = freshnessFrom(
      hosts.rows, bastionHost, clock.nowMs(), hosts.stale, hosts.error,
    );

    return {
      sessions,
      nextCursor: null,
      freshness,
      stale: list.stale,
      truncated: list.rows.length >= limit,
      indexScannedAt: status.lastScanAt,
      fetchedAt: clock.nowIso(),
    };
  }

  async transcript(
    ref: SessionRef,
    options: { last?: number } = {},
  ): Promise<{ messages: TranscriptMessage[]; truncated: boolean; messageCount: number | null; preview: string | null }> {
    try {
      const payload = await this.#deps.index.transcript(ref, options);
      return {
        messages: payload.messages.map((message) => {
          const { kind, label } = classifyMessage(message.text);
          return {
            role: (['user', 'assistant', 'system', 'tool'].includes(message.role) ? message.role : 'system') as TranscriptMessage['role'],
            at: message.at,
            text: message.text,
            kind,
            label,
            // El transcript viene del CLI remoto: se marca como tal para que nunca se confunda con
            // lo que Jarvis escribió.
            provenance: 'remote-transcript' as const,
          };
        }),
        truncated: payload.truncated,
        messageCount: payload.messageCount ?? null,
        // El primer mensaje aprovechable de la sesión, tal y como lo guardó el índice. Llega gratis
        // con la fila que ya se busca para localizar el `session_key`.
        preview: payload.preview ?? null,
      };
    } catch (error) {
      if (error instanceof JarvisError) throw error;
      const message = (error as Error).message;
      /**
       * El índice sirve transcripts de su propia máquina y rechaza los de las demás con un 501.
       * Es una decisión suya —exportar una sesión remota implica que el servidor abra un ssh— y no
       * un fallo pasajero, así que repetirlo no arregla nada: lo que hace falta es decir por qué
       * esta conversación no se ve y qué sigue funcionando sin ella.
       */
      if (/\b501\b/.test(message)) {
        throw new JarvisError('INDEX_UNAVAILABLE',
          `el índice no sirve conversaciones de otras máquinas (${ref.host}), sólo las del bastión. `
          + 'El trabajo que Jarvis lance sobre esta sesión se ve igual; lo anterior se lee entrando '
          + 'por la terminal o con `aisessions export` en el bastión.',
          { retryable: false, scope: { host: ref.host } });
      }
      throw new JarvisError('INDEX_UNAVAILABLE', `could not read the transcript: ${message}`);
    }
  }

  /**
   * Dónde guardó el CLI esta conversación, según el índice.
   *
   * Devuelve el path del transcript además del `cwd`, porque cuando el `cwd` viene vacío —una
   * sesión sin ningún turno no lo declara en ninguna línea— el nombre del directorio de proyecto
   * es la única pista que queda para deducirlo (TEC-11). El path **no se persiste**: es un dato
   * interno del índice y sale de aquí sólo para resolverlo en el momento (ADR-005).
   */
  async locate(ref: SessionRef): Promise<{ path: string; cwd: string | null; sourceRoot: string | null } | null> {
    const list = await this.#deps.index.list({ host: ref.host, provider: ref.provider, limit: 500 });
    const row = list.rows.find((candidate) => candidate.session_id === ref.sessionId);
    if (!row) return null;
    return { path: row.path, cwd: row.cwd || null, sourceRoot: row.source_root || null };
  }

  async freshness(): Promise<HostFreshness[]> {
    const hosts = await this.#deps.index.hosts();
    return freshnessFrom(hosts.rows, this.#deps.bastionHost, this.#deps.clock.nowMs(), hosts.stale, hosts.error);
  }

  /** Los proveedores que el índice conoce para un host, útil para el selector de terminal. */
  async providersFor(host: string): Promise<Provider[]> {
    const list = await this.#deps.index.list({ host, limit: 200 });
    return [...new Set(list.rows.map((row) => row.provider as Provider))];
  }
}
