/**
 * El Assistant en la interfaz.
 *
 * Un plan no es una conversación: es una lista de pasos con estado. Y una aprobación no es un
 * modal con «¿seguro?», sino una tarjeta que dice qué acción, sobre qué máquina, con qué permiso
 * y hasta cuándo vale.
 */
import type { JSX } from 'react';
import { useState } from 'react';
import type { Approval, Plan, PlanStep } from '@jarvis/contracts';
import { useCancelPlan, useCreatePlan, usePlan, usePlans, useResolveApproval } from '../api/queries.js';
import { ErrorNote, relativeTime } from './bits.jsx';

const PLAN_LABEL: Record<string, string> = {
  ready: 'listo',
  running: 'pensando',
  waiting_run: 'esperando al agente',
  waiting_approval: 'esperando tu permiso',
  waiting_input: 'esperando tu respuesta',
  completed: 'terminado',
  failed: 'falló',
  cancelled: 'cancelado',
};

const PLAN_TONE: Record<string, string> = {
  ready: 'neutral',
  running: 'running',
  waiting_run: 'running',
  waiting_approval: 'warn',
  waiting_input: 'warn',
  completed: 'ok',
  failed: 'danger',
  cancelled: 'neutral',
};

function PlanBadge({ status }: { status: string }): JSX.Element {
  return (
    <span className={`badge ${PLAN_TONE[status] ?? 'neutral'}`}>
      <span className="dot" aria-hidden="true" />
      {PLAN_LABEL[status] ?? status}
    </span>
  );
}

function ApprovalCard({ approval, onDecide, pending }: {
  approval: Approval;
  onDecide: (decision: 'approved' | 'rejected') => void;
  pending: boolean;
}): JSX.Element {
  const target = approval.target as { host?: string; permissionProfile?: string; prompt?: string };
  const expiresIn = Math.max(0, Math.round((Date.parse(approval.expiresAt) - Date.now()) / 60_000));
  return (
    <div className="card" style={{ borderColor: 'var(--warn)' }}>
      <h3 style={{ color: 'var(--warn)' }}>Necesita tu permiso</h3>
      <p style={{ margin: '0 0 8px' }}>{approval.summary}</p>
      <div className="row small" style={{ marginBottom: 8 }}>
        <span className="badge neutral">{approval.actionType}</span>
        {target.host ? <span className="badge neutral mono">{target.host}</span> : null}
        <span className={`badge ${target.permissionProfile === 'auto' ? 'warn' : 'danger'}`}>
          permiso: {target.permissionProfile}
        </span>
        <span className="muted">caduca en {expiresIn} min</span>
      </div>
      {target.prompt ? (
        <pre className="small mono" style={{ whiteSpace: 'pre-wrap', margin: '0 0 10px', color: 'var(--text-muted)' }}>
          {target.prompt.slice(0, 400)}
        </pre>
      ) : null}
      <div className="row">
        <button type="button" className="btn primary" disabled={pending} onClick={() => onDecide('approved')}>
          Autorizar
        </button>
        <button type="button" className="btn danger" disabled={pending} onClick={() => onDecide('rejected')}>
          Rechazar
        </button>
      </div>
    </div>
  );
}

function StepRow({ step }: { step: PlanStep }): JSX.Element {
  const output = step.output as { summary?: string; status?: string } | null;
  return (
    <div className="list-item" style={{ cursor: 'default' }}>
      <span className="row">
        <PlanBadge status={step.status} />
        <span className="small muted">#{step.ordinal + 1}</span>
        <span className="title">{step.title}</span>
        <span className="badge neutral">{step.kind}</span>
      </span>
      {output?.summary ? <span className="small muted">{output.summary.slice(0, 200)}</span> : null}
      {step.errorCode ? <span className="small" style={{ color: 'var(--danger)' }}>{step.errorCode}</span> : null}
    </div>
  );
}

export function AssistantPanel({ workspaceId }: { workspaceId: string }): JSX.Element {
  const plans = usePlans(workspaceId);
  const [objective, setObjective] = useState('');
  const [openPlanId, setOpenPlanId] = useState<string | null>(null);
  const create = useCreatePlan(workspaceId);
  const cancel = useCancelPlan();
  const resolve = useResolveApproval();

  const active = (plans.data?.plans ?? []).find((plan) =>
    !['completed', 'failed', 'cancelled'].includes(plan.status));
  const currentId = openPlanId ?? active?.id ?? plans.data?.plans[0]?.id ?? null;
  const detail = usePlan(currentId);

  async function submit(): Promise<void> {
    if (!objective.trim()) return;
    const created = await create.mutateAsync(objective);
    setObjective('');
    setOpenPlanId(created.plan.id);
  }

  if (plans.data && !plans.data.assistantAvailable) {
    return (
      <div className="card">
        <h2>Assistant</h2>
        <p className="small muted" style={{ margin: 0 }}>
          No hay modelo configurado en el core, así que el Assistant está apagado. El trabajo
          directo funciona igual.
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Assistant</h2>
      <p className="small muted" style={{ marginTop: 0 }}>
        Describe un objetivo y el asistente lo parte en pasos. Cada paso es trabajo real en la
        máquina; lo que tenga efectos te lo pedirá antes.
      </p>

      <div className="stack" style={{ marginBottom: 12 }}>
        <textarea
          className="textarea"
          style={{ minHeight: 64 }}
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
          placeholder="Averigua por qué el pool se queda sin conexiones y propón el arreglo"
          aria-label="Objetivo"
        />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn primary" disabled={create.isPending || !objective.trim()}
            onClick={() => void submit()}>
            {create.isPending ? 'Preparando…' : 'Delegar objetivo'}
          </button>
        </div>
        <ErrorNote error={create.error} />
      </div>

      {(plans.data?.approvals ?? []).map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          pending={resolve.isPending}
          onDecide={(decision) => resolve.mutate({ id: approval.id, decision })}
        />
      ))}
      <ErrorNote error={resolve.error} />

      {detail.data ? (
        <div className="stack">
          <div className="row">
            <PlanBadge status={detail.data.plan.status} />
            <span className="small muted">{relativeTime(detail.data.plan.updatedAt)}</span>
            {!['completed', 'failed', 'cancelled'].includes(detail.data.plan.status) ? (
              <button type="button" className="btn small danger"
                onClick={() => cancel.mutate(detail.data.plan.id)}>Parar el plan</button>
            ) : null}
          </div>
          <p className="small" style={{ margin: 0 }}>{detail.data.plan.objective}</p>
          <div className="list">
            {detail.data.steps.map((step) => <StepRow key={step.id} step={step} />)}
            {detail.data.steps.length === 0 ? (
              <p className="small muted" style={{ margin: 0 }}>Todavía no hay pasos.</p>
            ) : null}
          </div>
          {detail.data.plan.summary ? (
            <div className="card" style={{ background: 'var(--bg-sunken)' }}>
              <h3>Resultado</h3>
              <p className="small" style={{ margin: 0 }}>{detail.data.plan.summary}</p>
            </div>
          ) : null}
        </div>
      ) : null}

      {(plans.data?.plans.length ?? 0) > 1 ? (
        <details style={{ marginTop: 10 }}>
          <summary className="small muted">Otros objetivos de este workspace</summary>
          <div className="list" style={{ marginTop: 8 }}>
            {(plans.data?.plans ?? []).map((plan: Plan) => (
              <button key={plan.id} type="button" className="list-item"
                aria-current={plan.id === currentId} onClick={() => setOpenPlanId(plan.id)}>
                <span className="row">
                  <PlanBadge status={plan.status} />
                  <span className="small">{plan.objective.slice(0, 60)}</span>
                </span>
                <span className="small muted">{relativeTime(plan.createdAt)}</span>
              </button>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
