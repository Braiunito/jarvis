/**
 * Entrar.
 *
 * La cadena de pasos la decide el servidor (`/auth/config`); esta pantalla sólo la recorre. Si el
 * despliegue tiene abierta la escotilla de HTTP plano, se dice en pantalla y no se esconde.
 */
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { get, post } from '../api/client.js';
import type { AuthConfig } from '@jarvis/contracts';
import { ErrorNote } from '../ui/bits.jsx';
import { ACTION_ICON, Glyph, NAV_ICON, PERMISSION_ICON } from '../ui/icons.jsx';

const b64uToBytes = (value: string): Uint8Array => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

const bytesToB64u = (buffer: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function LoginScreen({ onAuthenticated }: { onAuthenticated: () => void }): JSX.Element {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    get<AuthConfig>('/auth/config').then(setConfig).catch(setError);
  }, []);

  const passkeySupported = typeof window !== 'undefined' && Boolean(window.PublicKeyCredential);

  async function loginWithPasskey(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const options = await post<{ challengeId: string; publicKey: Record<string, unknown> }>('/auth/passkey/options', {});
      const publicKey = options.publicKey as unknown as PublicKeyCredentialRequestOptions & { challenge: string };
      const credential = await navigator.credentials.get({
        publicKey: {
          ...publicKey,
          challenge: b64uToBytes(publicKey.challenge as unknown as string),
          allowCredentials: [],
        },
      }) as PublicKeyCredential | null;
      if (!credential) throw new Error('el navegador no devolvió ninguna credencial');
      const response = credential.response as AuthenticatorAssertionResponse;
      await post('/auth/passkey/verify', {
        challengeId: options.challengeId,
        credential: {
          id: credential.id,
          rawId: bytesToB64u(credential.rawId),
          type: credential.type,
          response: {
            clientDataJSON: bytesToB64u(response.clientDataJSON),
            authenticatorData: bytesToB64u(response.authenticatorData),
            signature: bytesToB64u(response.signature),
            // El autenticador guarda los bytes UTF-8 del userId opaco; el servidor espera ese texto.
            userHandle: response.userHandle ? new TextDecoder().decode(response.userHandle) : null,
          },
        },
      });
      onAuthenticated();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function loginWithPassword(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/auth/password/verify', { username, password });
      onAuthenticated();
    } catch (caught) {
      setError(caught);
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
            <p>Consola de agentes sobre el bastión</p>
          </div>
        </div>

      {config?.insecureLogin ? (
        <p className="stale-note" role="status" style={{ marginBottom: 12 }}>
          <Glyph icon={ACTION_ICON.insecure} size={16} />
          <span>
            Entrada por contraseña sobre HTTP sin cifrar. Es temporal: mientras no haya certificado,
            las passkeys no existen para el navegador. Todo lo que escribas viaja en claro.
          </span>
        </p>
      ) : null}

      <div className="card stack">
        {config?.steps.includes('passkey') && !config.insecureLogin ? (
          <>
            <button type="button" className="btn primary block" disabled={busy || !passkeySupported}
              onClick={() => void loginWithPasskey()}>
              <Glyph icon={ACTION_ICON.secure} />
              {busy ? 'Esperando al autenticador…' : 'Entrar con huella'}
            </button>
            {!passkeySupported ? (
              <p className="small muted" style={{ margin: 0 }}>
                Este navegador no expone WebAuthn aquí. Las passkeys sólo funcionan en contexto
                seguro: https, o localhost a través de un túnel.
              </p>
            ) : null}
          </>
        ) : null}

        {config?.steps.includes('password') ? (
          <form className="stack" onSubmit={(event) => void loginWithPassword(event)}>
            <label className="stack">
              <span className="small muted">Usuario</span>
              <input className="input" value={username} autoComplete="username"
                onChange={(event) => setUsername(event.target.value)} required />
            </label>
            <label className="stack">
              <span className="small muted">Contraseña</span>
              <input className="input" type="password" value={password} autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)} required />
            </label>
            <button type="submit" className="btn primary block" disabled={busy}>
              <Glyph icon={ACTION_ICON.go} />
              Entrar
            </button>
          </form>
        ) : null}

        <ErrorNote error={error} />
        <p className="small muted permission-help" style={{ margin: 0 }}>
          <Glyph icon={PERMISSION_ICON.safe} />
          <span>
            No hay registro público: una cuenta existe sólo si alguien la creó por terminal con
            <span className="mono"> jarvis-users add</span>.
          </span>
        </p>
        </div>
      </div>
    </div>
  );
}
