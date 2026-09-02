#!/usr/bin/env node
/** Un `codex` falso: el stream JSON de `codex exec` (codex-cli 0.149) y su `app-server`. */
const argv = process.argv.slice(2);
const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);

/**
 * `codex app-server --stdio`: el canal JSON-RPC por el que el core pregunta cuenta y cuotas.
 *
 * Responde sólo lo que el sondeo pide y se queda escuchando: quien llama cierra stdin cuando ya
 * tiene lo suyo. Sin esto, el consumo de la cuenta no se puede ver funcionando en local, y el
 * hueco en la consola parece un fallo del producto cuando es que aquí no hay CLI de verdad.
 */
function appServer() {
  const now = () => Math.floor(Date.now() / 1000);
  let pending = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.method === 'initialize') {
        emit({ id: message.id, result: { userAgent: 'codex-cli/0.149 (falso)' } });
      } else if (message.method === 'account/read') {
        emit({ id: message.id, result: { account: {
          email: 'operador@ejemplo.dev', planType: 'pro', type: 'chatgpt',
        } } });
      } else if (message.method === 'account/rateLimits/read') {
        emit({ id: message.id, result: { rateLimits: {
          primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: now() + 3600 },
          secondary: { usedPercent: 8, windowDurationMins: 10_080, resetsAt: now() + 86_400 },
        } } });
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
  setInterval(() => {}, 60_000);
}

function exec() {
  const prompt = argv.find((value, index) => index > 0 && !value.startsWith('-')
    && argv[index - 1] !== 'resume' && argv[index - 1] !== '-c' && argv[index - 1] !== '-m') ?? '';
  const resumeIndex = argv.indexOf('resume');
  const threadId = resumeIndex !== -1 ? argv[resumeIndex + 1] : 'thread-new';

  if (prompt.includes('@@fail')) {
    emit({ type: 'thread.started', thread_id: threadId });
    emit({ type: 'turn.failed', error: { message: 'sandbox denied the write' } });
    process.exit(1);
  }

  emit({ type: 'thread.started', thread_id: threadId });
  emit({ type: 'turn.started' });
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'command_execution',
    command: 'ls -la', aggregated_output: 'total 0', exit_code: 0 } });
  emit({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message',
    text: `listo: ${prompt.slice(0, 120)}` } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 4 } });
}

if (argv[0] === 'app-server') appServer();
else exec();
