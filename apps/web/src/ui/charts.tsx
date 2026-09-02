/**
 * Los gráficos del panel, en SVG.
 *
 * Son tres formas pequeñas —un histograma de actividad, un anillo de reparto y un medidor— y las
 * tres caben en este fichero. Traer una librería de gráficos costaría unos 70 KiB comprimidos,
 * un canvas y una capa de configuración de tema, a cambio de funciones que aquí no se usan:
 * zoom, series largas, ejes calculados. Cuando el producto pida eso —y el backlog dirá cuándo—,
 * entra la librería; hasta entonces, esto usa los mismos tokens de color que el resto y se
 * imprime igual en claro y en oscuro.
 *
 * Accesibilidad: cada gráfico va acompañado del número que representa. La forma añade contexto,
 * nunca es la única fuente del dato.
 */
import type { JSX } from 'react';

export interface SparkPoint {
  at: string;
  value: number;
  /** Parte del valor que salió mal: se pinta encima en rojo. */
  bad?: number;
}

/**
 * Histograma de actividad.
 *
 * Barras y no línea a propósito: lo que se mira aquí es «cuándo hubo trabajo», no una tendencia
 * continua, y una línea entre dos huecos sugiere actividad que no existió.
 */
export function Sparkbars({ points, height = 44, label }: {
  points: SparkPoint[];
  height?: number;
  label: string;
}): JSX.Element {
  const max = Math.max(1, ...points.map((point) => point.value));
  const gap = 2;
  const width = 100;
  const barWidth = points.length ? (width - gap * (points.length - 1)) / points.length : width;

  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img"
      aria-label={label}>
      {points.map((point, index) => {
        const x = index * (barWidth + gap);
        const total = (point.value / max) * (height - 4);
        const bad = point.bad ? (point.bad / max) * (height - 4) : 0;
        const good = Math.max(0, total - bad);
        return (
          <g key={point.at}>
            {/* El carril vacío da referencia de escala cuando casi no hay actividad. */}
            <rect x={x} y={height - 3} width={barWidth} height={2} rx={1} fill="var(--border)" />
            {good > 0 ? (
              <rect x={x} y={height - good - bad} width={barWidth} height={good} rx={1.5}
                fill="var(--ok)" opacity={0.85} />
            ) : null}
            {bad > 0 ? (
              <rect x={x} y={height - bad} width={barWidth} height={bad} rx={1.5} fill="var(--danger)" />
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

export interface DonutSlice {
  key: string;
  value: number;
  color: string;
  label: string;
}

/**
 * Anillo de reparto.
 *
 * Se dibuja con un solo círculo y `stroke-dasharray`, que es lo que evita calcular arcos a mano
 * y hace que el hueco central quede libre para el total, que es el dato que de verdad se lee.
 */
export function Donut({ slices, total, caption, size = 132 }: {
  slices: DonutSlice[];
  total: number;
  caption: string;
  size?: number;
}): JSX.Element {
  const stroke = 16;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const sum = slices.reduce((acc, slice) => acc + slice.value, 0) || 1;

  let offset = 0;
  return (
    <div style={{ position: 'relative', width: size, height: size, flex: '0 0 auto' }}>
      <svg className="donut" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
        aria-label={`${caption}: ${slices.map((slice) => `${slice.label} ${slice.value}`).join(', ')}`}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--bg-sunken)" strokeWidth={stroke} />
        {slices.map((slice) => {
          const length = (slice.value / sum) * circumference;
          const dash = `${Math.max(0, length - 2)} ${circumference - Math.max(0, length - 2)}`;
          const element = (
            <circle
              key={slice.key}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={slice.color}
              strokeWidth={stroke}
              strokeDasharray={dash}
              strokeDashoffset={-offset}
              strokeLinecap="round"
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          );
          offset += length;
          return element;
        })}
      </svg>
      <div style={{
        position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center',
      }}>
        <div>
          <div style={{ fontSize: 24, fontWeight: 680, letterSpacing: '-0.03em', color: 'var(--text-strong)' }}>
            {total}
          </div>
          <div className="tiny muted">{caption}</div>
        </div>
      </div>
    </div>
  );
}

/** Una barra de proporción: cuántos de cuántos, sin hacer contar al lector. */
export function Meter({ value, max, tone = 'accent' }: {
  value: number;
  max: number;
  tone?: 'accent' | 'ok' | 'warn' | 'danger';
}): JSX.Element {
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className={`meter ${tone === 'accent' ? '' : tone}`} role="img"
      aria-label={`${value} de ${max}`}>
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}

/** Colores de las series, con los mismos tokens que el resto de la interfaz. */
export const SERIES_COLORS: Record<string, string> = {
  claude: 'var(--ok)',
  codex: 'var(--accent)',
  opencode: 'var(--running)',
  otros: 'var(--text-faint)',
};
