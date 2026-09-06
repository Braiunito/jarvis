/**
 * Lo que el asistente enseña cuando una frase no basta.
 *
 * Un artifact no es un mensaje más largo: es contenido con forma, y quien decide **cómo** se
 * presenta es quien lo produjo. La pantalla no lo adivina mirando el tamaño, porque el tamaño no
 * dice si algo es un apunte que se lee de paso o un informe que hay que mirar entero.
 *
 * Aquí sólo se pinta. La decisión de `inline`, `panel` o `modal` viene en la referencia, y este
 * fichero se limita a obedecerla.
 *
 * Los cinco tipos que se dibujan salen de piezas que ya existían —el markdown de las respuestas,
 * el visor de JSON de los eventos, los tres gráficos de `charts.tsx`, la tabla del markdown— y eso
 * es lo que hace que un artifact se lea como parte de la consola y no como algo pegado encima. El
 * sexto, `html`, es el único que dibuja lo que quiere, y por eso es el único que va enmarcado y
 * etiquetado.
 */
import type { JSX } from 'react';
import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { JsonView } from 'react-json-view-lite';
import type {
  ChartBody, ChatArtifact, ChatRef, TableBody,
} from '@jarvis/contracts';
import { useArtifact } from '../api/queries.js';
import { ErrorNote, Loading } from './bits.jsx';
import { Boundary } from './boundary.jsx';
import { Donut, Meter, Sparkbars, SERIES_COLORS } from './charts.jsx';
import { JSON_STYLES } from './event-log.jsx';
import { ACTION_ICON, Glyph, STATUS_ICON } from './icons.jsx';
import { Markdown } from './markdown.jsx';

export type ArtifactRef = Extract<ChatRef, { kind: 'artifact' }>;

/**
 * Los colores de un anillo cuyas claves no son proveedores conocidos.
 *
 * Tokens del tema, no valores fijos: es lo que hace que el mismo gráfico se lea en claro y en
 * oscuro. Van acompañados siempre de la leyenda con su etiqueta, así que el color no es el único
 * canal que distingue una porción de otra.
 */
const SLICE_COLORS = ['var(--accent)', 'var(--ok)', 'var(--warn)', 'var(--danger)', 'var(--running)', 'var(--text-faint)'];

/**
 * Un cuerpo que tenía que ser JSON y no lo es.
 *
 * Pasa: el cuerpo lo escribió un modelo y el core lo valida al guardarlo, pero entre las dos
 * puntas hay una versión del esquema que puede no coincidir. Un artifact que no se puede leer se
 * enseña en crudo en vez de dejar el hueco en blanco, porque lo que hay dentro sigue siendo la
 * respuesta a lo que alguien preguntó.
 */
function parsed<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

function Fallback({ body, note }: { body: string; note: string }): JSX.Element {
  return (
    <>
      <p className="tiny warn" style={{ margin: '0 0 6px' }}>{note}</p>
      <pre className="md-pre md-raw"><code>{body}</code></pre>
    </>
  );
}

function TableArtifact({ body }: { body: string }): JSX.Element {
  const data = parsed<TableBody>(body);
  if (!data?.columns?.length) {
    return <Fallback body={body} note="La tabla no vino con la forma esperada; va en crudo." />;
  }
  return (
    <div className="md-table-wrap">
      <table className="md-table">
        <thead>
          <tr>
            {data.columns.map((column) => (
              <th key={column.key} style={column.align === 'right' ? { textAlign: 'right' } : undefined}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, index) => (
            <tr key={index}>
              {data.columns.map((column) => {
                const cell = row[column.key];
                return (
                  <td key={column.key}
                    style={column.align === 'right' ? { textAlign: 'right' } : undefined}>
                    {/* Un hueco vacío se dice, no se deja en blanco: en blanco parece un fallo. */}
                    {cell === null || cell === undefined
                      ? <span className="faint">—</span>
                      : String(cell)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * El gráfico, con las tres formas que la casa sabe dibujar.
 *
 * El color no viene en el cuerpo: lo pone la interfaz con sus tokens. Es lo que hace que se vea
 * igual en claro y en oscuro sin que el modelo tenga que saber nada de temas.
 */
function ChartArtifact({ body }: { body: string }): JSX.Element {
  const data = parsed<ChartBody>(body);
  if (!data) return <Fallback body={body} note="El gráfico no vino con la forma esperada; va en crudo." />;

  if (data.shape === 'bars') {
    return <Sparkbars points={data.points} label={data.label} />;
  }
  if (data.shape === 'donut') {
    /*
     * El color lo pone la interfaz, con sus tokens: el cuerpo no lo trae y no debe traerlo, que es
     * lo que hace que se vea igual en claro y en oscuro. Si la clave resulta ser un proveedor
     * conocido se respeta su color de siempre, para que un anillo de agentes se lea igual aquí que
     * en la portada; el resto se reparten por orden.
     */
    const slices = data.slices.map((slice, index) => ({
      ...slice,
      color: SERIES_COLORS[slice.key] ?? SLICE_COLORS[index % SLICE_COLORS.length] ?? 'var(--text-faint)',
    }));
    return (
      /*
       * Con leyenda, siempre.
       *
       * El anillo distingue las porciones **sólo** por color —lleva su `aria-label` con todo, pero
       * mirándolo no hay otra cosa— y esta casa no separa estados por color a secas. La portada ya
       * lo resuelve así, con la leyenda al lado; aquí igual, y por el mismo motivo.
       */
      <div className="row" style={{ gap: 14, alignItems: 'center' }}>
        <Donut slices={slices} total={data.total} caption={data.caption} />
        <div className="legend" style={{ flex: 1, minWidth: 0 }}>
          {slices.map((slice) => (
            <div key={slice.key} className="row-item">
              <span className="swatch" style={{ background: slice.color }} />
              <span className="truncate">{slice.label}</span>
              <span className="faint">{slice.value}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="stack" style={{ gap: 5 }}>
      <div className="row between tiny">
        <span>{data.label}</span>
        <span className="faint">{data.value} de {data.max}</span>
      </div>
      <Meter value={data.value} max={data.max} {...(data.tone ? { tone: data.tone } : {})} />
    </div>
  );
}

/**
 * Un artifact HTML, que es el único que ejecuta.
 *
 * El aislamiento de verdad lo pone el servidor: la respuesta de `/raw` lleva el `sandbox` como
 * **directiva de CSP**, así que el documento tiene origen opaco se cargue donde se cargue —también
 * si alguien abre la URL en una pestaña—. El atributo de aquí es la segunda red, no la única, y por
 * eso `allow-scripts` va **sin** `allow-same-origin`: juntos se anulan mutuamente.
 *
 * Y va enmarcado y con etiqueta porque es el único que puede **parecerse a Jarvis**. Los demás los
 * pintan componentes de la casa con los tokens de la casa; éste dibuja lo que quiera, y lo escribió
 * un modelo que pudo haber leído algo hostil. Una tarjeta de aprobación falsa no puede autorizar
 * nada —no alcanza a la aplicación— pero sí puede pedirte una contraseña.
 */
function HtmlArtifact({ conversationId, artifact }: {
  conversationId: string;
  artifact: ChatArtifact;
}): JSX.Element {
  return (
    <div className="artifact-html">
      <p className="artifact-html-mark">
        <Glyph icon={ACTION_ICON.insecure} size={13} />
        <span>
          Contenido generado por el asistente, aislado. No es parte de la consola: no le des
          contraseñas ni te fíes de lo que diga que ha hecho.
        </span>
      </p>
      <iframe
        className="artifact-frame"
        title={`Artifact: ${artifact.title}`}
        src={`/api/chat/${conversationId}/artifacts/${artifact.id}/raw`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        loading="lazy"
      />
    </div>
  );
}

/**
 * Llevarse lo que se está mirando.
 *
 * Una tabla de treinta filas en una burbuja se lee, pero no se cruza con otra cosa ni se pega en un
 * informe; y volver a pedírsela al asistente cuesta una vuelta al modelo por algo que ya está
 * escrito. La descarga se arma **en el navegador**, con lo que ya está en pantalla: no hace falta
 * ruta nueva, ni permisos, ni que el artifact tenga una URL que compartir —eso último espera a que
 * el core sepa de quién es cada conversación—.
 *
 * Una tabla sale en CSV, que es lo que abre una hoja de cálculo; lo demás en su propio formato.
 */
function descargar(artifact: ChatArtifact): void {
  const seguro = artifact.title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase();
  let texto = artifact.body;
  let extension = artifact.kind === 'markdown' ? 'md' : artifact.kind === 'code' ? 'txt' : 'json';

  if (artifact.kind === 'table') {
    const datos = parsed<TableBody>(artifact.body);
    if (datos?.columns?.length) {
      /*
       * Comillas dobladas y campo entrecomillado siempre: es lo que hace que una celda con una coma
       * o un salto de línea no parta la fila. Con `String()` porque una celda puede ser número o
       * booleano.
       */
      const celda = (valor: unknown): string =>
        `"${(valor === null || valor === undefined ? '' : String(valor)).replace(/"/g, '""')}"`;
      const filas = [
        datos.columns.map((columna) => celda(columna.label)).join(','),
        ...datos.rows.map((fila) => datos.columns.map((columna) => celda(fila[columna.key])).join(',')),
      ];
      texto = filas.join('\n');
      extension = 'csv';
    }
  }

  const url = URL.createObjectURL(new Blob([texto], { type: 'text/plain;charset=utf-8' }));
  const enlace = document.createElement('a');
  enlace.href = url;
  enlace.download = `${seguro || 'artifact'}.${extension}`;
  enlace.click();
  URL.revokeObjectURL(url);
}

/** El cuerpo, por tipo. Cada uno con la pieza que ya usaba el resto de la consola. */
function Body({ conversationId, artifact }: {
  conversationId: string;
  artifact: ChatArtifact;
}): JSX.Element {
  switch (artifact.kind) {
    case 'markdown':
      return <Markdown source={artifact.body} />;
    case 'table':
      return <TableArtifact body={artifact.body} />;
    case 'chart':
      return <ChartArtifact body={artifact.body} />;
    case 'json': {
      const data = parsed<unknown>(artifact.body);
      return data === null
        ? <Fallback body={artifact.body} note="No se pudo leer como JSON; va en crudo." />
        : (
          <div className="jsonview">
            <JsonView data={data as object} style={JSON_STYLES} shouldExpandNode={(level) => level < 2} />
          </div>
        );
    }
    case 'code':
      return (
        <pre className="md-pre" {...(artifact.language ? { 'data-lang': artifact.language } : {})}>
          <code>{artifact.body}</code>
        </pre>
      );
    case 'html':
      return <HtmlArtifact conversationId={conversationId} artifact={artifact} />;
  }
}

/**
 * La cabecera: qué se mira y de dónde salió.
 *
 * El `caption` es la procedencia, y se enseña siempre que exista. Un bloque de datos sin decir de
 * dónde vienen es exactamente lo que esta consola no hace en ninguna otra pantalla.
 */
function Head({ artifact }: { artifact: ChatArtifact }): JSX.Element {
  return (
    <div className="artifact-head">
      <span className="row tight nowrap" style={{ minWidth: 0 }}>
        <Glyph icon={STATUS_ICON.folder} size={13} />
        <strong className="truncate">{artifact.title}</strong>
      </span>
      <span className="row tight nowrap">
        {artifact.truncated ? (
          <span className="badge warn tiny" title="No cabía entero: esto es una parte">recortado</span>
        ) : null}
        <span className="badge neutral tiny">{artifact.kind}</span>
        {/* El `html` no se descarga: un documento que ejecuta no se guarda en el disco de nadie. */}
        {artifact.kind !== 'html' ? (
          <button type="button" className="btn small ghost artifact-download"
            aria-label={`Descargar ${artifact.title}`}
            title={artifact.kind === 'table' ? 'Descargar en CSV' : 'Descargar'}
            onClick={() => descargar(artifact)}>
            <Glyph icon={ACTION_ICON.download} size={13} />
          </button>
        ) : null}
      </span>
      {artifact.caption ? <span className="tiny faint artifact-caption">{artifact.caption}</span> : null}
    </div>
  );
}

/** Un artifact ya cargado. Lo usan las tres presentaciones, para que se lean igual. */
export function ArtifactView({ conversationId, artifact }: {
  conversationId: string;
  artifact: ChatArtifact;
}): JSX.Element {
  return (
    <div className="artifact">
      <Head artifact={artifact} />
      {/*
        * El cuerpo va dentro de su propio anillo.
        *
        * Lo escribió un modelo y lo valida el core, pero validar cubre lo que se ha previsto. Una
        * celda con la forma equivocada —un objeto donde iba texto— desmontaría desde aquí hasta la
        * pantalla entera: sin hilo, sin compositor y sin saber por qué. Cayendo sólo esta caja, la
        * conversación se sigue leyendo y el cuerpo se enseña en crudo, que es lo que hay.
        */}
      <div className="artifact-body">
        <Boundary what={`el artifact «${artifact.title}»`} raw={artifact.body}>
          <Body conversationId={conversationId} artifact={artifact} />
        </Boundary>
      </div>
    </div>
  );
}

/**
 * El que hay que pedir: `panel` y `modal`.
 *
 * Se pide al abrirlo y no antes. Traer el cuerpo de algo que casi nadie pulsa sería pagar por
 * adelantado por la mayoría de los turnos.
 */
function LoadedArtifact({ conversationId, artifactId }: {
  conversationId: string;
  artifactId: string;
}): JSX.Element {
  const query = useArtifact(conversationId, artifactId);
  if (query.isLoading) return <Loading rows={3} shape="list" label="Trayendo el contenido…" />;
  if (query.error) return <ErrorNote error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return <Loading rows={2} shape="list" />;
  return <ArtifactView conversationId={conversationId} artifact={query.data} />;
}

/**
 * La pastilla que abre un `panel` o un `modal`.
 *
 * Dice el título y, debajo, lo que hay dentro contado en sus propias unidades —«12 filas · 4
 * columnas», «3 porciones»—. Es lo que separa un botón que se pulsa a ciegas de uno que se pulsa
 * sabiendo si detrás hay tres filas o trescientas.
 */
export function ArtifactChip({ conversationId, target }: {
  conversationId: string;
  target: ArtifactRef;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const modal = target.presentation === 'modal';

  return (
    <>
      <button type="button" className="artifact-chip" onClick={() => setOpen(true)}>
        <Glyph icon={modal ? ACTION_ICON.fullscreen : ACTION_ICON.expandJson} size={14} />
        <span className="cell-main">
          <span className="title truncate">{target.title}</span>
          {target.preview ? <span className="tiny faint truncate">{target.preview}</span> : null}
        </span>
        <span className="badge neutral tiny">{target.artifactKind}</span>
      </button>

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          {/*
            * El panel es un diálogo no modal a propósito: se consulta **mientras** se sigue
            * leyendo el hilo, que es lo que lo separa de un modal. El velo sólo va con el modal.
            *
            * Y es un componente propio y no las clases `.detail-sheet` de las otras pantallas:
            * aquéllas no tienen estilos por encima de 1180 px —ahí son una columna de un grid, no
            * un panel— así que reutilizarlas dejaba una tarjeta sin posicionar en escritorio.
            */}
          {modal ? <Dialog.Overlay className="artifact-overlay" /> : null}
          <Dialog.Content
            className={modal ? 'artifact-modal' : 'artifact-panel'}
            {...(modal ? {} : { onInteractOutside: (event: Event) => event.preventDefault() })}
          >
            <div className="artifact-sheet-head">
              <Dialog.Title className="truncate">{target.title}</Dialog.Title>
              <Dialog.Close asChild>
                <button type="button" className="btn small ghost" aria-label="Cerrar">
                  <Glyph icon={ACTION_ICON.reject} />
                </button>
              </Dialog.Close>
            </div>
            <div className="artifact-sheet-body">
              {open ? <LoadedArtifact conversationId={conversationId} artifactId={target.artifactId} /> : null}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

/**
 * Un `inline`, con su cuerpo ya delante.
 *
 * Si el cuerpo no llegó —un mensaje viejo, o un turno que se cortó— no se deja el hueco en blanco:
 * se ofrece abrirlo, que es lo único honesto que se puede decir ahí.
 */
export function InlineArtifact({ conversationId, target, artifact }: {
  conversationId: string;
  target: ArtifactRef;
  artifact: ChatArtifact | undefined;
}): JSX.Element {
  if (!artifact) return <ArtifactChip conversationId={conversationId} target={target} />;
  return <ArtifactView conversationId={conversationId} artifact={artifact} />;
}
