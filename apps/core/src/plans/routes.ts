import type { FastifyInstance } from 'fastify';
import { JarvisError } from '@jarvis/contracts';
import { identityOf } from '../app.js';
import type { CoreServices } from '../services.js';

export function registerPlanRoutes(app: FastifyInstance, services: CoreServices): void {
  /** Crear un plan devuelve enseguida: el trabajo lo lleva el despertador, no esta petición. */
  app.post('/api/plans', async (request, reply) => {
    const body = (request.body ?? {}) as { workspaceId?: string; objective?: string };
    if (!body.workspaceId || !body.objective) {
      throw new JarvisError('BAD_REQUEST', 'workspaceId y objective son obligatorios');
    }
    const plan = services.plans.create({
      workspaceId: body.workspaceId, objective: body.objective, user: identityOf(request),
    });
    // Un primer empujón para que el usuario vea algo sin esperar al intervalo.
    void services.plans.advance(plan.id, identityOf(request)).catch(() => undefined);
    return reply.code(202).send({ plan });
  });

  app.get('/api/plans', async (request, reply) => {
    const workspaceId = (request.query as { workspaceId?: string } | undefined)?.workspaceId;
    return reply.send({
      plans: workspaceId ? services.plans.listByWorkspace(workspaceId) : services.plans.listActive(),
      approvals: services.plans.pendingApprovals(),
      assistantAvailable: services.plans.hasModel,
    });
  });

  app.get('/api/plans/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const plan = services.plans.require(id);
    const steps = services.plans.steps(id);
    const approvals = steps
      .map((step) => (step.approvalId ? services.plans.approval(step.approvalId) : null))
      .filter((approval) => approval !== null);
    return reply.send({ plan, steps, approvals });
  });

  app.post('/api/plans/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ plan: services.plans.cancel(id, identityOf(request)) });
  });

  app.post('/api/plans/:id/input', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { answer?: string };
    if (!body.answer) throw new JarvisError('BAD_REQUEST', 'answer es obligatorio');
    const plan = services.plans.provideInput(id, body.answer, identityOf(request));
    void services.plans.advance(id, identityOf(request)).catch(() => undefined);
    return reply.send({ plan });
  });

  /**
   * Aprobar o rechazar. Es de un solo uso y caduca: lo que se autoriza es exactamente la acción
   * que describe el digest, no «lo que el asistente quiera hacer luego».
   */
  app.post('/api/approvals/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { decision?: 'approved' | 'rejected' };
    if (body.decision !== 'approved' && body.decision !== 'rejected') {
      throw new JarvisError('BAD_REQUEST', 'decision debe ser approved o rejected');
    }
    const approval = services.plans.resolveApproval(id, body.decision, identityOf(request));
    if (approval.planId) {
      void services.plans.advance(approval.planId, identityOf(request)).catch(() => undefined);
    }
    return reply.send({ approval });
  });
}
