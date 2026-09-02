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
import {
  useAnswerPlan, useCancelPlan, useCreatePlan, usePlan, usePlans, useResolveApproval,
} from '../api/queries.js';
import { ErrorNote, Link, relativeTime } from './bits.jsx';

import { PERMISSION, PLAN_STATUS, PLAN_STEP_KIND, RUN_STATUS } from './labels.js';
import {
  ACTION_ICON, Glyph, NAV_ICON, PERMISSION_ICON, PLAN_STATUS_ICON, RUN_STATUS_ICON, STATUS_ICON,
} from './icons.jsx';
import { Card } from './primitives.jsx';

/** Lo que el plan dejó preparado para que lo abras tú. El modelo no abre terminales. */
interface TerminalOffer {
  host: string;
  provider: string;
  sessionId: string;
  cwd: string | null;
  permissionProfile: string;
  reason: string;
}

/** Un trabajo citado por la síntesis: el enlace a la evidencia, no su copia. */
interface EvidenceRef {
  runId: string;
  title: string;
  status: string;
  summary: string | null;
}

const offerOf = (value: unknown): TerminalOffer | null =>
  (value as { terminalOffer?: TerminalOffer } | null)?.terminalOffer ?? null;

/**
 * La oferta de terminal.
 *
 * El plan ya sabe en qué máquina y en qué sesión hay que mirar, así que aquí no se vuelve a
 * preguntar: el enlace lleva la terminal ya elegida. Sigue abriéndola una persona.
 */
function TerminalOfferButton({ offer, workspaceId }: {
  offer: TerminalOffer;
  workspaceId: string;
}): JSX.Element {
  const href = `/terminal?host=${encodeURIComponent(offer.host)}`
    + `&provider=${offer.provider}`
    + `&sessionId=${encodeURIComponent(offer.sessionId)}`
    + `&from=${encodeURIComponent(workspaceId)}`;
  return (
    <div className="note">
      <Glyph icon={NAV_ICON.terminal} size={16} />
      <span>
        <span className="small">{offer.reason}</span>
        <span className="row tight" style={{ marginTop: 8 }}>
          <Link to={href} className="btn small">
            <Glyph icon={NAV_ICON.terminal} />
            Abrir terminal en {offer.host}
          </Link>
          <span className="tiny faint mono">{offer.cwd ?? offer.sessionId}</span>
        </span>
      </span>
    </div>
  );
}

function PlanBadge({ status }: { status: string }): JSX.Element {
  const label = PLAN_STATUS[status];
  const icon = PLAN_STATUS_ICON[status] ?? PLAN_STATUS_ICON['ready'];
  const spinning = status === 'running' || status === 'waiting_run';
  return (
    <span className={`badge ${label?.tone ?? 'neutral'}`} title={label?.help}>
      {icon ? <Glyph icon={icon} className={spinning ? 'spin' : undefined} /> : null}
      {label?.name ?? status}
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
    <div className="card warn-card">
      <h3 className="row" style={{ color: 'var(--warn)', gap: 6, margin: '0 0 6px' }}>
        <Glyph icon={PLAN_STATUS_ICON['waiting_approval'] as never} size={16} />
        Necesita tu permiso
      </h3>
      <p style={{ margin: '0 0 8px' }}>{approval.summary}</p>
      <div className="row small" style={{ marginBottom: 8 }}>
        <span className="badge neutral">{approval.actionType}</span>
        {target.host ? <span className="badge neutral mono">{target.host}</span> : null}
        <span className={`badge ${PERMISSION[target.permissionProfile as 'auto' | 'yolo']?.tone ?? 'warn'}`}>
          <Glyph icon={PERMISSION_ICON[target.permissionProfile as 'auto' | 'yolo'] ?? PERMISSION_ICON.auto} />
          {PERMISSION[target.permissionProfile as 'auto' | 'yolo']?.name ?? target.permissionProfile}
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
          <Glyph icon={ACTION_ICON.approve} />
          Autorizar
        </button>
        <button type="button" className="btn danger" disabled={pending} onClick={() => onDecide('rejected')}>
          <Glyph icon={ACTION_ICON.reject} />
          Rechazar
        </button>
      </div>
    </div>
  );
}

/**
 * Un paso del plan.
 *
 * Cuando el paso lanzó trabajo real, se enseña el enlace: sin él, el plan cuenta una historia que
 * no se puede comprobar, y la evidencia de lo que pasó en la máquina está justo al otro lado.
 */
function StepRow({ step }: { step: PlanStep }): JSX.Element {
  const output = step.output as { summary?: string; status?: string; answer?: string } | null;
  return (
    <div className="list-item" style={{ cursor: 'default' }}>
      <span className="row tight nowrap" style={{ minWidth: 0 }}>
        <PlanBadge status={step.status} />
        <span className="cell-main">
          <span className="row tight nowrap">
            <span className="tiny faint">#{step.ordinal + 1}</span>
            <span className="title truncate">{step.title}</span>
          </span>
          {output?.summary ? (
            <span className="tiny faint truncate">{output.summary.slice(0, 160)}</span>
          ) : null}
          {output?.answer ? (
            <span className="tiny faint truncate">respondiste: {output.answer.slice(0, 120)}</span>
          ) : null}
        </span>
      </span>
      <span className="row tight nowrap">
        {step.errorCode ? <span className="badge danger">{step.errorCode}</span> : null}
        <span className="badge neutral">{PLAN_STEP_KIND[step.kind] ?? step.kind}</span>
        {step.runId ? (
          <Link to={`/runs/${step.runId}`} className="btn small" title="Ver el trabajo que lanzó este paso">
            <Glyph icon={NAV_ICON.runs} size={13} />
            Trabajo
          </Link>
        ) : null}
      </span>
    </div>
  );
}

/**
 * Lo que el plan pregunta.
 *
 * Es la otra cara de la aprobación: allí se autoriza una acción, aquí se aporta un dato que
 * falta. Sin este hueco, un plan que pregunta se queda parado y no se sabe por qué.
 */
function QuestionCard({ step, planId }: { step: PlanStep; planId: string }): JSX.Element {
  const [answer, setAnswer] = useState('');
  const respond = useAnswerPlan();
  const question = (step.input as { question?: string } | null)?.question ?? step.title;
  return (
    <div className="card warn-card">
      <h3 className="row" style={{ color: 'var(--warn)', gap: 6, margin: '0 0 6px' }}>
        <Glyph icon={PLAN_STATUS_ICON['waiting_input'] as never} size={16} />
        Te pregunta algo
      </h3>
      <p style={{ margin: '0 0 8px' }}>{question}</p>
      <form className="stack" onSubmit={(event) => {
        event.preventDefault();
        if (!answer.trim()) return;
        respond.mutate({ planId, answer: answer.trim() }, { onSuccess: () => setAnswer('') });
      }}>
        <input className="input" value={answer} aria-label="Tu respuesta"
          placeholder="Escribe la respuesta y el plan sigue"
          onChange={(event) => setAnswer(event.target.value)} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="submit" className="btn primary" disabled={respond.isPending || !answer.trim()}>
            <Glyph icon={ACTION_ICON.send} />
            {respond.isPending ? 'Enviando…' : 'Responder'}
          </button>
        </div>
        <ErrorNote error={respond.error} />
      </form>
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
  const pendingCount = (plans.data?.approvals ?? []).length;

  async function submit(): Promise<void> {
    if (!objective.trim()) return;
    const created = await create.mutateAsync(objective);
    setObjective('');
    setOpenPlanId(created.plan.id);
  }

  if (plans.data && !plans.data.assistantAvailable) {
    return (
      <Card title="Assistant" icon={ACTION_ICON.delegate}>
        <p className="small muted" style={{ margin: 0 }}>
          No hay modelo configurado en el core, así que el Assistant está apagado. El trabajo
          directo funciona igual.
        </p>
      </Card>
    );
  }

  const question = (detail.data?.steps ?? []).find(
    (step) => step.kind === 'input' && step.status === 'waiting_input');

  const synthesis = (detail.data?.steps ?? []).find((step) => step.kind === 'synthesis');
  const evidence = ((synthesis?.output as { evidence?: EvidenceRef[] } | null)?.evidence) ?? [];
  // La última oferta gana: si el plan volvió a mirar, el sitio al que mandaba antes ya no es el
  // sitio donde está lo interesante.
  const offer = (detail.data?.steps ?? [])
    .map((step) => offerOf(step.output) ?? offerOf(step.input))
    .filter((value): value is TerminalOffer => value !== null)
    .at(-1) ?? null;

  return (
    <Card title="Assistant" icon={ACTION_ICON.delegate}
      {...(pendingCount ? { count: pendingCount, countTone: 'attention' as const } : {})}>
      <p className="small muted" style={{ margin: '0 0 10px' }}>
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
            <Glyph icon={ACTION_ICON.delegate} />
            {create.isPending ? 'Preparando…' : 'Delegar objetivo'}
          </button>
        </div>
        <ErrorNote error={create.error} />
      </div>

      {offer ? <TerminalOfferButton offer={offer} workspaceId={workspaceId} /> : null}

      {question && detail.data ? (
        <QuestionCard step={question} planId={detail.data.plan.id} />
      ) : null}

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
                onClick={() => cancel.mutate(detail.data.plan.id)}>
                <Glyph icon={ACTION_ICON.stop} />
                Parar el plan
              </button>
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
              <h3 style={{ margin: '0 0 6px', fontSize: 13 }}>Resultado</h3>
              <p className="small" style={{ margin: 0 }}>{detail.data.plan.summary}</p>
              {evidence.length ? (
                <>
                  <p className="tiny faint" style={{ margin: '10px 0 6px' }}>
                    Lo que sostiene esta conclusión:
                  </p>
                  <div className="list">
                    {evidence.map((item) => (
                      <Link key={item.runId} to={`/runs/${item.runId}`} className="list-item">
                        <span className="row tight nowrap" style={{ minWidth: 0 }}>
                          <Glyph icon={RUN_STATUS_ICON[item.status as keyof typeof RUN_STATUS_ICON]
                            ?? STATUS_ICON.activity} size={13} />
                          <span className="cell-main">
                            <span className="title truncate">{item.title}</span>
                            {item.summary ? (
                              <span className="tiny faint truncate">{item.summary}</span>
                            ) : null}
                          </span>
                        </span>
                        <span className="tiny faint nowrap">
                          {RUN_STATUS[item.status as keyof typeof RUN_STATUS]?.name ?? item.status}
                        </span>
                      </Link>
                    ))}
                  </div>
                </>
              ) : null}
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
    </Card>
  );
}
