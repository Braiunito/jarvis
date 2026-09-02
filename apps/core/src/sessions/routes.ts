import type { FastifyInstance } from 'fastify';
import type { Provider } from '@jarvis/contracts';
import { JarvisError } from '@jarvis/contracts';
import { identityOf } from '../app.js';
import type { CoreServices } from '../services.js';

interface SearchQuery {
  q?: string;
  host?: string;
  provider?: Provider;
  cwd?: string;
  limit?: string;
  since?: string;
}

export function registerSessionRoutes(app: FastifyInstance, services: CoreServices): void {
  app.get('/api/sessions', async (request, reply) => {
    const query = (request.query ?? {}) as SearchQuery;
    /**
     * Sin `limit` no se inventa uno aquí: lo decide el servicio, que es quien sabe cuántas caben
     * y quien marca la respuesta como recortada.
     *
     * Esta línea tenía un `?? 50` que pisaba ese acuerdo: la consola pedía sin límite, la ruta
     * mandaba 50 y veintitrés sesiones de la flota no aparecían nunca —ni ellas ni un aviso de que
     * faltaban—. Un tope por si acaso sigue habiendo, pero sólo para lo que alguien pida a mano.
     */
    const asked = Number(query.limit);
    const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 500) : undefined;
    const result = await services.sessions.search({
      q: query.q,
      host: query.host,
      provider: query.provider,
      cwd: query.cwd,
      since: query.since,
      ...(limit ? { limit } : {}),
    });
    return reply.send(result);
  });

  /**
   * Estrenar una sesión: elegir agente y máquina y empezar de cero.
   *
   * Hasta ahora sólo se podía continuar lo que ya existía, así que para abrir una conversación
   * nueva había que ir a la máquina, arrancarla a mano y esperar a que el índice la viera. Aquí se
   * decide lo mismo que se decidía allí —qué agente, dónde, en qué carpeta— y además con qué
   * permiso, que es la parte que a mano se olvida.
   *
   * Dos formas, que no son lo mismo:
   *   · `task`     — un trabajo: se manda algo que hacer y el resultado queda con su evidencia.
   *   · `terminal` — una sesión viva en tmux para mirar y teclear dentro.
   */
  app.post('/api/sessions/new', async (request, reply) => {
    const body = (request.body ?? {}) as {
      host?: string; provider?: Provider; cwd?: string | null;
      permissionProfile?: 'safe' | 'auto' | 'yolo';
      mode?: 'task' | 'terminal'; prompt?: string;
    };
    if (!body.host || !body.provider) {
      throw new JarvisError('BAD_REQUEST', 'hacen falta la máquina y el agente');
    }
    const user = identityOf(request);
    const mode = body.mode ?? 'task';

    if (mode === 'terminal') {
      // La terminal ya sabía empezar sin sesión previa: aquí sólo se le da entrada desde el mismo
      // sitio que el resto, para no tener dos maneras distintas de estrenar.
      const opened = await services.terminal.open({
        host: body.host,
        provider: body.provider,
        ...(body.cwd ? { cwd: body.cwd } : {}),
        ...(body.permissionProfile ? { permissionProfile: body.permissionProfile } : {}),
        user,
      });
      return reply.code(201).send({ mode, terminal: opened });
    }

    const workspace = services.workspaces.startSession({
      host: body.host,
      provider: body.provider,
      ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
    }, user);

    /**
     * Sin tarea no se manda nada: el workspace queda creado y esperando.
     *
     * Es lo que permite estrenar una sesión y escribir la primera instrucción con calma en el
     * compositor, igual que en cualquier otra. El primer trabajo que salga de aquí arrancará el
     * agente limpio, lo decida quien lo decida: eso ya lo sabe el core.
     */
    if (!body.prompt?.trim()) return reply.code(201).send({ mode, workspace });

    const created = await services.runs.create({
      workspaceId: workspace.id,
      prompt: body.prompt,
      ...(body.permissionProfile ? { permissionProfile: body.permissionProfile } : {}),
    }, user, String(request.id));
    return reply.code(201).send({ mode, workspace, run: created.run, target: created.target });
  });

  app.get('/api/sessions/transcript', async (request, reply) => {
    const query = (request.query ?? {}) as { host?: string; provider?: Provider; sessionId?: string; last?: string };
    if (!query.host || !query.provider || !query.sessionId) {
      throw new JarvisError('BAD_REQUEST', 'host, provider and sessionId are required');
    }
    const last = query.last ? Number(query.last) : undefined;
    const transcript = await services.sessions.transcript(
      { host: query.host, provider: query.provider, sessionId: query.sessionId },
      last ? { last } : {},
    );
    return reply.send(transcript);
  });

  app.get('/api/sessions/freshness', async (_request, reply) =>
    reply.send({ hosts: await services.sessions.freshness() }));
}
