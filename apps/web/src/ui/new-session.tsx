/**
 * Empezar una sesión desde cero.
 *
 * Hasta ahora sólo se podía continuar lo que ya existía: para abrir una conversación nueva había
 * que ir a la máquina, arrancarla a mano y esperar a que el índice la viera. Aquí se decide lo
 * mismo que se decidía allí —qué agente, dónde, en qué carpeta— y además con qué permiso, que es
 * justo la parte que a mano se olvida.
 *
 * Dos reglas de esta pantalla:
 *
 *   · **Trabajo y terminal se eligen a la vista.** No son la misma cosa: uno deja evidencia y el
 *     otro es un TTY para mirar y teclear. Esconder esa elección en un desplegable hace que se
 *     acabe eligiendo por descarte.
 *   · **No se ofrece lo imposible.** goro1 no tiene ningún agente instalado y OpenCode sólo está
 *     en dos máquinas: dejar elegir esa combinación convierte un error de validación en un viaje
 *     de ida y vuelta. Pero «no lo he comprobado» no es «no lo tiene»: mientras el sondeo no
 *     conteste, no se deshabilita nada.
 */
import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { PermissionProfile, Provider } from '@jarvis/contracts';
import { useHosts, useStartSession } from '../api/queries.js';
import { navigate } from '../router.js';
import { ErrorNote } from './bits.jsx';
import { ACTION_ICON, Glyph, NAV_ICON, PERMISSION_ICON, STATUS_ICON } from './icons.jsx';
import { PERMISSION } from './labels.js';
import { Segmented, type SegmentOption } from './primitives.jsx';

const PROVIDERS: Provider[] = ['claude', 'codex', 'opencode'];

const MODES: Array<SegmentOption<'task' | 'terminal'>> = [
  {
    value: 'task',
    label: 'Un trabajo',
    icon: NAV_ICON.runs,
    hint: 'Se manda algo que hacer y queda su evidencia: eventos, resultado y permiso.',
  },
  {
    value: 'terminal',
    label: 'Terminal viva',
    icon: NAV_ICON.terminal,
    hint: 'Una tmux en la máquina para mirar y teclear dentro. No deja evidencia.',
  },
];

const PROFILES: Array<SegmentOption<PermissionProfile>> = (['safe', 'auto', 'yolo'] as const).map((value) => ({
  value,
  label: PERMISSION[value].name,
  icon: PERMISSION_ICON[value],
  tone: PERMISSION[value].tone,
  hint: PERMISSION[value].help,
}));

const EVENT = 'jarvis:new-session';

export interface NewSessionPrefill {
  host?: string;
  provider?: Provider;
  cwd?: string | null;
}

/**
 * Abrirlo desde cualquier parte, sin pasar el estado por media aplicación.
 *
 * Admite valores de partida porque casi nunca se empieza en el vacío: se llega aquí desde una
 * sesión que no se puede continuar, y la máquina y la carpeta son exactamente las mismas. Hacer
 * que la persona las vuelva a teclear es pedirle que repita lo que la pantalla ya sabe.
 */
export const openNewSession = (prefill?: NewSessionPrefill): void => {
  window.dispatchEvent(new CustomEvent<NewSessionPrefill | undefined>(EVENT, { detail: prefill }));
};

export function NewSessionDialog(): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'task' | 'terminal'>('task');
  const [host, setHost] = useState('');
  const [provider, setProvider] = useState<Provider>('claude');
  const [cwd, setCwd] = useState('');
  const [profile, setProfile] = useState<PermissionProfile>('safe');
  const [prompt, setPrompt] = useState('');

  // Sondeado: aquí interesa saber de verdad qué hay en cada máquina, porque de eso depende que la
  // combinación elegida pueda existir. Es la misma consulta cara que hace Salud.
  const hosts = useHosts({ probe: true });
  const start = useStartSession();

  useEffect(() => {
    const onOpen = (event: Event): void => {
      const prefill = (event as CustomEvent<NewSessionPrefill | undefined>).detail;
      if (prefill?.host) setHost(prefill.host);
      if (prefill?.provider) setProvider(prefill.provider);
      if (prefill?.cwd !== undefined) setCwd(prefill.cwd ?? '');
      setOpen(true);
    };
    window.addEventListener(EVENT, onOpen);
    return () => window.removeEventListener(EVENT, onOpen);
  }, []);

  const fleet = useMemo(() => hosts.data?.hosts ?? [], [hosts.data]);
  const probed = hosts.data?.probed === true;

  /** Lo que sabemos de una máquina, cuando lo sabemos. `null` significa «sin comprobar». */
  const capabilitiesOf = (name: string): { providers: Provider[]; tmux: boolean } | null => {
    const found = fleet.find((candidate) => candidate.host === name);
    if (!found || !probed || found.stale === true) return null;
    return { providers: found.providers, tmux: found.tmux };
  };

  const hostAllows = (name: string, which: Provider): boolean => {
    const capabilities = capabilitiesOf(name);
    if (!capabilities) return true;
    if (mode === 'terminal' && !capabilities.tmux) return false;
    return capabilities.providers.includes(which);
  };

  useEffect(() => {
    if (!host && fleet.length) setHost(hosts.data?.bastionHost ?? fleet[0]?.host ?? '');
  }, [fleet, host, hosts.data?.bastionHost]);

  const usable = fleet.filter((candidate) => hostAllows(candidate.host, provider));
  const chosenIsImpossible = Boolean(host) && !hostAllows(host, provider);

  const close = (): void => {
    setOpen(false);
    setPrompt('');
    start.reset();
  };

  async function submit(): Promise<void> {
    const created = await start.mutateAsync({
      host,
      provider,
      mode,
      cwd: cwd.trim() || null,
      permissionProfile: profile,
      ...(mode === 'task' && prompt.trim() ? { prompt } : {}),
    });
    close();
    if (created.mode === 'terminal') {
      navigate(`/terminal?host=${encodeURIComponent(created.terminal.host)}&provider=${provider}`);
    } else {
      navigate(`/w/${created.workspace.id}`);
    }
  }

  if (!open) return null;

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) close(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop" />
        <Dialog.Content className="modal new-session" aria-describedby={undefined}>
          <header className="modal-head">
            <span className="badge accent">
              <Glyph icon={ACTION_ICON.new} />
              nueva
            </span>
            <Dialog.Title className="modal-title">Empezar una sesión</Dialog.Title>
            <div className="after">
              <Dialog.Close asChild>
                <button type="button" className="btn small icon" aria-label="Cerrar">
                  <Glyph icon={ACTION_ICON.reject} />
                </button>
              </Dialog.Close>
            </div>
          </header>

          <form className="modal-body stack" style={{ background: 'none', border: 0, padding: 0 }}
            onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <div className="stack" style={{ gap: 6 }}>
              <span className="small muted">Qué quieres empezar</span>
              <Segmented label="Qué quieres empezar" options={MODES} value={mode} onChange={setMode} />
              <p className="tiny faint" style={{ margin: 0 }}>
                {MODES.find((option) => option.value === mode)?.hint}
              </p>
            </div>

            <div className="row" style={{ gap: 10 }}>
              <div className="stack" style={{ gap: 6, flex: '1 1 200px' }}>
                <span className="small muted" id="ns-host">Máquina</span>
                <select className="select" value={host} aria-label="Máquina"
                  onChange={(event) => setHost(event.target.value)}>
                  {fleet.map((candidate) => (
                    <option key={candidate.host} value={candidate.host}
                      disabled={!hostAllows(candidate.host, provider)}>
                      {candidate.host}
                      {hostAllows(candidate.host, provider) ? '' : ` (sin ${mode === 'terminal' && capabilitiesOf(candidate.host)?.tmux === false ? 'tmux' : provider})`}
                    </option>
                  ))}
                </select>
              </div>

              <div className="stack" style={{ gap: 6, flex: '1 1 160px' }}>
                <span className="small muted">Agente</span>
                <select className="select" value={provider} aria-label="Agente"
                  onChange={(event) => setProvider(event.target.value as Provider)}>
                  {PROVIDERS.map((candidate) => (
                    <option key={candidate} value={candidate}>{candidate}</option>
                  ))}
                </select>
              </div>
            </div>

            {!probed && hosts.isFetching ? (
              <p className="tiny faint" style={{ margin: 0 }}>
                Comprobando qué agentes hay en cada máquina…
              </p>
            ) : null}

            {chosenIsImpossible ? (
              <p className="stale-note" role="status">
                <Glyph icon={ACTION_ICON.error} size={16} />
                <span>
                  {host} no tiene {provider}
                  {mode === 'terminal' ? ' o no tiene tmux' : ''}.
                  {usable.length
                    ? ` Sí está en ${usable.slice(0, 3).map((candidate) => candidate.host).join(', ')}.`
                    : ' Ninguna máquina de la flota lo tiene instalado.'}
                </span>
              </p>
            ) : null}

            <label className="stack" style={{ gap: 6 }}>
              <span className="small muted">Carpeta de trabajo · opcional</span>
              <input className="input mono" value={cwd} placeholder="/srv/app"
                onChange={(event) => setCwd(event.target.value)} />
              <span className="tiny faint">
                Donde el agente abrirá la sesión. En blanco, arranca donde tenga por defecto.
              </span>
            </label>

            <div className="stack" style={{ gap: 6 }}>
              <span className="small muted">Qué puede hacer</span>
              <Segmented label="Qué puede hacer el agente" options={PROFILES} value={profile} onChange={setProfile} />
              <p className="tiny faint permission-help" style={{ margin: 0 }}>
                <Glyph icon={PERMISSION_ICON[profile]} />
                <span>{PERMISSION[profile].help}</span>
              </p>
            </div>

            {mode === 'task' ? (
              <label className="stack" style={{ gap: 6 }}>
                <span className="small muted">La primera tarea · opcional</span>
                <textarea className="textarea" value={prompt}
                  placeholder="Describe qué quieres que haga en esa máquina."
                  onChange={(event) => setPrompt(event.target.value)} />
                <span className="tiny faint">
                  Si lo dejas en blanco se crea el workspace vacío y escribes la primera tarea allí,
                  como en cualquier otro. La sesión no existe en la máquina hasta que mandes algo.
                </span>
              </label>
            ) : null}

            <ErrorNote error={start.error} />

            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <Dialog.Close asChild>
                <button type="button" className="btn">Cancelar</button>
              </Dialog.Close>
              <button type="submit" className="btn primary"
                disabled={start.isPending || !host || chosenIsImpossible}>
                <Glyph icon={mode === 'terminal' ? ACTION_ICON.connect : prompt.trim() ? ACTION_ICON.send : ACTION_ICON.open} />
                {start.isPending
                  ? 'Empezando…'
                  : mode === 'terminal'
                    ? 'Abrir la terminal'
                    : prompt.trim() ? 'Empezar y enviar' : 'Crear el workspace'}
              </button>
            </div>

            {mode === 'task' && provider !== 'claude' ? (
              <p className="tiny faint" style={{ margin: 0 }}>
                <Glyph icon={STATUS_ICON.clock} size={13} />{' '}
                {provider} elige el identificador de la sesión y lo dice al arrancar, así que
                durante unos segundos el workspace lo tendrá pendiente.
              </p>
            ) : null}
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** El botón que la abre, para no repetir el icono y la palabra en cuatro sitios. */
export function NewSessionButton({ className = 'btn primary' }: { className?: string }): JSX.Element {
  return (
    <button type="button" className={className} onClick={() => openNewSession()}>
      <Glyph icon={ACTION_ICON.new} />
      Empezar una sesión
    </button>
  );
}

