/**
 * Lo que el asistente enseña, servido de verdad por HTTP.
 *
 * Lo que se prueba aquí no se puede probar con un repositorio en memoria: que el documento que
 * ejecuta JavaScript sale **con el aislamiento en la respuesta** y no confiado a que alguien lo
 * meta en el iframe correcto, y que un artifact `inline` llega con la conversación y con el frame
 * del stream, que es donde se veía el hueco.
 */
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeSessionIndex, fakeSshPath, indexRow } from '@jarvis/testkit';
import { buildApp } from '../../apps/core/src/app.js';
import { buildServices, type CoreServices } from '../../apps/core/src/services.js';
import { openDatabase } from '../../apps/core/src/platform/db.js';
import { ArtifactRepository } from '../../apps/core/src/chat/artifacts.js';
import { systemClock } from '../../apps/core/src/platform/clock.js';

const root = mkdtempSync(join(tmpdir(), 'jarvis-artifacts-'));
const INTERNAL_SECRET = process.env['JARVIS_INTERNAL_SECRET'] as string;

let services: CoreServices;
let sinHtml: CoreServices;
let app: ReturnType<typeof buildApp>;
let appSinHtml: ReturnType<typeof buildApp>;
let baseUrl: string;
let baseUrlSinHtml: string;
let artifacts: ArtifactRepository;
let conversationId: string;

function identityHeader(): string {
  const payload = { userId: 'u1', username: 'braian', requestId: 'req_test', exp: Math.floor(Date.now() / 1000) + 60 };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', Buffer.from(INTERNAL_SECRET, 'utf8')).update(body).digest('base64url');
  return `${body}.${mac}`;
}
const authed = (): Record<string, string> => ({ 'x-jarvis-identity': identityHeader() });

const build = (path: string, extra: Record<string, unknown> = {}): CoreServices => buildServices({
  db: openDatabase({ path: join(root, path) }),
  index: new FakeSessionIndex([indexRow()]) as never,
  config: {
    hosts: ['bastion'], bastionHost: 'bastion', sshCommand: fakeSshPath(), knownHostsFile: '',
    spoolRoot: join(root, 'spool'), internalSecret: INTERNAL_SECRET, ...extra,
  },
});

const listen = async (target: CoreServices): Promise<[ReturnType<typeof buildApp>, string]> => {
  const built = buildApp({ services: target, logger: false });
  await built.listen({ port: 0, host: '127.0.0.1' });
  const address = built.server.address();
  return [built, typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''];
};

/** Una conversación con un mensaje: aquí interesa lo que se sirve, no cómo se llegó a ello. */
function seed(target: CoreServices, repository: ArtifactRepository): string {
  const now = new Date().toISOString();
  target.db.prepare(`INSERT INTO conversations
    (id, title, created_by, workspace_id, autonomy, status, source, created_at, updated_at, last_message_at)
    VALUES ('c-art', 'prueba', 'braian', NULL, 'manual', 'idle', 'local', ?, ?, ?)`).run(now, now, now);
  const inline = repository.create('c-art', {
    kind: 'markdown', presentation: 'inline', title: 'Resumen', body: 'lo que averigüé',
  }) as { id: string };
  target.db.prepare(`INSERT INTO chat_messages
    (id, conversation_id, seq, role, text, tool_name, tool_input, tool_ok, source, model_id,
     approval_id, run_ids, refs_json, created_at)
    VALUES ('m-art', 'c-art', 0, 'assistant', 'aquí lo tienes', NULL, NULL, NULL, 'local', 'x',
            NULL, '[]', ?, ?)`)
    .run(JSON.stringify([{
      kind: 'artifact', artifactId: inline.id, artifactKind: 'markdown',
      presentation: 'inline', title: 'Resumen', bytes: 15, preview: 'lo que averigüé',
    }]), now);
  repository.attach([inline.id], 'm-art');
  return 'c-art';
}

beforeAll(async () => {
  services = build('core.db');
  sinHtml = build('sin-html.db', { allowHtmlArtifacts: false });
  artifacts = new ArtifactRepository({ db: services.db, clock: systemClock });
  conversationId = seed(services, artifacts);
  seed(sinHtml, new ArtifactRepository({ db: sinHtml.db, clock: systemClock }));
  [app, baseUrl] = await listen(services);
  [appSinHtml, baseUrlSinHtml] = await listen(sinHtml);
});

afterAll(async () => {
  await app.close();
  await appSinHtml.close();
  services.close();
  sinHtml.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
});

const html = (target = artifacts, conversation = conversationId): string => (target.create(conversation, {
  kind: 'html', presentation: 'panel', title: 'Informe',
  body: '<p>hola</p><script>fetch("/api/chat")</script>',
}) as { id: string }).id;

describe('ARTIFACT · el documento sale con su propio aislamiento', () => {
  it('el sandbox va en la respuesta, no confiado al atributo del iframe', async () => {
    const response = await fetch(`${baseUrl}/api/chat/${conversationId}/artifacts/${html()}/raw`, { headers: authed() });
    const csp = response.headers.get('content-security-policy') ?? '';

    expect(response.status).toBe(200);
    // Sin esto, abrir el enlace en una pestaña carga el documento en el origen de la aplicación,
    // con la cookie de sesión. Eso es XSS almacenado, y el atributo del iframe no lo evita.
    expect(csp).toContain('sandbox allow-scripts');
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it('NUNCA lleva allow-same-origin: con las dos juntas el frame se quita el sandbox', async () => {
    const response = await fetch(`${baseUrl}/api/chat/${conversationId}/artifacts/${html()}/raw`, { headers: authed() });

    expect(response.headers.get('content-security-policy')).not.toContain('allow-same-origin');
  });

  it('una lista blanca sin `default-src` deja permitido lo que no nombra', async () => {
    const response = await fetch(`${baseUrl}/api/chat/${conversationId}/artifacts/${html()}/raw`, { headers: authed() });
    const csp = response.headers.get('content-security-policy') ?? '';

    /*
     * Ésta es la que faltaba y por la que se salía. Comprobamos `connect`, `img` y `form`, y de ahí
     * concluimos que no había ninguna salida — pero `frame-src` no estaba declarado, así que un
     * `<iframe src="http://…">` dentro del artifact cargaba. Con `default-src 'none'` delante, lo
     * que no se nombra queda prohibido en vez de permitido.
     */
    expect(csp.startsWith("default-src 'none'")).toBe(true);
    for (const directiva of ["frame-src 'none'", "child-src 'none'", "worker-src 'none'", "media-src 'none'"]) {
      expect(csp).toContain(directiva);
    }
  });

  it('y no se sirve como pestaña: el sandbox restringe frames, no al documento raíz', async () => {
    const id = html();
    const comoPagina = await fetch(`${baseUrl}/api/chat/${conversationId}/artifacts/${id}/raw`,
      { headers: { ...authed(), 'sec-fetch-dest': 'document' } });
    const comoIframe = await fetch(`${baseUrl}/api/chat/${conversationId}/artifacts/${id}/raw`,
      { headers: { ...authed(), 'sec-fetch-dest': 'iframe' } });

    // Abierto a pelo, `location.href` navegaba y se llevaba lo que quisiera contar.
    expect(comoPagina.status).toBe(403);
    expect(comoIframe.status).toBe(200);
  });

  it('no puede llamar a casa: ni exfiltrar lo que lleva ni contar que lo abriste', async () => {
    const response = await fetch(`${baseUrl}/api/chat/${conversationId}/artifacts/${html()}/raw`, { headers: authed() });
    const csp = response.headers.get('content-security-policy') ?? '';

    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain('img-src data:');
    // Estas dos no heredan de `default-src`: sin declararlas, un formulario con envío automático
    // exfiltra y una `<base>` reescribe a dónde va todo lo demás.
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('el script llega entero: aislarlo no es prohibirlo', async () => {
    const response = await fetch(`${baseUrl}/api/chat/${conversationId}/artifacts/${html()}/raw`, { headers: authed() });
    const csp = response.headers.get('content-security-policy') ?? '';

    // Con `default-src 'none'` el script no correría, que sería aislar lo que ya no se ejecuta.
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(await response.text()).toContain('<script>');
  });

  it('una casa que no los quiera puede apagarlos', async () => {
    const otro = new ArtifactRepository({ db: sinHtml.db, clock: systemClock });
    const response = await fetch(
      `${baseUrlSinHtml}/api/chat/c-art/artifacts/${html(otro, 'c-art')}/raw`, { headers: authed() },
    );

    expect(response.status).toBe(403);
  });

  it('lo que no es un documento no se sirve como documento', async () => {
    const id = (artifacts.create(conversationId, {
      kind: 'markdown', presentation: 'panel', title: 'Nota', body: 'texto',
    }) as { id: string }).id;
    const response = await fetch(`${baseUrl}/api/chat/${conversationId}/artifacts/${id}/raw`, { headers: authed() });

    expect(response.status).toBe(400);
  });

  it('y un artifact de otra conversación no existe para ésta', async () => {
    const response = await fetch(`${baseUrl}/api/chat/${conversationId}/artifacts/tnoexiste/raw`, { headers: authed() });

    expect(response.status).toBe(404);
  });
});

describe('ARTIFACT · el cuerpo llega por donde se consume', () => {
  it('la conversación trae los inline: si no, la primera pintada tiene un hueco', async () => {
    const response = await fetch(`${baseUrl}/api/chat/${conversationId}`, { headers: authed() });
    const body = await response.json() as { artifacts: Array<{ body: string; presentation: string }> };

    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]!.body).toBe('lo que averigüé');
    expect(body.artifacts[0]!.presentation).toBe('inline');
  });

  it('y el frame del stream también, que es como llega una respuesta en vivo', async () => {
    const response = await fetch(`${baseUrl}/events/chat/${conversationId}`, { headers: authed() });
    const reader = response.body!.getReader();
    let buffer = '';
    while (!buffer.includes('event: chat.message')) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);
    }
    await reader.cancel();

    const linea = buffer.split('\n').find((part) => part.startsWith('data: {"id":"m-art"'));
    const frame = JSON.parse(linea!.slice('data: '.length)) as {
      seq: number; artifacts?: Array<{ body: string }>;
    };
    // Aditivo: sigue siendo el mensaje, con una clave más cuando hay algo que enseñar.
    expect(frame.seq).toBe(0);
    expect(frame.artifacts?.[0]?.body).toBe('lo que averigüé');
  });

  it('un cuerpo suelto se pide por su id y viene entero', async () => {
    const id = (artifacts.create(conversationId, {
      kind: 'json', presentation: 'modal', title: 'Salida', body: '{"ok":true}',
    }) as { id: string }).id;
    const response = await fetch(`${baseUrl}/api/chat/${conversationId}/artifacts/${id}`, { headers: authed() });
    const body = await response.json() as { artifact: { body: string; preview?: string } };

    expect(response.status).toBe(200);
    expect(body.artifact.body).toBe('{"ok":true}');
  });
});
