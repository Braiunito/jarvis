/**
 * Los iconos del producto, en un solo sitio.
 *
 * Va en paralelo a `labels.ts`: allí se decide cómo se llama cada cosa, aquí con qué forma se
 * reconoce. Tenerlo junto es lo que evita que «trabajando» sea un reloj en una pantalla y una
 * flecha en otra.
 *
 * Dos reglas:
 *   · un icono nunca va solo si no lleva su propia etiqueta accesible: acompaña al texto, no lo
 *     sustituye;
 *   · un estado se distingue por **forma**, no sólo por color. Quien no separa el verde del rojo
 *     tiene que poder operar esto igual, y por eso el punto de los distintivos pasó a ser un
 *     icono con silueta propia.
 *
 * Se importa icono a icono a propósito (ADR-008): el paquete trae miles y sólo deben viajar los
 * que se usan.
 */
import type { JSX } from 'react';
import {
  Ban, Bot, Cable, Check, CircleAlert, CircleCheck, CircleDot, CircleHelp, CircleSlash, CircleStop,
  CircleX, Clock, Copy, CornerDownLeft, Download, Eye, FileText, FolderOpen, HeartPulse, History,
  Hourglass, House, Inbox, ListChecks, LoaderCircle, LogOut, Paperclip, Pencil, RotateCcw, Search,
  SendHorizontal, Server, ShieldOff, SquareTerminal, Timer, TimerOff, TriangleAlert, Wrench, X,
  Zap, type LucideIcon,
} from 'lucide-react';
import type { PermissionProfile, RunStatus } from '@jarvis/contracts';

export type { LucideIcon };

/**
 * Un icono decorativo: acompaña a un texto que ya dice lo que hay que saber, así que se esconde
 * de los lectores de pantalla en vez de repetirlo.
 */
export function Glyph({ icon: Icon, size = 15, className }: {
  icon: LucideIcon;
  size?: number;
  className?: string;
}): JSX.Element {
  return (
    <Icon
      size={size}
      strokeWidth={2}
      aria-hidden="true"
      focusable={false}
      className={className}
      style={{ flex: '0 0 auto' }}
    />
  );
}

/** Estado de un trabajo. La forma distingue lo que el color sólo insinúa. */
export const RUN_STATUS_ICON: Record<RunStatus, LucideIcon> = {
  queued: Clock,
  preparing: Wrench,
  running: LoaderCircle,
  waiting: Hourglass,
  cancelling: CircleSlash,
  completed: CircleCheck,
  failed: CircleX,
  cancelled: Ban,
  timed_out: TimerOff,
};

/** Estado de un plan del Assistant. */
export const PLAN_STATUS_ICON: Record<string, LucideIcon> = {
  ready: CircleDot,
  running: LoaderCircle,
  waiting_run: LoaderCircle,
  waiting_approval: CircleAlert,
  waiting_input: CircleHelp,
  completed: CircleCheck,
  failed: CircleX,
  cancelled: Ban,
};

/** Qué puede hacer el agente: mirar, escribir, o cualquier cosa. */
export const PERMISSION_ICON: Record<PermissionProfile, LucideIcon> = {
  safe: Eye,
  auto: Pencil,
  yolo: Zap,
};

/** Salud por salto. */
export const HEALTH_ICON: Record<string, LucideIcon> = {
  ok: CircleCheck,
  stale: Clock,
  degraded: TriangleAlert,
  failed: CircleX,
  unknown: CircleHelp,
};

/** De dónde salió lo que se está leyendo. */
export const PROVENANCE_ICON: Record<string, LucideIcon> = {
  'remote-transcript': Server,
  'jarvis-run': Bot,
  'litechat-import': Download,
  system: FileText,
};

/** Las secciones. En el móvil son lo único que se ve antes que el texto. */
export const NAV_ICON = {
  home: House,
  sessions: Search,
  runs: ListChecks,
  terminal: SquareTerminal,
  health: HeartPulse,
} as const;

/** Acciones. Siempre junto a su palabra: un botón que sólo es un dibujo se adivina, no se lee. */
export const ACTION_ICON = {
  send: SendHorizontal,
  stop: CircleStop,
  retry: RotateCcw,
  copy: Copy,
  connect: Cable,
  approve: Check,
  reject: X,
  logout: LogOut,
  delegate: Bot,
  attach: Paperclip,
  open: FolderOpen,
  go: CornerDownLeft,
  session: History,
  timer: Timer,
  empty: Inbox,
  error: TriangleAlert,
  insecure: ShieldOff,
} as const;
