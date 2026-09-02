/**
 * Las piezas que se repiten en todas las pantallas.
 *
 * No es un design system: es el mínimo para que una tarjeta, una métrica o una pestaña se vean
 * y se comporten igual en los cinco sitios donde aparecen. Cada una lleva su comportamiento
 * accesible —roles, teclado, foco— porque es justo lo que se hace mal cuando se copia y pega.
 */
import type { JSX, ReactNode } from 'react';
import { useId } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ACTION_ICON, Glyph, type LucideIcon } from './icons.jsx';

export function Card({ title, icon, count, countTone, actions, children, className = '', footer }: {
  title?: string;
  icon?: LucideIcon;
  count?: number | string;
  countTone?: 'attention';
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  footer?: ReactNode;
}): JSX.Element {
  return (
    <section className={`card ${className}`}>
      {title ? (
        <header className="card-head">
          <h2>
            {icon ? <Glyph icon={icon} size={16} /> : null}
            {title}
          </h2>
          {count !== undefined ? (
            <span className={`pill ${countTone ?? ''}`}>{count}</span>
          ) : null}
          {actions ? <div className="after">{actions}</div> : null}
        </header>
      ) : null}
      {children}
      {footer ? <div className="card-foot">{footer}</div> : null}
    </section>
  );
}

/**
 * Una métrica con su variación.
 *
 * La variación se omite cuando no hay con qué comparar: inventar un «+100%» porque antes había
 * cero es peor que no decir nada.
 */
export function Stat({ value, label, delta, hint, children }: {
  value: ReactNode;
  label: string;
  delta?: number | null;
  hint?: string;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="stat">
      <div className="row nowrap" style={{ gap: 10, alignItems: 'baseline' }}>
        <span className="value">{value}</span>
        {delta === null || delta === undefined ? null : (
          <span className={`delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'}`}>
            {delta > 0 ? '▲' : delta < 0 ? '▼' : '■'} {Math.abs(delta)}%
          </span>
        )}
      </div>
      <div className="label">{label}</div>
      {hint ? <div className="tiny faint">{hint}</div> : null}
      {children}
    </div>
  );
}

export interface TabDefinition {
  id: string;
  label: string;
  icon?: LucideIcon;
  count?: number;
}

/**
 * Pestañas con teclado.
 *
 * Flechas para moverse, Home y End para los extremos: es lo que espera cualquiera que navegue
 * sin ratón, y es exactamente lo que se pierde al hacerlas con `div`s.
 */
export function Tabs({ tabs, active, onChange, label }: {
  tabs: TabDefinition[];
  active: string;
  onChange: (id: string) => void;
  label: string;
}): JSX.Element {
  const base = useId();
  const move = (delta: number): void => {
    const index = tabs.findIndex((tab) => tab.id === active);
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    if (next) onChange(next.id);
  };

  return (
    <div className="tabs" role="tablist" aria-label={label}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
        if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
        if (event.key === 'Home') { event.preventDefault(); onChange(tabs[0]?.id ?? active); }
        if (event.key === 'End') { event.preventDefault(); onChange(tabs.at(-1)?.id ?? active); }
      }}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`${base}-${tab.id}`}
          aria-selected={tab.id === active}
          tabIndex={tab.id === active ? 0 : -1}
          onClick={() => onChange(tab.id)}
        >
          {tab.icon ? <Glyph icon={tab.icon} /> : null}
          {tab.label}
          {tab.count !== undefined ? <span className="count">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  tone?: 'ok' | 'warn' | 'danger';
  hint?: string;
}

/**
 * Elección entre pocas opciones excluyentes.
 *
 * Se ven todas a la vez, que es la diferencia con un desplegable: aquí lo que se elige tiene
 * consecuencias —qué puede tocar el agente— y esconder las alternativas detrás de un clic hace
 * que nadie las lea.
 */
export function Segmented<T extends string>({ options, value, onChange, label }: {
  options: Array<SegmentOption<T>>;
  value: T;
  onChange: (value: T) => void;
  label: string;
}): JSX.Element {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          className={option.tone ?? ''}
          title={option.hint}
          onClick={() => onChange(option.value)}
        >
          {option.icon ? <Glyph icon={option.icon} /> : null}
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Confirmar algo que no se puede deshacer.
 *
 * No es un «¿seguro?»: dice qué se va a destruir, dónde, y qué se pierde. Un diálogo que no
 * nombra su objeto se acepta sin leer, y entonces no ha protegido nada.
 *
 * El botón peligroso no es el que tiene el foco al abrir: cerrar es lo barato, y equivocarse
 * pulsando Enter no puede costar una sesión.
 */
export function ConfirmDialog({ open, title, description, confirmLabel, onConfirm, onClose, pending }: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  pending?: boolean;
}): JSX.Element | null {
  if (!open) return null;
  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop" />
        <Dialog.Content className="modal confirm">
          <header className="modal-head">
            <span className="badge danger">
              <Glyph icon={ACTION_ICON.error} />
              No se puede deshacer
            </span>
          </header>
          <div>
            <Dialog.Title style={{ margin: '0 0 6px', fontSize: 16, color: 'var(--text-strong)' }}>
              {title}
            </Dialog.Title>
            <Dialog.Description asChild>
              <div className="small muted">{description}</div>
            </Dialog.Description>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Dialog.Close asChild>
              <button type="button" className="btn" autoFocus>Dejarlo como está</button>
            </Dialog.Close>
            <button type="button" className="btn danger" disabled={pending} onClick={onConfirm}>
              <Glyph icon={ACTION_ICON.stop} />
              {pending ? 'Cerrando…' : confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Una fila de datos: etiqueta a la izquierda, valor a la derecha, sin tabla de por medio. */
export function DataRow({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="spread" style={{ gap: 14, alignItems: 'flex-start' }}>
      <span className="small muted" style={{ flex: '0 0 auto' }}>{label}</span>
      <span className="small" style={{ textAlign: 'right', minWidth: 0 }}>{children}</span>
    </div>
  );
}

/** Duración legible: los milisegundos son para la máquina, no para quien mira la pantalla. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** Un número grande sin ruido: 1.240 en vez de 1240. */
export const formatCount = (value: number): string => value.toLocaleString('es-ES');
