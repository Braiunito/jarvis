/**
 * Terminal viva.
 *
 * No es un chat: es un TTY. Tiene su propia entrada, sus propias teclas y su propia continuidad
 * —la tmux del otro lado—, así que salir de aquí no mata nada y volver no crea una segunda.
 */
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { Provider } from '@jarvis/contracts';
import { useDestroyTerminal, useHosts, useOpenTerminal, useTerminals } from '../api/queries.js';
import { Empty, ErrorNote, relativeTime } from '../ui/bits.jsx';
import { announce, useAnnounceOnChange } from '../ui/announce.jsx';
import { ACTION_ICON, Glyph, NAV_ICON, RUN_STATUS_ICON, STATUS_ICON } from '../ui/icons.jsx';
import { usePageMeta } from '../ui/page-meta.jsx';
import { Card, ConfirmDialog } from '../ui/primitives.jsx';

/** Las teclas que un teléfono no tiene y una terminal necesita. */
const MOBILE_KEYS: Array<{ label: string; bytes: string }> = [
  { label: 'Esc', bytes: '\u001b' },
  { label: 'Tab', bytes: '\t' },
  { label: 'Ctrl+C', bytes: '\u0003' },
  { label: 'Enter', bytes: '\r' },
  { label: '↑', bytes: '\u001b[A' },
  { label: '↓', bytes: '\u001b[B' },
  { label: '←', bytes: '\u001b[D' },
  { label: '→', bytes: '\u001b[C' },
];

export function TerminalScreen({ query }: { query: URLSearchParams }): JSX.Element {
  const hosts = useHosts();
  const [host, setHost] = useState(query.get('host') ?? '');
  const [provider, setProvider] = useState<Provider>((query.get('provider') as Provider) ?? 'claude');
  const [sessionId] = useState(query.get('sessionId') ?? '');
  // De dónde se vino: si fue de un workspace, hay que poder volver sin buscarlo otra vez.
  const [origin] = useState(query.get('from') ?? '');
  const [attached, setAttached] = useState<{ name: string; host: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [connected, setConnected] = useState(false);
  const sessions = useTerminals(host || null);

  const holder = useRef<HTMLDivElement | null>(null);
  const term = useRef<Terminal | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const autoOpened = useRef(false);
  const destroy = useDestroyTerminal();
  const openTerminal = useOpenTerminal();
  /** Qué sesión se está a punto de destruir. Nunca se destruye sin nombrarla. */
  const [killing, setKilling] = useState<{ host: string; name: string } | null>(null);

  /*
   * El teclado virtual.
   *
   * `dvh` mide la ventana, no lo que queda visible con el teclado abierto: la terminal y la fila
   * de teclas acababan debajo del teclado, que es exactamente cuando se usan. `visualViewport` es
   * lo único que sabe cuánto queda, y se publica como variable CSS para que el alto lo resuelva
   * la hoja de estilos y no este componente.
   */
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return undefined;
    const shell = document.querySelector('.shell');
    const apply = (): void => {
      document.documentElement.style.setProperty('--viewport', `${Math.round(viewport.height)}px`);
      // Un recorte grande sólo lo produce un teclado: una barra de navegador quita mucho menos.
      shell?.classList.toggle('keyboard-open', window.innerHeight - viewport.height > 160);
    };
    apply();
    viewport.addEventListener('resize', apply);
    viewport.addEventListener('scroll', apply);
    return () => {
      viewport.removeEventListener('resize', apply);
      viewport.removeEventListener('scroll', apply);
      document.documentElement.style.removeProperty('--viewport');
      shell?.classList.remove('keyboard-open');
    };
  }, []);

  // Conectarse y perder la conexión son transiciones que hay que oír, no adivinar mirando.
  useAnnounceOnChange(
    attached ? `${attached.name}:${connected}` : 'ninguna',
    (value) => {
      if (value === 'ninguna') return null;
      return connected
        ? `Terminal conectada a ${attached?.name ?? ''} en ${attached?.host ?? ''}.`
        : 'Terminal desconectada. La sesión sigue viva en la máquina.';
    },
  );

  usePageMeta({
    title: 'Terminal',
    subtitle: 'Una tmux viva en la máquina, no un chat',
    ...(origin ? { parent: { label: 'Workspace', to: `/w/${origin}` } } : {}),
  });

  useEffect(() => {
    if (!hosts.data || host) return;
    setHost(hosts.data.bastionHost);
  }, [hosts.data, host]);

  /**
   * Llegar con destino en la URL es una decisión ya tomada.
   *
   * Quien pulsa «Abrir terminal» en un workspace ya eligió máquina y sesión; obligarle a pulsar
   * «Conectar» otra vez es repetir la misma respuesta. Sólo pasa una vez y sólo si el enlace
   * traía el host: entrar a /terminal a pelo sigue sin abrir nada por su cuenta.
   */
  useEffect(() => {
    if (autoOpened.current || attached || !query.get('host')) return;
    autoOpened.current = true;
    void open();
  }, [query, attached]);

  useEffect(() => {
    if (!attached || !holder.current) return undefined;
    const terminal = new Terminal({
      fontSize: 13,
      convertEol: false,
      cursorBlink: true,
      theme: { background: '#000000' },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(holder.current);
    fit.fit();
    term.current = terminal;

    const url = new URL('/events/terminal', window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('host', attached.host);
    url.searchParams.set('name', attached.name);
    url.searchParams.set('cols', String(terminal.cols));
    url.searchParams.set('rows', String(terminal.rows));

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    socket.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        terminal.write(event.data);
      } else {
        terminal.write(new Uint8Array(event.data as ArrayBuffer));
      }
    };
    // Desconectar es normal: la tmux sigue viva al otro lado y volver a entrar reengancha.
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);

    const typing = terminal.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    const onResize = (): void => {
      fit.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
      }
    };
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      typing.dispose();
      ws.close();
      terminal.dispose();
      term.current = null;
      socket.current = null;
    };
  }, [attached]);

  async function open(): Promise<void> {
    setError(null);
    try {
      const opened = await openTerminal.mutateAsync({ host, provider, sessionId: sessionId || null });
      setAttached({ name: opened.name, host: opened.host });
    } catch (caught) {
      setError(caught);
    }
  }

  /**
   * Destruir la sesión.
   *
   * La regla del producto es que salir no mata nada; por eso matar tiene que ser un acto
   * explícito, con nombre y confirmación. Si la que muere es la que estás mirando, se suelta el
   * socket y se vuelve a la lista: quedarse pintando una terminal que ya no existe es peor que
   * no enseñar nada.
   */
  async function killSession(target: { host: string; name: string }): Promise<void> {
    setError(null);
    try {
      await destroy.mutateAsync(target);
      announce(`Terminal ${target.name} cerrada en ${target.host}.`);
      if (attached && attached.name === target.name && attached.host === target.host) {
        socket.current?.close();
        setAttached(null);
      }
    } catch (caught) {
      setError(caught);
    } finally {
      setKilling(null);
    }
  }

  const sendKey = (bytes: string): void => {
    socket.current?.send(bytes);
    term.current?.focus();
  };

  return (
    <div className="page">
      <Card className="terminal-setup">
        <div className="row">
          <span className="row tight faint" style={{ flex: '0 0 auto' }}>
            <Glyph icon={STATUS_ICON.host} size={16} />
          </span>
          <label className="row small">
            <span className="muted">Máquina</span>
            <select className="select control-md" value={host} onChange={(event) => setHost(event.target.value)}>
              {(hosts.data?.hosts ?? []).map((candidate) => {
                const unknown = candidate.stale === true;
                return (
                  <option key={candidate.host} value={candidate.host}
                    disabled={!unknown && !candidate.tmux}>
                    {candidate.host}
                    {unknown ? '' : candidate.tmux ? '' : ' (sin tmux)'}
                  </option>
                );
              })}
            </select>
          </label>
          <label className="row small">
            <span className="muted">Agente</span>
            <select className="select control-sm" value={provider}
              onChange={(event) => setProvider(event.target.value as Provider)}>
              <option value="claude">claude</option>
              <option value="codex">codex</option>
              <option value="opencode">opencode</option>
            </select>
          </label>
          <button type="button" className="btn primary" onClick={() => void open()} disabled={!host}>
            <Glyph icon={attached ? ACTION_ICON.retry : ACTION_ICON.connect} />
            {attached ? 'Reconectar' : 'Conectar'}
          </button>
          {attached ? (
            <span className={`badge ${connected ? 'ok' : 'warn'}`}>
              <Glyph icon={connected ? ACTION_ICON.connect : RUN_STATUS_ICON.cancelling} />
              {connected ? 'conectada' : 'desconectada'}
            </span>
          ) : null}
          {attached ? <span className="small muted mono">{attached.name}</span> : null}
          {attached ? (
            <button type="button" className="btn small danger"
              onClick={() => setKilling(attached)}
              title="Destruye la sesión en la máquina: lo que esté corriendo dentro se para">
              <Glyph icon={ACTION_ICON.stop} />
              Cerrar la terminal
            </button>
          ) : null}
        </div>
        <ErrorNote error={error} onRetry={() => void open()} />
        {sessionId ? (
          <p className="small muted" style={{ margin: '10px 0 0' }}>
            Sesión <span className="mono">{sessionId}</span>
            {origin ? ' · vienes de un workspace, y volver no la cierra.' : ''}
          </p>
        ) : null}
      </Card>

      {attached ? (
        <Card>
          <div className="terminal-host" ref={holder} />
          <div className="mobile-keys">
            {MOBILE_KEYS.map((key) => (
              <button key={key.label} type="button" className="btn small" onClick={() => sendKey(key.bytes)}>
                {key.label}
              </button>
            ))}
          </div>
          <p className="small muted" style={{ margin: '10px 0 0' }}>
            Salir de esta pantalla no cierra la sesión: sigue viva en {attached.host}.
          </p>
        </Card>
      ) : (
        <Card title={`Sesiones abiertas en ${host || 'esta máquina'}`} icon={NAV_ICON.terminal}
          count={sessions.data?.sessions.length ?? 0}>
          <div className="list">
            {/*
              * Dos acciones distintas en la misma fila: entrar y destruir. Por eso la fila no es
              * un botón —un botón dentro de otro no es HTML válido ni se puede tabular—, sino una
              * fila con dos botones de verdad.
              */}
            {(sessions.data?.sessions ?? []).map((session) => (
              <div key={session.name} className="list-item">
                <button type="button" className="list-open"
                  onClick={() => setAttached({ name: session.name, host: session.host })}>
                  <span className={`badge ${session.kind === 'run' ? 'running' : 'neutral'}`}>
                    <Glyph icon={session.kind === 'run' ? RUN_STATUS_ICON.running : NAV_ICON.terminal} size={13} />
                    {session.kind === 'run' ? 'trabajo' : 'interactiva'}
                  </span>
                  <span className="mono small truncate">{session.name}</span>
                  {session.attached ? <span className="badge warn">alguien mirando</span> : null}
                </button>
                <span className="row tight nowrap">
                  <span className="tiny faint">creada {relativeTime(session.createdAt)}</span>
                  <button type="button" className="btn small danger icon"
                    aria-label={`Cerrar la terminal ${session.name}`}
                    title="Destruye esta sesión en la máquina"
                    onClick={() => setKilling({ host: session.host, name: session.name })}>
                    <Glyph icon={ACTION_ICON.stop} />
                  </button>
                </span>
              </div>
            ))}
            {(sessions.data?.sessions.length ?? 0) === 0 ? (
              <Empty
                tight
                icon={NAV_ICON.terminal}
                title="Ninguna sesión abierta en esta máquina"
                hint="Conectar crea una tmux con el agente dentro. Vive en la máquina, así que salir de esta pantalla no la cierra y volver reengancha la misma."
                action={
                  <button type="button" className="btn primary" onClick={() => void open()} disabled={!host}>
                    <Glyph icon={ACTION_ICON.connect} />
                    Conectar con {host || 'la máquina'}
                  </button>
                }
              />
            ) : null}
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={killing !== null}
        title="Cerrar la terminal en la máquina"
        description={killing ? (
          <>
            Se destruye la sesión <span className="mono">{killing.name}</span> en{' '}
            <span className="mono">{killing.host}</span>. Lo que esté corriendo dentro se para y no
            se puede recuperar. Si sólo quieres irte, cierra esta pantalla: la sesión sigue viva.
          </>
        ) : null}
        confirmLabel="Cerrar la terminal"
        pending={destroy.isPending}
        onConfirm={() => { if (killing) void killSession(killing); }}
        onClose={() => setKilling(null)}
      />
    </div>
  );
}
