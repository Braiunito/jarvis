/*
 * Registrar una passkey con un código de un solo uso.
 *
 * POR QUÉ ES UNA PANTALLA APARTE. El gateway tenía los dos extremos
 * (`/auth/enroll/options` y `/auth/enroll/verify`) desde el principio, y
 * `jarvis-users enroll` decía «abre /enroll en el navegador», pero esa pantalla
 * no existía: sin sesión, `app.tsx` mandaba cualquier ruta al login. Quien
 * recibía un código no tenía dónde escribirlo, y no hay forma de suplirlo por
 * terminal —WebAuthn sólo vive en el navegador—.
 *
 * Va SIN sesión a propósito: quien enrola todavía no puede entrar. Lo que la
 * protege es el código, que caduca y muere en su primer uso correcto.
 */
import type { JSX } from 'react';
import { useState } from 'react';
import { post } from '../api/client.js';
import { ErrorNote } from '../ui/bits.jsx';
import { ACTION_ICON, Glyph, NAV_ICON } from '../ui/icons.jsx';

const b64uToBytes = (value: string): Uint8Array => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

const bytesToB64u = (buffer: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

interface EnrollOptions {
  challengeId: string;
  publicKey: Record<string, unknown>;
}

export function EnrollScreen(): JSX.Element {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hecho, setHecho] = useState<string | null>(null);

  const soportado = typeof window !== 'undefined' && Boolean(window.PublicKeyCredential);

  async function registrar(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // El código va en mayúsculas y sin espacios: se dicta por voz o se copia de
      // una terminal, y llega de las dos maneras.
      const limpio = code.trim().toUpperCase();
      const options = await post<EnrollOptions>('/auth/enroll/options', { code: limpio });

      const publicKey = options.publicKey as unknown as PublicKeyCredentialCreationOptions & {
        challenge: string;
        user: { id: string; name: string; displayName: string };
        excludeCredentials?: { id: string; type: 'public-key' }[];
      };

      const credential = await navigator.credentials.create({
        publicKey: {
          ...publicKey,
          challenge: b64uToBytes(publicKey.challenge as unknown as string),
          user: {
            ...publicKey.user,
            id: new TextEncoder().encode(publicKey.user.id),
          },
          excludeCredentials: (publicKey.excludeCredentials ?? []).map((c) => ({
            ...c,
            id: b64uToBytes(c.id as unknown as string),
          })),
        },
      }) as PublicKeyCredential | null;
      if (!credential) throw new Error('el autenticador no devolvió nada');

      const response = credential.response as AuthenticatorAttestationResponse;
      const result = await post<{ ok: true; username: string }>('/auth/enroll/verify', {
        challengeId: options.challengeId,
        credential: {
          id: credential.id,
          rawId: bytesToB64u(credential.rawId),
          type: credential.type,
          response: {
            clientDataJSON: bytesToB64u(response.clientDataJSON),
            attestationObject: bytesToB64u(response.attestationObject),
          },
        },
      });
      setHecho(result.username);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div style={{ width: 'min(420px, 100%)' }}>
        <div className="login-brand">
          <span className="rail-mark"><Glyph icon={NAV_ICON.brand} size={19} /></span>
          <div>
            <h1>Jarvis</h1>
            <p>Registrar la huella en este dispositivo</p>
          </div>
        </div>

        {hecho ? (
          <div className="card stack">
            <p className="note" role="status" style={{ margin: 0 }}>
              <Glyph icon={ACTION_ICON.approve} size={16} />
              <span>
                Listo, <strong>{hecho}</strong>: esta huella ya vale para entrar desde este
                dispositivo. El código queda gastado.
              </span>
            </p>
            <a className="btn primary" href="/">Ir a entrar</a>
          </div>
        ) : (
          <div className="card stack">
            <p className="small muted" style={{ margin: 0 }}>
              Escribe el código de un solo uso que te dieron por terminal
              (<code>jarvis users enroll</code>). Caduca a los 15 minutos.
            </p>

            {!soportado ? (
              <p className="stale-note" role="status">
                <Glyph icon={ACTION_ICON.insecure} size={16} />
                <span>
                  Este navegador no expone WebAuthn. Pasa por HTTPS y en un navegador reciente:
                  sin contexto seguro no hay passkeys.
                </span>
              </p>
            ) : null}

            <label className="stack" style={{ gap: 6 }}>
              <span className="small muted">Código de enrolamiento</span>
              <input
                className="input"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="XXXX-XXXX-XXXX"
                autoCapitalize="characters"
                autoComplete="one-time-code"
                spellCheck={false}
                aria-label="Código de enrolamiento"
                onKeyDown={(event) => { if (event.key === 'Enter' && code.trim()) void registrar(); }}
              />
            </label>

            {error ? <ErrorNote error={new Error(error)} /> : null}

            <button type="button" className="btn primary" disabled={busy || !code.trim() || !soportado}
              onClick={() => void registrar()}>
              <Glyph icon={ACTION_ICON.session} />
              {busy ? 'Esperando al autenticador…' : 'Registrar la huella'}
            </button>

            <a className="btn ghost small" href="/">Volver a entrar</a>
          </div>
        )}
      </div>
    </div>
  );
}
