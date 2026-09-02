/**
 * La cuenta del agente y lo que le queda de cuota.
 *
 * Se enseña el **restante**, no lo gastado: es lo que se mira antes de mandar trabajo, y obligar a
 * restar de cabeza justo ahí es pedir el error. Cada número va con su ventana («sesión 55%»),
 * porque un porcentaje suelto no dice de qué.
 *
 * La regla que trae el stack anterior, ganada a base de uso: esto es auxiliar. Si la cuenta no se
 * puede leer, se dice en pequeño y con dónde mirar, pero nunca bloquea ni se queda en un hueco
 * silencioso que parece un fallo de la aplicación.
 */
import type { JSX } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { UsageSnapshot } from '@jarvis/contracts';
import { Glyph, STATUS_ICON } from './icons.js';
import { USAGE_LOW_PERCENT, usageWindowName } from './labels.js';
import { relativeTime } from './bits.js';

/** El nombre corto de la cuenta: el buzón entero no cabe y tampoco hace falta. */
const shortAccount = (usage: UsageSnapshot): string | null =>
  usage.account?.email?.split('@')[0] ?? usage.account?.plan ?? null;

function detail(usage: UsageSnapshot): string {
  const windows = usage.limits.map((entry) => {
    const resets = entry.resetDescription
      ?? (entry.resetsAt ? `se reinicia ${new Date(entry.resetsAt).toLocaleString()}` : null);
    return `${usageWindowName(entry.label)}: queda ${entry.remainingPercent}%${resets ? ` (${resets})` : ''}`;
  });
  return [
    usage.account?.email,
    usage.account?.plan ? `plan ${usage.account.plan}` : null,
    `cuenta en ${usage.executionHost}`,
    ...windows,
    usage.stale ? `último dato conocido, de ${relativeTime(usage.fetchedAt)}` : null,
    usage.refreshError,
  ].filter(Boolean).join(' · ');
}

export function UsageBadge({ query }: { query: UseQueryResult<UsageSnapshot> }): JSX.Element | null {
  // Sin provider que publique cuota la consulta ni se lanza: no hay nada que decir.
  if (query.fetchStatus === 'idle' && !query.data && !query.error) return null;

  if (query.error) {
    return (
      <span className="badge warn" title={`No se pudo leer la cuenta del agente: ${(query.error as Error).message}`}>
        <Glyph icon={STATUS_ICON.gauge} />
        cuenta sin datos
      </span>
    );
  }

  const usage = query.data;
  if (!usage) {
    return (
      <span className="badge neutral" title="Consultando la cuenta del agente…">
        <Glyph icon={STATUS_ICON.gauge} />
        cuenta…
      </span>
    );
  }

  const name = shortAccount(usage);
  const low = usage.limits.some((entry) => entry.remainingPercent <= USAGE_LOW_PERCENT);
  return (
    <span className={`badge ${low ? 'danger' : usage.stale ? 'warn' : 'neutral'}`} title={detail(usage)}>
      <Glyph icon={STATUS_ICON.gauge} />
      {name ?? 'cuenta'}
      {usage.limits.map((entry) => (
        <span key={entry.label}>
          {usageWindowName(entry.label)} {entry.remainingPercent}%
        </span>
      ))}
      {/* Un sondeo que trajo la cuenta pero no las cuotas se reintenta solo; mientras, se dice. */}
      {usage.limits.length === 0 ? <span>sin cuota leída</span> : null}
      {usage.stale ? <span>· {relativeTime(usage.fetchedAt)}</span> : null}
    </span>
  );
}

/**
 * Cuántos mensajes tiene la sesión, y cuántos se están viendo.
 *
 * Contar los de la página era decir «40 mensajes» de una sesión de trescientos. Lo que se enseña
 * es el total que conoce el índice; si sólo se ha traído un trozo, se dice que es un trozo.
 */
export function messageBadgeText(
  { shown, total }: { shown: number; total: number | null },
): { text: string; title: string } {
  if (total === null) {
    return { text: `${shown} mensajes`, title: 'Mensajes traídos de la sesión.' };
  }
  if (total > shown) {
    return {
      text: `${total} mensajes`,
      title: `La sesión tiene ${total} mensajes. Aquí se ven los ${shown} últimos.`,
    };
  }
  return { text: `${total} mensajes`, title: 'La conversación completa de esta sesión.' };
}
