/**
 * Entrar.
 *
 * La cadena de pasos la decide el servidor y esta pantalla la **recorre**: cada verificación
 * responde `{authenticated: true}` —y entonces ya hay cookie— o `{authenticated: false, next,
 * pending}`, que significa «este paso está hecho, falta ese otro, y aquí llevas la prueba de lo
 * hecho». Hasta ahora la pantalla llamaba a `onAuthenticated()` pasara lo que pasara: con una
 * política de dos factores el primer paso no emite cookie, la aplicación se creía dentro y
 * `/auth/me` la echaba sin explicar por qué. Con `totp` no se podía entrar en absoluto.
 *
 * Tres reglas que se notan al usarlo:
 *
 *   · **un solo paso a la vista.** La cadena se recorre, no se rellena entera: enseñar los tres
 *     campos a la vez invita a completarlos en el orden que no es;
 *   · **el token pendiente vive en memoria y nada más.** Es la prueba de haber pasado un factor;
 *     guardarlo en disco sería guardar medio inicio de sesión;
 *   · **`onAuthenticated()` sólo se llama con `authenticated === true`.** Es la línea que separa
 *     «he entrado» de «he empezado a entrar».
 *
 * Si el despliegue tiene abierta la escotilla de HTTP plano, se dice en pantalla y no se esconde.
 */
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { get, post } from '../api/client.js';
import type { AuthConfig } from '@jarvis/contracts';
import { ErrorNote } from '../ui/bits.jsx';
import { ACTION_ICON, Glyph, NAV_ICON, PERMISSION_ICON, STATUS_ICON } from '../ui/icons.jsx';

const b64uToBytes = (value: string): Uint8Array => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

const bytesToB64u = (buffer: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Lo que responde cualquier paso de la cadena. */
interface StepResult {
  authenticated: boolean;
  next?: string;
  pending?: string;
}

const STEP_NAME: Record<string, string> = {
  password: 'contraseña',
  passkey: 'huella o PIN',
  totp: 'código de la aplicación',
};

export function LoginScreen({ onAuthenticated }: { onAuthenticated: () => void }): JSX.Element {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);

  /**
   * Dónde va la cadena.
   *
   * `step` es el paso que toca ahora; `pending`, la prueba de los ya hechos. Los dos viven aquí y
   * en ningún otro sitio: recargar la página vuelve a empezar, que es lo correcto para medio
   * inicio de sesión.
   */
  const [step, setStep] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [done, setDone] = useState<string[]>([]);

  useEffect(() => {
    get<AuthConfig>('/auth/config')
      .then((value) => {
        setConfig(value);
        setStep(value.steps[0] ?? 'passkey');
      })
      .catch(setError);
  }, []);

  const passkeySupported = typeof window !== 'undefined' && Boolean(window.PublicKeyCredential);

  /**
   * Avanzar la cadena con lo que diga el servidor.
   *
   * Es el único sitio donde se decide que alguien ha entrado, y por eso el único que llama a
   * `onAuthenticated()`.
   */
  function advance(result: StepResult, justDone: string): void {
    if (result.authenticated) {
      onAuthenticated();
      return;
    }
    setDone((previous) => [...new Set([...previous, justDone])]);
    setPending(result.pending ?? null);
    setStep(result.next ?? null);
    setPassword('');
    setCode('');
    setUseRecovery(false);
  }

  async function loginWithPasskey(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const options = await post<{ challengeId: string; publicKey: Record<string, unknown> }>(
        '/auth/passkey/options',
        { ...(pending ? { pending } : {}), ...(username ? { username } : {}) },
      );
      const publicKey = options.publicKey as unknown as PublicKeyCredentialRequestOptions & { challenge: string };
      const credential = await navigator.credentials.get({
        publicKey: {
          ...publicKey,
          challenge: b64uToBytes(publicKey.challenge as unknown as string),
          allowCredentials: [],
        },
      }) as PublicKeyCredential | null;
      if (!credential) throw new Error('el autenticador no devolvió nada');
      const response = credential.response as AuthenticatorAssertionResponse;

      const result = await post<StepResult>('/auth/passkey/verify', {
        challengeId: options.challengeId,
        ...(pending ? { pending } : {}),
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
      advance(result, 'passkey');
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
      const result = await post<StepResult>('/auth/password/verify', {
        username,
        password,
        ...(pending ? { pending } : {}),
      });
      advance(result, 'password');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await post<StepResult>('/auth/totp/verify', {
        ...(pending ? { pending } : {}),
        ...(useRecovery ? { recoveryCode: code.trim() } : { code: code.trim() }),
      });
      advance(result, 'totp');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  const steps = config?.steps ?? [];
  const multiStep = steps.length > 1;

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
        {/*
          * Dónde va la cadena, cuando hay más de un paso.
          *
          * Sin esto, un segundo factor aparece de la nada después de acertar la contraseña y se
          * lee como un fallo. Con dos pasos se dice antes cuántos son y por cuál se va.
          */}
        {multiStep ? (
          <div className="row tight" style={{ gap: 6 }}>
            {steps.map((name) => (
              <span key={name}
                className={`badge ${done.includes(name) ? 'ok' : name === step ? 'accent' : 'neutral'}`}>
                <Glyph icon={done.includes(name) ? ACTION_ICON.approve : STATUS_ICON.clock} size={13} />
                {STEP_NAME[name] ?? name}
              </span>
            ))}
          </div>
        ) : null}

        {step === 'passkey' ? (
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

        {step === 'password' ? (
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
              {busy ? 'Comprobando…' : 'Entrar'}
            </button>
          </form>
        ) : null}

        {step === 'totp' ? (
          <form className="stack" onSubmit={(event) => void verifyCode(event)}>
            <label className="stack">
              <span className="small muted">
                {useRecovery ? 'Código de recuperación' : 'Código de la aplicación'}
              </span>
              <input className="input mono" value={code} autoComplete="one-time-code"
                inputMode={useRecovery ? 'text' : 'numeric'}
                placeholder={useRecovery ? 'uno de los que guardaste' : '000000'}
                onChange={(event) => setCode(event.target.value)} required autoFocus />
            </label>
            <button type="submit" className="btn primary block" disabled={busy || !code.trim()}>
              <Glyph icon={ACTION_ICON.approve} />
              {busy ? 'Comprobando…' : 'Confirmar'}
            </button>
            {/* La vuelta cuando el teléfono ya no está. De un solo uso, y el servidor lo sabe. */}
            <button type="button" className="btn small ghost"
              onClick={() => { setUseRecovery((value) => !value); setCode(''); }}>
              {useRecovery ? 'Usar el código de la aplicación' : 'No tengo el teléfono: usar un código de recuperación'}
            </button>
          </form>
        ) : null}

        {step === null ? (
          <p className="small muted" style={{ margin: 0 }}>
            El servidor no ha pedido ningún paso más y tampoco ha dado la sesión por buena. Vuelve a
            empezar; si se repite, mira el registro del gateway.
          </p>
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
