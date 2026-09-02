import type { FastifyInstance } from 'fastify';
import type { CoreServices } from '../services.js';

export function registerFleetRoutes(app: FastifyInstance, services: CoreServices): void {
  /**
   * La flota.
   *
   * Por defecto **no** sondea: devuelve lo último que se sabe de cada host. Sondear cuesta una
   * conexión SSH por máquina, y un host caído se lleva por delante el tiempo de respuesta de una
   * pantalla que sólo quería pintar un selector. Quien necesita el estado de verdad —Salud— lo
   * pide con `probe=1`.
   */
  app.get('/api/hosts', async (request, reply) => {
    const query = (request.query ?? {}) as { probe?: string; force?: string };
    const probe = query.probe === '1' || query.force === '1';
    const hosts = probe
      ? await services.fleet.list({ force: query.force === '1' })
      : services.fleet.known();
    return reply.send({ hosts, bastionHost: services.fleet.bastionHost, probed: probe });
  });
}
