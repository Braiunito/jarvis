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
import { post } from '../api/client.js';
import { useHosts, useTerminals } from '../api/queries.js';
import { ErrorNote, relativeTime } from '../ui/bits.jsx';

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
  const [attached, setAttached] = useState<{ name: string; host: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [connected, setConnected] = useState(false);
  const sessions = useTerminals(host || null);

  const holder = useRef<HTMLDivElement | null>(null);
  const term = useRef<Terminal | null>(null);
  const socket = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!hosts.data || host) return;
    setHost(hosts.data.bastionHost);
  }, [hosts.data, host]);

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
      const opened = await post<{ name: string; host: string; created: boolean }>('/api/terminal/open', {
        host, provider, sessionId: sessionId || null,
      });
      setAttached({ name: opened.name, host: opened.host });
    } catch (caught) {
      setError(caught);
    }
  }

  const sendKey = (bytes: string): void => {
    socket.current?.send(bytes);
    term.current?.focus();
  };

  return (
    <div className="page wide">
      <div className="card">
        <div className="row">
          <label className="row small">
            <span className="muted">Host</span>
            <select className="select control-md" value={host} onChange={(event) => setHost(event.target.value)}>
              {(hosts.data?.hosts ?? []).map((candidate) => (
                <option key={candidate.host} value={candidate.host} disabled={!candidate.tmux}>
                  {candidate.host}{candidate.tmux ? '' : ' (sin tmux)'}
                </option>
              ))}
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
            {attached ? 'Reconectar' : 'Conectar'}
          </button>
          {attached ? (
            <span className={`badge ${connected ? 'ok' : 'warn'}`}>
              <span className="dot" aria-hidden="true" />{connected ? 'conectada' : 'desconectada'}
            </span>
          ) : null}
          {attached ? <span className="small muted mono">{attached.name}</span> : null}
        </div>
        <ErrorNote error={error} />
        {sessionId ? <p className="small muted" style={{ marginBottom: 0 }}>Sesión {sessionId}</p> : null}
      </div>

      {attached ? (
        <div className="card">
          <div className="terminal-host" ref={holder} />
          <div className="mobile-keys">
            {MOBILE_KEYS.map((key) => (
              <button key={key.label} type="button" className="btn small" onClick={() => sendKey(key.bytes)}>
                {key.label}
              </button>
            ))}
          </div>
          <p className="small muted" style={{ marginBottom: 0 }}>
            Salir de esta pantalla no cierra la sesión: sigue viva en {attached.host}.
          </p>
        </div>
      ) : (
        <div className="card">
          <h2>Sesiones en {host || 'este host'}</h2>
          <div className="list">
            {(sessions.data?.sessions ?? []).map((session) => (
              <button key={session.name} type="button" className="list-item"
                onClick={() => setAttached({ name: session.name, host: session.host })}>
                <span className="row">
                  <span className={`badge ${session.kind === 'run' ? 'running' : 'neutral'}`}>{session.kind}</span>
                  <span className="mono small">{session.name}</span>
                  {session.attached ? <span className="badge warn">alguien mirando</span> : null}
                </span>
                <span className="small muted">creada {relativeTime(session.createdAt)}</span>
              </button>
            ))}
            {(sessions.data?.sessions.length ?? 0) === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>Ninguna sesión abierta aquí todavía.</p>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
