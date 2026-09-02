/**
 * Servir el build de la SPA.
 *
 * Los paths se resuelven y luego se comprueba que siguen bajo la raíz: sin eso, `/../../etc/passwd`
 * se escapa del directorio. El fallback a index.html es sólo para rutas — un asset que falta da
 * 404, porque responder `/assets/index-OLD.js` con un documento HTML produce `Unexpected token '<'`
 * dentro de la aplicación y esconde el error de despliegue que lo causó.
 *
 * Contrato EDGE-STATIC-01.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { FastifyReply } from 'fastify';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const ASSET_EXTENSIONS = new Set(Object.keys(MIME).filter((ext) => ext !== '.html'));

/**
 * Si lo que falta era un fichero o una página de la aplicación.
 *
 * Decidirlo por la forma del nombre mantiene viva una ruta con un punto (`/run/1.5`) mientras
 * `/assets/index-OLD.js` —la petición clásica de un navegador con la versión anterior en caché—
 * se reconoce por lo que es.
 */
function isAssetRequest(urlPath: string): boolean {
  const name = urlPath.replace(/\\/g, '/');
  if (name.startsWith('/assets/')) return true;
  return ASSET_EXTENSIONS.has(extname(name).toLowerCase());
}

/** Un hash de contenido en el nombre: `index-D3f8Ka2b.js`. */
const HASHED_NAME = /-[A-Za-z0-9_]{8,}\.[a-z0-9]+$/;

/**
 * Cuánto puede cachearse un fichero, decidido por la forma del nombre y no por su extensión.
 *
 * Sólo un nombre con hash puede cachearse para siempre: si cambia el fichero, cambia el nombre.
 * Todo lo servido con nombre estable debe revalidarse, o un icono nuevo jamás llega a un
 * navegador que ya visitó una vez.
 */
function cacheControlFor(servedPath: string, isHtml: boolean): string {
  if (isHtml) return 'no-cache';
  const name = servedPath.replace(/\\/g, '/');
  if (name.startsWith('/assets/') || HASHED_NAME.test(name)) {
    return 'public, max-age=31536000, immutable';
  }
  return 'public, max-age=300, must-revalidate';
}

/** Cabeceras de seguridad base. La CSP es estricta: esta SPA no ejecuta código de terceros. */
export function securityHeaders(reply: FastifyReply, { isHtml }: { isHtml: boolean }, secureCookies: boolean): void {
  void reply.header('X-Content-Type-Options', 'nosniff');
  void reply.header('Referrer-Policy', 'no-referrer');
  void reply.header('X-Frame-Options', 'DENY');
  void reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  void reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  if (secureCookies) {
    void reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (isHtml) {
    void reply.header('Content-Security-Policy', [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "worker-src 'self' blob:",
      "connect-src 'self'",
    ].join('; '));
  }
}

export interface StaticResult { served: boolean; status?: number; message?: string }

export function serveStatic(
  reply: FastifyReply, root: string, urlPath: string,
  { spaFallback = true, secureCookies = true }: { spaFallback?: boolean; secureCookies?: boolean } = {},
): StaticResult {
  if (!existsSync(root)) {
    return { served: false, status: 503, message: `static directory ${root} is not present (was the app built?)` };
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0] as string);
  } catch {
    return { served: false, status: 400, message: 'malformed request target' };
  }
  let candidate = resolve(join(root, normalize(decoded)));
  const rootResolved = resolve(root);
  // El separador importa: sin él, `/srv/jarvis-web-evil` pasa por dentro de `/srv/jarvis-web`.
  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + sep)) {
    return { served: false, status: 403, message: 'forbidden' };
  }
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    candidate = join(candidate, 'index.html');
  }
  if (!existsSync(candidate)) {
    if (!spaFallback || isAssetRequest(decoded)) return { served: false, status: 404, message: 'not found' };
    candidate = join(rootResolved, 'index.html');
    if (!existsSync(candidate)) return { served: false, status: 404, message: 'not found' };
  }
  const ext = extname(candidate).toLowerCase();
  const isHtml = ext === '.html';
  securityHeaders(reply, { isHtml }, secureCookies);
  void reply
    .code(200)
    .header('Content-Type', MIME[ext] ?? 'application/octet-stream')
    .header('Content-Length', statSync(candidate).size)
    .header('Cache-Control', cacheControlFor(candidate.slice(rootResolved.length), isHtml))
    .send(createReadStream(candidate));
  return { served: true };
}
