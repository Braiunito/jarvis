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
import type { PermissionProfile, Provider } from '@jarvis/contracts';
import { useDestroyTerminal, useHosts, useOpenTerminal, useTerminals } from '../api/queries.js';
import { Empty, ErrorNote, relativeTime } from '../ui/bits.jsx';
import { announce, useAnnounceOnChange } from '../ui/announce.jsx';
import { ACTION_ICON, Glyph, NAV_ICON, RUN_STATUS_ICON, STATUS_ICON } from '../ui/icons.jsx';
import { PERMISSION } from '../ui/labels.js';
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
  /**
   * Qué puede hacer el agente dentro de esta terminal.
   *
   * Se elegía en todas partes menos aquí, donde siempre iba en sólo lectura sin decirlo. Una
   * terminal viva es el sitio donde más fácil es olvidarlo, porque no deja evidencia que mirar
   * después.
   */
  const [profile, setProfile] = useState<PermissionProfile>('safe');
  const [error, setError] = useState<unknown>(null);
  const [connected, setConnected] = useState(false);
  const sessions = useTerminals(host || null);

  const holder = useRef<HTMLDivElement | null>(null);
  const term = useRef<Terminal | null>(null);
  const fitter = useRef<FitAddon | null>(null);
  /** Temporizadores del desplazamiento: la repetición al mantener y la ráfaga de «al final». */
  const repeticion = useRef<{
    espera: ReturnType<typeof setTimeout> | null;
    repite: ReturnType<typeof setInterval> | null;
  }>({ espera: null, repite: null });
  const rafaga = useRef<ReturnType<typeof setInterval> | null>(null);
  const socket = useRef<WebSocket | null>(null);
  /**
   * Pantalla completa, resuelta en CSS y no sólo con la API del navegador.
   *
   * `requestFullscreen` no existe para elementos en Safari de iPhone —sólo para vídeo—, que es
   * justo el sitio donde una terminal de 24 líneas entre una cabecera y una barra de estado se
   * queda sin espacio. Así que el modo lo hace la hoja de estilos, y la API nativa se pide
   * *además* cuando está: donde funciona, quita también la barra del navegador.
   */
  const [immersive, setImmersive] = useState(false);
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
      /**
       * Cuánto se recuerda aquí.
       *
       * Éste es el histórico que de verdad se mira: tmux sólo archiva lo que se le va por arriba,
       * y un agente que repinta su interfaz en el sitio apenas le manda nada. Mil líneas —el
       * valor por defecto— se agotan en una conversación de media tarde.
       */
      scrollback: 5000,
      theme: { background: '#000000' },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(holder.current);
    fit.fit();
    term.current = terminal;
    fitter.current = fit;

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

    /**
     * El hueco puede cambiar sin que cambie la ventana.
     *
     * Entrar a pantalla completa, abrirse el teclado o girar el teléfono redimensionan el sitio
     * donde vive la terminal sin disparar el `resize` de `window`, así que xterm se estiraba y
     * **tmux seguía pintando al tamaño de antes**: la barra de estado a media altura y el texto
     * cortado a la mitad del ancho. Observar el hueco cubre los tres casos a la vez, y también
     * los que no se nos hayan ocurrido.
     */
    let pendiente: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      // Un cambio de tamaño llega en ráfaga; sólo interesa el tamaño en el que se queda.
      if (pendiente) clearTimeout(pendiente);
      pendiente = setTimeout(onResize, 80);
    });
    if (holder.current) observer.observe(holder.current);

    return () => {
      if (pendiente) clearTimeout(pendiente);
      observer.disconnect();
      window.removeEventListener('resize', onResize);
      typing.dispose();
      ws.close();
      terminal.dispose();
      term.current = null;
      fitter.current = null;
      socket.current = null;
    };
  }, [attached]);

  async function open(): Promise<void> {
    setError(null);
    try {
      const opened = await openTerminal.mutateAsync({
        host,
        provider,
        sessionId: sessionId || null,
        // Si se vino de un workspace, el core resuelve desde ahí la carpeta —y la deduce si no la
        // sabía—. Sin esto, `claude --resume` se abre en el home y no encuentra la conversación.
        workspaceId: origin || null,
        permissionProfile: profile,
      });
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

  /**
   * Mirar hacia atrás sin escribir nada.
   *
   * Hay **dos** históricos, y el bueno casi siempre es el de aquí. xterm guarda todo lo que tmux
   * le ha ido pintando; tmux, en cambio, sólo archiva lo que se le va por arriba de su ventana, y
   * un agente que repinta su interfaz en el sitio apenas le manda nada: se han visto sesiones con
   * cincuenta líneas en el modo copia y miles en el navegador. Por eso se mueve primero el de
   * aquí, que es además instantáneo y no cuesta una conexión ssh.
   *
   * Cuando el de aquí se agota —una pestaña recién abierta sobre una sesión que lleva horas
   * corriendo no tiene nada que enseñar— se le pide a tmux el suyo, que ahí sí es lo único que
   * queda. Se nota que se acabó porque el desplazamiento no mueve la vista ni una línea.
   */
  const sendTmuxScroll = (action: 'up' | 'down' | 'end'): void => {
    if (socket.current?.readyState !== WebSocket.OPEN) return;
    socket.current.send(JSON.stringify({ type: 'scroll', action }));
  };

  /** Una rueda de ratón hacia donde se diga, con el tamaño de la pantalla como paso. */
  const rueda = (direccion: -1 | 1): void => {
    const screen = holder.current?.querySelector('.xterm-screen');
    if (!screen) return;
    const alto = holder.current?.clientHeight ?? 240;
    screen.dispatchEvent(new WheelEvent('wheel', {
      deltaY: direccion * Math.max(120, Math.round(alto * 0.75)),
      deltaMode: 0,
      bubbles: true,
      cancelable: true,
    }));
  };

  const sendScroll = (action: 'up' | 'down' | 'end'): void => {
    const terminal = term.current;
    if (!terminal) return;

    /**
     * Se imita la rueda del ratón, pero **sólo cuando hay alguien escuchándola**.
     *
     * Si la aplicación de dentro captura el ratón —Claude Code lo hace— es ella quien recibe la
     * rueda y mueve su propio contenido, que es justo el que la persona está leyendo. Se despacha
     * un evento de verdad en vez de fabricar las secuencias a mano porque cuáles son depende del
     * modo que haya negociado la aplicación (SGR, urxvt, el X10 de toda la vida) y equivocarse
     * escribe basura dentro de la sesión.
     *
     * Cuando **nadie** captura el ratón no se puede despachar: con la pantalla alternativa activa
     * —y `tmux attach` la activa— xterm traduce la rueda a **flechas del cursor**, treinta de una
     * tacada. Eso en un `less` es cómodo y dentro de un agente es destructivo: navega su historial
     * de prompts y le cambia lo que tiene escrito.
     */
    const capturaElRaton = terminal.modes.mouseTrackingMode !== 'none';

    if (action === 'end') {
      // Lo que se puede hacer sin la aplicación: el buffer de aquí y el modo copia de tmux.
      terminal.scrollToBottom();
      sendTmuxScroll('end');
      /**
       * Y si la vista desplazada es la suya, la única forma de devolverla al presente es
       * arrastrar hasta abajo: no hay «ir al final» que mandarle. Se hace en ráfaga y espaciado,
       * no de golpe, porque cada rueda es una secuencia por línea y soltarle mil de una vez es
       * pedirle que se atragante.
       */
      if (capturaElRaton) {
        if (rafaga.current) clearInterval(rafaga.current);
        let quedan = 30;
        rafaga.current = setInterval(() => {
          rueda(1);
          quedan -= 1;
          if (quedan > 0) return;
          if (rafaga.current) clearInterval(rafaga.current);
          rafaga.current = null;
        }, 25);
      }
      return;
    }

    if (capturaElRaton) {
      rueda(action === 'up' ? -1 : 1);
      return;
    }

    // Nadie escucha el ratón: se mueve el buffer de aquí, y si está agotado, el de tmux.
    const antes = terminal.buffer.active.viewportY;
    terminal.scrollPages(action === 'up' ? -1 : 1);
    if (terminal.buffer.active.viewportY === antes) sendTmuxScroll(action);
  };

  /**
   * Mantener pulsado sigue desplazando.
   *
   * En un teléfono, subir un rato a base de toques son veinte toques. Se arranca con un desplazo
   * inmediato —para que un toque suelto siga siendo un toque— y sólo si el dedo sigue ahí pasados
   * unos instantes empieza a repetir, que es como se comporta cualquier tecla mantenida.
   */
  const mantener = (action: 'up' | 'down'): void => {
    soltar();
    sendScroll(action);
    repeticion.current.espera = setTimeout(() => {
      repeticion.current.repite = setInterval(() => sendScroll(action), 90);
    }, 350);
  };

  const soltar = (): void => {
    if (repeticion.current.espera) clearTimeout(repeticion.current.espera);
    if (repeticion.current.repite) clearInterval(repeticion.current.repite);
    repeticion.current.espera = null;
    repeticion.current.repite = null;
  };

  /** Reajusta la rejilla al hueco de ahora y se lo dice a tmux, que si no sigue pintando al viejo. */
  const refit = (): void => {
    const terminal = term.current;
    if (!terminal || !fitter.current) return;
    fitter.current.fit();
    if (socket.current?.readyState === WebSocket.OPEN) {
      socket.current.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    }
  };

  /**
   * Entrar y salir de pantalla completa.
   *
   * El estado manda sobre la clase CSS; la API nativa es un extra que puede no estar y puede
   * fallar —Safari la rechaza fuera de un gesto, y en un iframe hace falta permiso—, y ninguna de
   * esas dos cosas puede dejar al usuario atrapado en un modo del que no sabe salir.
   */
  function toggleImmersive(): void {
    const next = !immersive;
    setImmersive(next);
    const root = document.querySelector('.shell');
    try {
      if (next) void (root as HTMLElement | null)?.requestFullscreen?.();
      else if (document.fullscreenElement) void document.exitFullscreen();
    } catch {
      // El modo propio ya está puesto: que la API no quiera no cambia nada de lo que se ve.
    }
  }

  // Ningún temporizador sobrevive a la pantalla: seguirían desplazando una terminal que ya no está.
  useEffect(() => () => {
    soltar();
    if (rafaga.current) clearInterval(rafaga.current);
  }, []);

  useEffect(() => {
    const shell = document.querySelector('.shell');
    shell?.classList.toggle('terminal-immersive', immersive);
    /*
     * El hueco cambia de tamaño sin que la ventana cambie, así que el `resize` de siempre no se
     * dispara y nadie avisaría a tmux. Se espera un fotograma para medir después del reflow.
     */
    /*
     * Se mide varias veces a propósito.
     *
     * Al salir de pantalla completa hay dos cambios de tamaño encadenados y no simultáneos: el
     * del CSS, inmediato, y el del navegador devolviendo su barra cuando abandona su propio modo
     * de pantalla completa, que llega unos fotogramas después. Medir sólo en el primero deja la
     * rejilla con el tamaño grande dentro de un hueco que ya es pequeño.
     */
    const frame = requestAnimationFrame(() => refit());
    const tardios = [setTimeout(refit, 150), setTimeout(refit, 450)];
    /*
     * Salir con Escape se descartó a propósito: Escape es una tecla de trabajo dentro de una
     * terminal —vim, los menús de los agentes— y robársela para cerrar una vista sería quitarle
     * al usuario algo que necesita más. Se sale por el botón, que en este modo siempre se ve.
     */
    const onFullscreenChange = (): void => {
      if (!document.fullscreenElement) setImmersive(false);
      // Salir desde el navegador (Escape, o su propio botón) también cambia el hueco.
      setTimeout(refit, 150);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      cancelAnimationFrame(frame);
      for (const tardio of tardios) clearTimeout(tardio);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      shell?.classList.remove('terminal-immersive');
    };
  }, [immersive]);

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
          <label className="row small">
            <span className="muted">Puede</span>
            <select className="select control-md" value={profile} disabled={Boolean(attached)}
              onChange={(event) => setProfile(event.target.value as PermissionProfile)}>
              {(['safe', 'auto', 'yolo'] as const).map((value) => (
                <option key={value} value={value}>{PERMISSION[value].name}</option>
              ))}
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
        <Card className="terminal-live">
          {/*
            * Los controles van **encima** de la terminal y no debajo de las teclas: con el teclado
            * virtual abierto, todo lo que esté por debajo del TTY acaba fuera de la pantalla, que
            * es exactamente cuando hace falta poder subir a mirar lo que acaba de pasar.
            */}
          <div className="terminal-actions">
            <span className="row tight">
              <span className="tiny faint nowrap">Historial</span>
              {/*
                * `onPointerDown` empieza y `onClick` sólo actúa cuando vino del teclado
                * (`detail === 0`); si no, un toque contaría dos veces. `preventDefault` evita que
                * el dedo arrastre la página por debajo mientras se mantiene pulsado.
                */}
              <button type="button" className="btn small" aria-label="Subir en el historial de la sesión"
                title="Sube una pantalla; mantenlo pulsado para seguir subiendo"
                onPointerDown={(event) => { event.preventDefault(); mantener('up'); }}
                onPointerUp={soltar} onPointerLeave={soltar} onPointerCancel={soltar}
                onClick={(event) => { if (event.detail === 0) sendScroll('up'); }}>
                <Glyph icon={ACTION_ICON.scrollUp} />
                Subir
              </button>
              <button type="button" className="btn small" aria-label="Bajar en el historial de la sesión"
                title="Baja una pantalla; mantenlo pulsado para seguir bajando"
                onPointerDown={(event) => { event.preventDefault(); mantener('down'); }}
                onPointerUp={soltar} onPointerLeave={soltar} onPointerCancel={soltar}
                onClick={(event) => { if (event.detail === 0) sendScroll('down'); }}>
                <Glyph icon={ACTION_ICON.scrollDown} />
                Bajar
              </button>
              <button type="button" className="btn small" aria-label="Volver al final de la sesión"
                title="Vuelve a lo que está pasando ahora" onClick={() => sendScroll('end')}>
                <Glyph icon={ACTION_ICON.scrollEnd} />
                Al final
              </button>
            </span>
            <button type="button" className={`btn small${immersive ? ' primary' : ''}`}
              aria-pressed={immersive}
              aria-label={immersive ? 'Salir de pantalla completa' : 'Ver la terminal a pantalla completa'}
              title="La terminal ocupa toda la pantalla; el resto de la consola se aparta"
              onClick={() => toggleImmersive()}>
              <Glyph icon={immersive ? ACTION_ICON.exitFullscreen : ACTION_ICON.fullscreen} />
              {immersive ? 'Salir' : 'Pantalla completa'}
            </button>
          </div>
          <div className="terminal-host" ref={holder} />
          <div className="mobile-keys">
            {MOBILE_KEYS.map((key) => (
              <button key={key.label} type="button" className="btn small" onClick={() => sendKey(key.bytes)}>
                {key.label}
              </button>
            ))}
          </div>
          {immersive ? null : (
            <p className="small muted" style={{ margin: '10px 0 0' }}>
              Salir de esta pantalla no cierra la sesión: sigue viva en {attached.host}.
            </p>
          )}
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
