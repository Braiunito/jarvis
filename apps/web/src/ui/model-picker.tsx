/**
 * Con qué modelo trabaja el agente.
 *
 * Es opcional y va en un desplegable, no a la vista como el permiso: el permiso decide qué puede
 * tocar el agente en una máquina de verdad, y el modelo sólo cómo de bien y cuánto cuesta. Sin
 * elegir, la CLI usa el que tenga configurado esa máquina, que es lo que pasaba siempre.
 *
 * Qué se ofrece lo dice el core (`/api/models`): los alias de la CLI, que no caducan, y lo que la
 * flota ya ha usado, que si se usó existe. Lo que no esté se escribe en «Otro…».
 */
import type { JSX } from 'react';
import { useState } from 'react';
import type { Provider } from '@jarvis/contracts';
import { useModels } from '../api/queries.js';
import { Glyph, STATUS_ICON } from './icons.jsx';
import { MODEL_ID, modelLabel } from './labels.js';

const OTHER = '\u0000otro';

const EXAMPLE: Record<Provider, string> = {
  claude: 'claude-opus-5-5',
  codex: 'gpt-5.6-sol',
  opencode: 'proveedor/modelo',
};

/** Vacío es «el de la máquina»; cualquier otra cosa tiene que parecer un nombre de modelo. */
export const isUsableModel = (value: string): boolean => value === '' || MODEL_ID.test(value);

export function ModelPicker({ provider, value, onChange, className = '' }: {
  provider: Provider;
  /** `''` es el modelo por defecto de la máquina. */
  value: string;
  onChange: (value: string) => void;
  className?: string;
}): JSX.Element {
  const models = useModels();
  const [typing, setTyping] = useState(false);

  const options = (models.data?.models ?? []).filter((option) => option.provider === provider);
  const aliases = options.filter((option) => option.kind === 'alias');
  const used = options.filter((option) => option.kind === 'seen');
  // Lo elegido que el catálogo no trae —escrito a mano antes, o el catálogo aún no ha llegado—
  // se sigue viendo como una opción más, en vez de saltar a «Otro…».
  const unlisted = !typing && value !== '' && !options.some((option) => option.id === value) ? value : null;
  const invalid = !isUsableModel(value);

  return (
    <span className={`model-picker ${className}`}>
      <Glyph icon={STATUS_ICON.model} size={14} />
      <select
        className="select"
        aria-label="Modelo"
        value={typing ? OTHER : value}
        title={value ? value : 'El que tenga configurado la máquina'}
        onChange={(event) => {
          const next = event.target.value;
          if (next === OTHER) {
            setTyping(true);
            onChange('');
            return;
          }
          setTyping(false);
          onChange(next);
        }}
      >
        <option value="">Modelo por defecto</option>
        {unlisted ? <option value={unlisted}>{modelLabel(unlisted)}</option> : null}
        {aliases.length ? (
          <optgroup label="El más reciente de cada familia">
            {aliases.map((option) => <option key={option.id} value={option.id}>{modelLabel(option.id)}</option>)}
          </optgroup>
        ) : null}
        {used.length ? (
          <optgroup label="Ya usados en la flota">
            {used.map((option) => <option key={option.id} value={option.id}>{modelLabel(option.id)}</option>)}
          </optgroup>
        ) : null}
        <option value={OTHER}>Otro…</option>
      </select>
      {typing ? (
        <input
          className="input mono"
          aria-label="Nombre del modelo"
          aria-invalid={invalid || undefined}
          placeholder={EXAMPLE[provider]}
          value={value}
          autoFocus
          spellCheck={false}
          autoCapitalize="off"
          onChange={(event) => onChange(event.target.value.trim())}
        />
      ) : null}
    </span>
  );
}
