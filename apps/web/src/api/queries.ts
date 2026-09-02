/**
 * Los datos del servidor viven en TanStack Query, no en un store propio.
 *
 * Los defaults se fijan por dominio a propósito: una consola operativa no puede aceptar «todo es
 * stale al instante y se refresca al enfocar la ventana» para cosas que cuestan un SSH.
 */
import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  Approval, Attachment, Draft, Health, HostCapabilities, Plan, PlanStep, Run, RunEvent,
  SessionSearchResult, TargetPlan, TerminalSession, TranscriptMessage, UsageSnapshot, Workspace,
} from '@jarvis/contracts';
import { get, post, put } from './client.js';

export interface MetricsSnapshot {
  window: { hours: number; from: string; to: string };
  runs: {
    total: number;
    previousTotal: number;
    deltaPercent: number | null;
    active: number;
    needsAttention: number;
    byProvider: Array<{ provider: string; runs: number; percent: number }>;
    byStatus: Array<{ status: string; runs: number }>;
    totalDurationMs: number;
    medianDurationMs: number | null;
    buckets: Array<{ at: string; runs: number; failed: number }>;
  };
  workspaces: { total: number; openedInWindow: number };
  plans: { active: number; waitingApproval: number };
  /** La ventana de cuota más apretada de cada cuenta, sin tocar la red. */
  usage?: Array<{
    provider: string;
    executionHost: string;
    plan: string | null;
    label: string;
    remainingPercent: number;
    resetsAt: string | null;
    fetchedAt: string;
    stale: boolean;
  }>;
  /**
   * Terminales interactivas abiertas en la flota.
   *
   * Es lo último que se sabe, con su marca: contar de verdad cuesta una conexión por máquina, así
   * que el core lo cachea. Con `at` en null no se ha contado nunca todavía —y ahí es mejor no
   * pintar nada que pintar un cero que no es cierto.
   */
  terminals?: { open: number; byHost: Array<{ host: string; open: number }>; at: string | null; stale: boolean };
}

export const keys = {
  health: ['health'] as const,
  hosts: ['hosts'] as const,
  sessions: (query: SessionQuery) => ['sessions', query] as const,
  workspaces: ['workspaces'] as const,
  workspace: (id: string) => ['workspace', id] as const,
  target: (id: string, profile: string) => ['target', id, profile] as const,
  transcript: (host: string, provider: string, sessionId: string) => ['transcript', host, provider, sessionId] as const,
  run: (id: string) => ['run', id] as const,
  runEvents: (id: string) => ['run-events', id] as const,
  runs: ['runs'] as const,
  usage: (workspaceId: string) => ['usage', workspaceId] as const,
  terminals: (host: string) => ['terminals', host] as const,
  metrics: (hours: number) => ['metrics', hours] as const,
  plans: (workspaceId: string) => ['plans', workspaceId] as const,
  plan: (planId: string) => ['plan', planId] as const,
};

export interface SessionQuery {
  q?: string;
  host?: string;
  provider?: string;
}

export interface WorkspaceDetail {
  workspace: Workspace;
  draft: Draft;
  runs: Run[];
  attachments: Attachment[];
  /** El core está poniéndole nombre a esto ahora mismo. Ver `useWorkspace`. */
  titlePending?: boolean;
}

const search = (query: SessionQuery): string => {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.host) params.set('host', query.host);
  if (query.provider) params.set('provider', query.provider);
  return params.toString() ? `?${params.toString()}` : '';
};

/** Salud: cambia sola y se mira a menudo, pero sondear hosts cuesta un SSH por host. */
export const useHealth = (): UseQueryResult<Health> => useQuery({
  queryKey: keys.health,
  queryFn: () => get<Health>('/api/health'),
  staleTime: 15_000,
  refetchInterval: 60_000,
  retry: 1,
});

/**
 * La flota, para pintar selectores: lo último que se sabe, sin esperar a un sondeo.
 *
 * `probe` la convierte en la consulta cara —una conexión SSH por host— que sólo tiene sentido en
 * la pantalla de Salud.
 */
/**
 * Los agregados del panel.
 *
 * Se piden al servidor y no se calculan aquí: el navegador sólo tiene la última página de runs, y
 * de ahí no sale una comparación con el periodo anterior que se pueda creer.
 */
export const useMetrics = (hours = 24): UseQueryResult<MetricsSnapshot> => useQuery({
  queryKey: keys.metrics(hours),
  queryFn: () => get<MetricsSnapshot>(`/api/metrics?hours=${hours}`),
  staleTime: 20_000,
  refetchInterval: 60_000,
});

export const useHosts = (
  { probe = false }: { probe?: boolean } = {},
): UseQueryResult<{ hosts: HostCapabilities[]; bastionHost: string; probed: boolean }> => useQuery({
  queryKey: [...keys.hosts, probe] as const,
  queryFn: () => get<{ hosts: HostCapabilities[]; bastionHost: string; probed: boolean }>(
    `/api/hosts${probe ? '?probe=1' : ''}`,
  ),
  staleTime: probe ? 30_000 : 5 * 60_000,
});

/**
 * Buscar sesiones no cambia nada y puede devolver datos viejos: es preferible enseñarlos fechados
 * a dejar la pantalla en blanco mientras el índice se recupera.
 */
export const useSessions = (query: SessionQuery): UseQueryResult<SessionSearchResult> => useQuery({
  queryKey: keys.sessions(query),
  queryFn: () => get<SessionSearchResult>(`/api/sessions${search(query)}`),
  staleTime: 30_000,
  placeholderData: (previous) => previous,
});

export const useWorkspaces = (): UseQueryResult<{ workspaces: Workspace[] }> => useQuery({
  queryKey: keys.workspaces,
  queryFn: () => get<{ workspaces: Workspace[] }>('/api/workspaces?limit=25'),
  staleTime: 10_000,
});

/**
 * El detalle del workspace.
 *
 * Abrirlo puede disparar el nombrado automático en el core: cuando el título que traía la sesión
 * es un hash o el preámbulo de una CLI, se sustituye por lo que la persona pidió. Eso tarda unos
 * segundos y ocurre en el servidor, así que mientras `titlePending` esté puesto se vuelve a
 * preguntar; en cuanto llega el nombre, se deja de preguntar. Sin esto habría que recargar para
 * ver el título nuevo.
 */
export const useWorkspace = (id: string | null): UseQueryResult<WorkspaceDetail> => useQuery({
  queryKey: keys.workspace(id ?? 'none'),
  queryFn: () => get<WorkspaceDetail>(`/api/workspaces/${id as string}`),
  enabled: Boolean(id),
  staleTime: 5_000,
  refetchInterval: (query) => (query.state.data?.titlePending ? 4_000 : false),
});

/** Cuántos mensajes finales se piden. La cabecera lo dice cuando la sesión tiene más. */
export const TRANSCRIPT_PAGE = 40;

export const useTranscript = (workspace: Workspace | undefined) => useQuery({
  queryKey: workspace
    ? keys.transcript(workspace.ref.host, workspace.ref.provider, workspace.ref.sessionId)
    : ['transcript', 'none'],
  queryFn: () => get<{
    // El tipo del contrato, no una copia a mano: cuando el core añadió `kind` y `label` para
    // distinguir un comando de la CLI de algo que escribió una persona, la copia se quedó vieja.
    messages: TranscriptMessage[];
    truncated: boolean;
    /** Los mensajes que tiene la sesión, que no son los que caben en esta página. */
    messageCount: number | null;
    /**
     * Si esta conversación se puede continuar.
     *
     * Lo afirma el core comprobándolo contra la máquina, no se deduce del número de mensajes: hay
     * sesiones con turnos que no son turnos —un `/comando` y su salida— y no tienen nada que
     * reanudar.
     */
    resumable?: boolean;
  }>(
    `/api/sessions/transcript?host=${encodeURIComponent(workspace!.ref.host)}`
    + `&provider=${workspace!.ref.provider}&sessionId=${encodeURIComponent(workspace!.ref.sessionId)}&last=${TRANSCRIPT_PAGE}`,
  ),
  enabled: Boolean(workspace),
  staleTime: 60_000,
  retry: 0,
});

/** El destino efectivo. Se pide por perfil porque el perfil puede cambiar la estrategia. */
export const useTarget = (workspaceId: string | null, permissionProfile: string) => useQuery({
  queryKey: keys.target(workspaceId ?? 'none', permissionProfile),
  queryFn: () => get<{ target: TargetPlan }>(`/api/workspaces/${workspaceId as string}/target?permissionProfile=${permissionProfile}`),
  enabled: Boolean(workspaceId),
  staleTime: 60_000,
  retry: 0,
});

export const useRuns = (): UseQueryResult<{ runs: Run[] }> => useQuery({
  queryKey: keys.runs,
  queryFn: () => get<{ runs: Run[] }>('/api/runs?limit=50'),
  staleTime: 3_000,
  refetchInterval: 10_000,
});

export const useRun = (runId: string | null): UseQueryResult<{ run: Run }> => useQuery({
  queryKey: keys.run(runId ?? 'none'),
  queryFn: () => get<{ run: Run }>(`/api/runs/${runId as string}`),
  enabled: Boolean(runId),
  staleTime: 2_000,
});

/**
 * Cuenta y cuota del agente.
 *
 * El TTL de cinco minutos vive en el servidor, así que preguntar de más no arranca una CLI ni
 * gasta cuota: devuelve el mismo snapshot. Por eso aquí sí se refresca al volver a la ventana —lo
 * que importa es no mirar un número de hace media hora antes de mandar trabajo—, con el intervalo
 * un poco por encima del TTL para no pedir justo en la frontera.
 *
 * OpenCode no publica cuota: preguntar por él es un 400 garantizado, así que ni se pregunta.
 */
export const useUsage = (workspace: Workspace | undefined): UseQueryResult<UsageSnapshot> => {
  const client = useQueryClient();
  const workspaceId = workspace?.id ?? null;
  const enabled = Boolean(workspaceId) && workspace?.ref.provider !== 'opencode';
  const query = useQuery({
    queryKey: keys.usage(workspaceId ?? 'none'),
    queryFn: () => get<UsageSnapshot>(`/api/usage?workspaceId=${workspaceId as string}`),
    enabled,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000 + 5_000,
    refetchOnWindowFocus: true,
    retry: 0,
  });

  /**
   * El sondeo a medias, reintentado una sola vez.
   *
   * A un Claude recién instalado le sale una pantalla de bienvenida antes de `/usage`, y el primer
   * sondeo vuelve con la cuenta pero sin cuotas. Se reintenta a los diez segundos saltándose el
   * TTL; **una vez**, porque convertir un fallo permanente en un sondeo cada diez segundos sería
   * peor que el hueco que arregla.
   */
  const retried = useRef<string | null>(null);
  const data = query.data;
  useEffect(() => {
    if (!enabled || !workspaceId || !data) return undefined;
    if (data.provider !== 'claude' || data.limits.length > 0) return undefined;
    if (retried.current === workspaceId) return undefined;
    retried.current = workspaceId;
    const timer = window.setTimeout(() => {
      void get<UsageSnapshot>(`/api/usage?workspaceId=${workspaceId}&retryPartial=1`)
        .then((fresh) => client.setQueryData(keys.usage(workspaceId), fresh))
        .catch(() => undefined);
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [client, data, enabled, workspaceId]);

  return query;
};

/**
 * Las sesiones de terminal cambian por acciones que no pasan por esta pestaña —otra persona, un
 * run, uno mismo desde el móvil—, así que al volver a la pantalla se vuelven a pedir. Servir la
 * caché de hace un rato aquí significa enseñar una lista vacía cuando la sesión existe.
 */
export const useTerminals = (host: string | null): UseQueryResult<{ sessions: TerminalSession[] }> => useQuery({
  queryKey: keys.terminals(host ?? 'none'),
  queryFn: () => get<{ sessions: TerminalSession[] }>(`/api/terminal/sessions?host=${encodeURIComponent(host as string)}`),
  enabled: Boolean(host),
  staleTime: 2_000,
  refetchOnMount: 'always',
});

export interface PlanListResult {
  plans: Plan[];
  approvals: Approval[];
  assistantAvailable: boolean;
}

export const usePlans = (workspaceId: string | null): UseQueryResult<PlanListResult> => useQuery({
  queryKey: keys.plans(workspaceId ?? 'none'),
  queryFn: () => get<PlanListResult>(`/api/plans?workspaceId=${workspaceId as string}`),
  enabled: Boolean(workspaceId),
  staleTime: 2_000,
  // Un plan avanza solo en el servidor: la interfaz lo mira de vez en cuando en lugar de
  // mantener una conexión abierta esperando.
  refetchInterval: 4_000,
});

export const usePlan = (planId: string | null) => useQuery({
  queryKey: keys.plan(planId ?? 'none'),
  queryFn: () => get<{ plan: Plan; steps: PlanStep[]; approvals: Approval[] }>(`/api/plans/${planId as string}`),
  enabled: Boolean(planId),
  staleTime: 1_000,
  refetchInterval: 3_000,
});

export function useCreatePlan(workspaceId: string | null) {
  const client = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: (objective: string) => post<{ plan: Plan }>('/api/plans', { workspaceId, objective }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.plans(workspaceId ?? 'none') });
    },
  });
}

export function useResolveApproval() {
  const client = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: ({ id, decision }: { id: string; decision: 'approved' | 'rejected' }) =>
      post<{ approval: Approval }>(`/api/approvals/${id}`, { decision }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['plans'] });
      void client.invalidateQueries({ queryKey: ['plan'] });
    },
  });
}

/**
 * Responder a lo que el plan pregunta.
 *
 * Una pregunta sin sitio donde contestarla deja el plan parado para siempre, así que esto es
 * parte del ciclo, no un extra: el servidor lo reanuda en cuanto llega la respuesta.
 */
export function useAnswerPlan() {
  const client = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: ({ planId, answer }: { planId: string; answer: string }) =>
      post<{ plan: Plan }>(`/api/plans/${planId}/input`, { answer }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['plans'] });
      void client.invalidateQueries({ queryKey: ['plan'] });
    },
  });
}

export function useCancelPlan() {
  const client = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: (planId: string) => post<{ plan: Plan }>(`/api/plans/${planId}/cancel`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['plans'] });
    },
  });
}

/**
 * Estrenar una sesión.
 *
 * Dos formas que no son la misma cosa: un trabajo deja evidencia y una terminal es un TTY. Y en
 * la primera, el prompt es opcional: sin él se crea el workspace vacío y la primera tarea se
 * escribe en el compositor, como en cualquier otro.
 */
export interface StartSessionResult {
  mode: 'task' | 'terminal';
  workspace: Workspace;
  run?: Run;
  terminal: { name: string; host: string; created: boolean };
}

export function useStartSession() {
  const client = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: (input: {
      host: string;
      provider: string;
      mode: 'task' | 'terminal';
      cwd?: string | null;
      permissionProfile?: string;
      prompt?: string;
    }) => post<StartSessionResult>('/api/sessions/new', input),
    onSuccess: (_data, variables) => {
      void client.invalidateQueries({ queryKey: ['sessions'] });
      void client.invalidateQueries({ queryKey: keys.workspaces });
      void client.invalidateQueries({ queryKey: keys.runs });
      void client.invalidateQueries({ queryKey: keys.terminals(variables.host) });
      void client.invalidateQueries({ queryKey: ['metrics'] });
    },
  });
}

export function useOpenWorkspace() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { ref: { host: string; provider: string; sessionId: string }; cwd?: string | null; title?: string | null }) =>
      post<{ workspace: Workspace; created: boolean }>('/api/workspaces', input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.workspaces });
    },
  });
}

/** El nombre que pone una persona: a partir de ahí, el automático no vuelve a tocarlo. */
export function useRenameWorkspace(workspaceId: string | null) {
  const client = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: (title: string) => put<{ workspace: Workspace }>(`/api/workspaces/${workspaceId as string}/title`, { title }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.workspace(workspaceId ?? 'none') });
      void client.invalidateQueries({ queryKey: keys.workspaces });
    },
  });
}

export function useSaveDraft(workspaceId: string | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { body: string; expectedVersion: number }) =>
      put<Draft>(`/api/workspaces/${workspaceId as string}/draft`, input),
    onSuccess: (draft) => {
      client.setQueryData(keys.workspace(workspaceId ?? 'none'), (previous: WorkspaceDetail | undefined) =>
        previous ? { ...previous, draft } : previous);
    },
  });
}

export function useCreateRun(workspaceId: string | null) {
  const client = useQueryClient();
  return useMutation({
    // Nunca se reintenta sola una mutación con efectos: la clave de idempotencia la pone quien
    // llama, y sólo entonces repetir es seguro.
    retry: 0,
    mutationFn: (input: { prompt: string; permissionProfile: string; idempotencyKey: string; attachmentIds?: string[] }) =>
      post<{ run: Run; target: TargetPlan; replayed: boolean }>('/api/runs', { workspaceId, ...input }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.runs });
      void client.invalidateQueries({ queryKey: ['metrics'] });
      void client.invalidateQueries({ queryKey: keys.workspace(workspaceId ?? 'none') });
    },
  });
}

/**
 * Abrir (o retomar) una terminal.
 *
 * Es una mutación y no una llamada suelta porque **cambia lo que hay en la máquina**: si la lista
 * de sesiones no se entera, enseña el mundo de hace un rato. Eso pasaba: abrías una terminal,
 * volvías a la pantalla y la lista seguía diciendo que no había ninguna.
 */
export function useOpenTerminal() {
  const client = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: (input: { host: string; provider: string; sessionId?: string | null }) =>
      post<{ name: string; host: string; created: boolean }>('/api/terminal/open', {
        host: input.host, provider: input.provider, sessionId: input.sessionId ?? null,
      }),
    onSuccess: (_data, variables) => {
      void client.invalidateQueries({ queryKey: keys.terminals(variables.host) });
      // El contador del carril vive en `metrics`: sin esto, abres una terminal y el número sigue
      // diciendo lo de antes hasta el siguiente sondeo.
      void client.invalidateQueries({ queryKey: ['metrics'] });
    },
  });
}

/**
 * Destruir una terminal.
 *
 * Es lo contrario de salir de la pantalla: salir no mata nada —la tmux sigue viva al otro lado—,
 * y esto sí. Por eso es una acción aparte, con su confirmación, y no un efecto de navegar.
 */
export function useDestroyTerminal() {
  const client = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: ({ host, name }: { host: string; name: string }) =>
      post<{ ok: true }>('/api/terminal/destroy', { host, name }),
    onSuccess: (_data, variables) => {
      void client.invalidateQueries({ queryKey: keys.terminals(variables.host) });
    },
  });
}

/**
 * Dar por visto un trabajo que reclamaba atención.
 *
 * No cambia su estado: sigue fallido, con sus eventos y su evidencia. Lo único que cambia es que
 * deja de contar en «requieren atención», que es lo que hacía que el aviso se quedara encendido
 * para siempre por cuatro fallos de la semana pasada.
 */
export function useAcknowledgeRun() {
  const client = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: (runId: string | null) =>
      post<{ acknowledged: number }>(runId ? `/api/runs/${runId}/ack` : '/api/runs/ack'),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.runs });
      void client.invalidateQueries({ queryKey: ['metrics'] });
      void client.invalidateQueries({ queryKey: ['run'] });
    },
  });
}

export function useCancelRun() {
  const client = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: (runId: string) => post<{ run: Run }>(`/api/runs/${runId}/cancel`),
    onSuccess: ({ run }) => {
      client.setQueryData(keys.run(run.id), { run });
      void client.invalidateQueries({ queryKey: keys.runs });
      void client.invalidateQueries({ queryKey: ['metrics'] });
    },
  });
}

export function useRetryRun() {
  const client = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: (runId: string) => post<{ run: Run }>(`/api/runs/${runId}/retry`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.runs });
      void client.invalidateQueries({ queryKey: ['metrics'] });
    },
  });
}

export type { Run, RunEvent, Workspace };
