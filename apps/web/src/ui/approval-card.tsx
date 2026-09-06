/**
 * Lo que espera tu firma, en un solo sitio.
 *
 * Había dos tarjetas distintas para lo mismo —una en el hilo del asistente y otra en el panel de
 * planes del workspace— y la diferencia no era cosmética: la del panel **recortaba el prompt a 400
 * caracteres** mientras la otra prometía enseñarlo entero, y su cabecera decía siempre «Necesita tu
 * permiso», así que un plan que quería salir a la nube no decía que era la nube.
 *
 * Eso convierte la superficie más importante del producto en dos promesas distintas según por dónde
 * hayas llegado. Aquí vive una, y lo que promete lo cumple en las dos pantallas:
 *
 *  · **qué se va a hacer**, con la cabecera que corresponde a la acción y no una fija;
 *  · **con qué permiso**, con su nombre y su tono, no con la palabra de la base;
 *  · **los argumentos exactos y el prompt entero, sin recortar**: entre lo que se lee aquí y lo que
 *    se ejecuta no puede caber un cambio, y un recorte es un cambio;
 *  · **si el efecto lo declaró el servidor o lo dedujimos nosotros**, que no es lo mismo fiarse de
 *    una etiqueta que de una suposición;
 *  · **cuánto le queda**, que se mueve solo, porque una tarjeta que dice «caduca en 0 min» desde
 *    hace un rato invita a pulsar algo que va a fallar.
 */
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import type { Approval, PermissionProfile } from '@jarvis/contracts';
import { ACTION_ICON, Glyph, PERMISSION_ICON, SOURCE_ICON } from './icons.jsx';
import { PERMISSION, permissionName } from './labels.js';

/** Lo que cada clase de aprobación mete en `target`. Es `unknown` en el contrato: se lee con cuidado. */
interface ApprovalTarget {
  reason?: string;
  capability?: string;
  server?: string;
  effectsDeclared?: boolean;
  args?: Record<string, unknown>;
  host?: string;
  permissionProfile?: string;
  prompt?: string;
  model?: string;
}

const HEADINGS: Record<string, { text: string; icon: typeof ACTION_ICON.capability }> = {
  escalate: { text: 'Quiere consultar a la nube', icon: SOURCE_ICON.cloud },
  capability: { text: 'Quiere tocar una máquina', icon: ACTION_ICON.capability },
  run: { text: 'Quiere lanzar un trabajo', icon: ACTION_ICON.delegate },
};

export function ApprovalCard({ approval, onDecide, pending, className = '' }: {
  approval: Approval;
  onDecide: (decision: 'approved' | 'rejected') => void;
  pending: boolean;
  className?: string;
}): JSX.Element {
  const target = approval.target as ApprovalTarget;
  const heading = HEADINGS[approval.actionType] ?? { text: 'Necesita tu permiso', icon: ACTION_ICON.capability };

  /*
   * El contador se mueve.
   *
   * Se calculaba una vez por render, así que una tarjeta abierta un rato seguía diciendo los
   * minutos de cuando apareció; y al llegar a cero seguía pareciendo pulsable, con el único
   * resultado posible de un `APPROVAL_EXPIRED`. Medio minuto de precisión sobra para algo que dura
   * treinta.
   */
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setAhora(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const restanMs = Date.parse(approval.expiresAt) - ahora;
  const caducada = restanMs <= 0;
  const restan = Math.max(0, Math.round(restanMs / 60_000));
  const perfil = target.permissionProfile as PermissionProfile | undefined;

  return (
    <div className={`card warn-card chat-approval ${caducada ? 'is-expired' : ''} ${className}`}
      role="group" aria-label={heading.text}>
      <h3 className="row" style={{ color: 'var(--warn)', gap: 6, margin: '0 0 6px' }}>
        <Glyph icon={heading.icon} size={16} />
        {heading.text}
      </h3>
      <p style={{ margin: '0 0 8px' }}>{approval.summary}</p>

      <div className="row small" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
        {target.capability ? <span className="badge neutral mono">{target.capability}</span> : null}
        {target.server ? <span className="badge neutral">{target.server}</span> : null}
        {target.model ? <span className="badge neutral mono">{target.model}</span> : null}
        {target.host ? <span className="badge neutral mono">{target.host}</span> : null}

        {/*
          * Declarado o deducido.
          *
          * «El servidor dice que esto escribe» y «nadie lo etiquetó y hemos supuesto que escribe»
          * son dos cosas distintas para quien firma: en la segunda, ni siquiera sabemos si el
          * efecto es el que creemos. El dato existe en el catálogo y no se estaba enseñando.
          */}
        {target.effectsDeclared !== undefined ? (
          <span
            className={`badge ${target.effectsDeclared ? 'neutral' : 'warn'}`}
            title={target.effectsDeclared
              ? 'El servidor MCP declara qué efecto tiene esta capacidad.'
              : 'Nadie la etiquetó: el efecto es una deducción nuestra, así que puede ser otro.'}
          >
            {target.effectsDeclared ? 'efecto declarado' : 'efecto deducido'}
          </span>
        ) : null}

        {/*
          * El permiso con su nombre y su tono, no con la palabra de la base: `auto` significa
          * «escribe ficheros en el destino, y lo que toque queda tocado», y esa frase ya estaba
          * escrita sin que nadie la enseñara.
          */}
        {perfil ? (
          <span className={`badge ${PERMISSION[perfil]?.tone ?? 'warn'}`} title={PERMISSION[perfil]?.help}>
            <Glyph icon={PERMISSION_ICON[perfil] ?? ACTION_ICON.insecure} />
            {permissionName(perfil)}
          </span>
        ) : null}

        <span className={caducada ? 'danger' : 'muted'}>
          {caducada ? 'caducada' : `caduca en ${restan} min`}
        </span>
      </div>

      {/* Los argumentos exactos: entre lo que se lee aquí y lo que se ejecuta no cabe un cambio. */}
      {target.args && Object.keys(target.args).length ? (
        <pre className="small mono chat-approval-args">{JSON.stringify(target.args, null, 2)}</pre>
      ) : null}
      {/* Y el prompt **entero**. La otra tarjeta lo recortaba a 400, que es cambiar lo que se firma. */}
      {target.prompt ? <pre className="small mono chat-approval-args">{target.prompt}</pre> : null}

      {caducada ? (
        <p className="tiny warn" style={{ margin: 0 }}>
          Se pasó el plazo sin respuesta, así que ya no se puede autorizar. Vuelve a pedírselo si
          sigue haciendo falta.
        </p>
      ) : (
        <div className="row">
          <button type="button" className="btn primary" disabled={pending}
            onClick={() => onDecide('approved')}>
            <Glyph icon={ACTION_ICON.approve} />
            Autorizar
          </button>
          <button type="button" className="btn danger" disabled={pending}
            onClick={() => onDecide('rejected')}>
            <Glyph icon={ACTION_ICON.reject} />
            No
          </button>
        </div>
      )}
    </div>
  );
}
