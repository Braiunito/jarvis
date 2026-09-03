import type { FastifyInstance } from 'fastify';
import { JarvisError, type OpenTerminalRequest } from '@jarvis/contracts';
import { identityOf } from '../app.js';
import type { CoreServices } from '../services.js';

export function registerTerminalRoutes(app: FastifyInstance, services: CoreServices): void {
  app.get('/api/terminal/sessions', async (request, reply) => {
    const host = (request.query as { host?: string } | undefined)?.host;
    if (!host) throw new JarvisError('BAD_REQUEST', 'host is required');
    return reply.send({ sessions: await services.terminal.list(host) });
  });

  /**
   * Abrir una terminal, con el directorio resuelto por el servidor cuando se abre desde un
   * workspace.
   *
   * Antes había que mandarle el `cwd` en la petición, y eso deja la parte más delicada en manos de
   * quien llama: si llega mal, el agente se abre en la carpeta equivocada, y en una terminal viva
   * eso significa que una persona empieza a editar los ficheros de otro sitio. Quien conoce el
   * directorio de una sesión es el core, que lo tiene guardado y hasta sabe deducirlo (TEC-11).
   *
   * Un `cwd` explícito sigue admitiéndose y gana: abrir una terminal suelta en otra carpeta es un
   * caso legítimo, y lo que se pide a mano no lo pisa una deducción.
   */
  app.post('/api/terminal/open', async (request, reply) => {
    const body = (request.body ?? {}) as OpenTerminalRequest;
    const from = body.workspaceId ? services.workspaces.require(body.workspaceId) : null;
    const host = body.host || from?.ref.host;
    const provider = body.provider || from?.ref.provider;
    if (!host || !provider) throw new JarvisError('BAD_REQUEST', 'host and provider are required');

    let cwd = body.cwd ?? from?.cwd ?? null;
    // Una sesión cuyo directorio nadie guardó: se deduce del propio archivo de la conversación y
    // se confirma contra la máquina. Sólo cuando hace falta, y sin romper si no se consigue.
    if (!cwd && from) {
      const found = await services.cwdResolver.resolve(from.ref).catch(() => null);
      if (found) {
        services.workspaces.setCwd(from.id, found.cwd, found.source);
        cwd = found.cwd;
      }
    }

    const opened = await services.terminal.open({
      host,
      provider,
      sessionId: body.sessionId ?? from?.ref.sessionId ?? null,
      cwd,
      permissionProfile: body.permissionProfile ?? 'safe',
      user: identityOf(request),
    });
    return reply.send(opened);
  });

  app.get('/api/terminal/capture', async (request, reply) => {
    const query = (request.query ?? {}) as { host?: string; name?: string; lines?: string };
    if (!query.host || !query.name) throw new JarvisError('BAD_REQUEST', 'host and name are required');
    const text = await services.terminal.capture({
      host: query.host, name: query.name, ...(query.lines ? { lines: Number(query.lines) } : {}),
    });
    return reply.send({ text });
  });

  /** Destruir es explícito: salir de la terminal no mata nada. */
  app.post('/api/terminal/destroy', async (request, reply) => {
    const body = (request.body ?? {}) as { host?: string; name?: string };
    if (!body.host || !body.name) throw new JarvisError('BAD_REQUEST', 'host and name are required');
    await services.terminal.destroy({ host: body.host, name: body.name, user: identityOf(request) });
    return reply.send({ ok: true });
  });
}
