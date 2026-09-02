#!/usr/bin/env node
/**
 * Un `aisessions serve` de mentira, con la misma API HTTP que el de verdad.
 *
 * Sirve para levantar el stack completo en una máquina de desarrollo sin el sidecar Python ni
 * transcripts reales. Las rutas y la forma de las filas son las que expone `aisessions/serve.py`.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.JARVIS_FAKE_INDEX_PORT || 8765);

const now = Date.now();
const iso = (offsetMinutes) => new Date(now - offsetMinutes * 60_000).toISOString();

const SESSIONS = [
  {
    session_key: 'local:claude:sid-pool', host: 'local', provider: 'claude', session_id: 'sid-pool',
    path: '/home/dev/.claude/projects/app/sid-pool.jsonl', source_root: '/home/dev/.claude',
    cwd: '/tmp/jarvis-demo/app', title: 'timeout del pool de conexiones',
    preview: 'el pool se queda sin conexiones a las 3am y la API devuelve 502',
    created_at: iso(2880), updated_at: iso(45), model: 'claude-opus-5',
    size_bytes: 18_422, user_messages: 6, assistant_messages: 9, indexed_at: iso(5),
  },
  {
    session_key: 'local:codex:sid-deploy', host: 'local', provider: 'codex', session_id: 'sid-deploy',
    path: '/home/dev/.codex/sessions/sid-deploy.jsonl', source_root: '/home/dev/.codex',
    cwd: '/tmp/jarvis-demo/deploy', title: 'pipeline de despliegue en verde',
    preview: 'el paso de migraciones falla si la base está vacía',
    created_at: iso(6000), updated_at: iso(220), model: 'gpt-5-codex',
    size_bytes: 9_120, user_messages: 4, assistant_messages: 5, indexed_at: iso(5),
  },
  {
    session_key: 'serverB:claude:sid-nginx', host: 'serverB', provider: 'claude', session_id: 'sid-nginx',
    path: '/home/ops/.claude/projects/edge/sid-nginx.jsonl', source_root: '/home/ops/.claude',
    cwd: '/tmp/jarvis-demo/edge', title: 'certificado caducado en el borde',
    preview: 'renovar el certificado y recargar nginx sin cortar tráfico',
    created_at: iso(14_400), updated_at: iso(1_500), model: 'claude-sonnet-5',
    size_bytes: 4_800, user_messages: 2, assistant_messages: 3, indexed_at: iso(60),
  },
];

const TRANSCRIPTS = {
  'sid-pool': [
    { role: 'user', at: iso(2880), text: 'La API devuelve 502 a las 3am. ¿Puedes mirar el log?' },
    { role: 'assistant', at: iso(2875), text: 'He revisado app.log: el pool llega a 20 conexiones y se queda ahí.' },
    { role: 'user', at: iso(60), text: '¿Y si subimos el máximo del pool?' },
    { role: 'assistant', at: iso(45), text: 'Subir el máximo tapa el síntoma. Las conexiones no se devuelven: hay un `finally` que falta en el handler de reintentos.' },
  ],
  'sid-deploy': [
    { role: 'user', at: iso(6000), text: 'El pipeline falla en migraciones cuando la base está vacía.' },
    { role: 'assistant', at: iso(5990), text: 'La migración 0007 asume que existe la tabla de la 0003, que se saltó por un IF NOT EXISTS mal puesto.' },
  ],
  'sid-nginx': [
    { role: 'user', at: iso(14_400), text: 'Certificado caducado en el borde, hay que renovarlo.' },
    { role: 'assistant', at: iso(14_390), text: 'Renovado con certbot y recargado nginx con `-s reload`, sin cortar tráfico.' },
  ],
};

const send = (res, code, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const query = (name, fallback = '') => url.searchParams.get(name) ?? fallback;

  if (url.pathname === '/api/health') return send(res, 200, { ok: true });
  if (url.pathname === '/api/hosts') {
    return send(res, 200, [
      { host: 'local', sessions: SESSIONS.filter((s) => s.host === 'local').length, last_activity: iso(45) },
      { host: 'serverB', sessions: SESSIONS.filter((s) => s.host === 'serverB').length, last_activity: iso(1_500) },
    ]);
  }
  if (url.pathname === '/api/sessions' || url.pathname === '/api/search') {
    const provider = query('provider', 'all');
    const host = query('host', 'all');
    const needle = query('q').toLowerCase();
    const rows = SESSIONS.filter((session) => {
      if (provider !== 'all' && provider && session.provider !== provider) return false;
      if (host !== 'all' && host && session.host !== host && !(host === 'bastion' && session.host === 'local')) return false;
      if (needle && !`${session.title} ${session.preview}`.toLowerCase().includes(needle)) return false;
      return true;
    });
    return send(res, 200, rows.slice(0, Number(query('limit', '50'))));
  }
  if (url.pathname.startsWith('/api/export/')) {
    const key = decodeURIComponent(url.pathname.slice('/api/export/'.length));
    const session = SESSIONS.find((candidate) => candidate.session_key === key);
    if (!session) return send(res, 404, { error: 'session not found' });
    return send(res, 200, { messages: TRANSCRIPTS[session.session_id] ?? [], truncated: false });
  }
  return send(res, 404, { error: 'unknown endpoint' });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`fake aisessions index on http://127.0.0.1:${PORT}`);
});
