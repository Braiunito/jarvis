#!/usr/bin/env node
/**
 * Un `claude` falso que habla stream-json como el de verdad (Claude Code 2.1.x).
 *
 * El comportamiento se dirige desde el propio prompt para que un test end-to-end pueda pedir un
 * fallo o un cuelgue sin canales laterales: `@@fail`, `@@hang`, `@@slow:<n>`, `@@big:<kib>`.
 */
const argv = process.argv.slice(2);

/**
 * `claude auth status --json`: lo que el core lee para saber de quién es la cuenta.
 *
 * Sin esto, el sondeo de cuenta y cuota no se puede probar en local y el badge de la consola sale
 * vacío en desarrollo por un motivo que no tiene nada que ver con el producto.
 */
if (argv[0] === 'auth' && argv[1] === 'status') {
  process.stdout.write(`${JSON.stringify({
    email: 'operador@ejemplo.dev',
    subscriptionType: 'max',
    authMethod: 'claude.ai',
  })}\n`);
  process.exit(0);
}

const promptIndex = argv.indexOf('-p');
const prompt = promptIndex !== -1 ? (argv[promptIndex + 1] ?? '') : '';
const resumeIndex = argv.indexOf('--resume');
const sessionId = resumeIndex !== -1 ? argv[resumeIndex + 1] : 'sid-claude-new';
const modeIndex = argv.indexOf('--permission-mode');
const permissionMode = modeIndex !== -1 ? argv[modeIndex + 1] : 'plan';

const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const directive = (name) => {
  const match = prompt.match(new RegExp(`@@${name}(?::(\\d+))?`));
  return match ? Number(match[1] ?? 1) : null;
};

/**
 * Sin `-p` esto es la CLI interactiva: se queda viva esperando lo que se teclee, que es lo que
 * hace que una tmux tenga sentido y que se pueda probar el attach de verdad.
 */
function interactive() {
  process.stdout.write('\r\n Claude Code (falso)  sesión ' + sessionId + '  modo ' + permissionMode + '\r\n');
  process.stdout.write(' > ');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    // Eco como haría un TTY, para que el test pueda comprobar que la entrada llegó.
    process.stdout.write(chunk.replace(/\r/g, '\r\n'));
    // `/usage` es una pantalla local de la CLI, y es de donde el core saca las cuotas. Se dibuja
    // con las mismas cabeceras y el mismo «N% used» que la de verdad, porque eso es exactamente
    // lo que el parser busca.
    if (chunk.includes('/usage')) {
      process.stdout.write('\r\n Current session\r\n');
      process.stdout.write(' █████░░░░░ 45% used\r\n');
      process.stdout.write(' Resets 2:30pm (Europe/Madrid)\r\n\r\n');
      process.stdout.write(' Current week (all models)\r\n');
      process.stdout.write(' ██░░░░░░░░ 12% used\r\n');
      process.stdout.write(' Resets Sep 8\r\n\r\n');
    }
    if (chunk.includes('/exit')) process.exit(0);
    if (chunk.includes('\r') || chunk.includes('\n')) process.stdout.write(' > ');
  });
  process.stdin.on('end', () => process.exit(0));
  setInterval(() => {}, 60_000);
}

async function main() {
  if (promptIndex === -1) {
    interactive();
    return;
  }

  emit({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-opus-5',
    cwd: process.cwd(), permissionMode, tools: ['Bash', 'Read'] });

  if (directive('fail') !== null) {
    process.stderr.write('claude: session not found\n');
    process.exit(1);
  }

  if (directive('hang') !== null) {
    // Ignora SIGINT a propósito: así se prueba la escalación de la cancelación.
    process.on('SIGINT', () => {});
    setInterval(() => {}, 1000);
    return;
  }

  const slow = directive('slow');
  if (slow !== null) {
    for (let i = 1; i <= slow; i += 1) {
      emit({ type: 'assistant', session_id: sessionId,
        message: { content: [{ type: 'text', text: `paso ${i}/${slow}\n` }] } });
      await sleep(200);
    }
  }

  const big = directive('big');
  if (big !== null) {
    emit({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use',
      id: 'tu_big', name: 'Bash', input: { command: 'cat huge.log' } }] } });
    emit({ type: 'user', session_id: sessionId, message: { content: [{ type: 'tool_result',
      tool_use_id: 'tu_big', content: 'x'.repeat(big * 1024) }] } });
  }

  emit({ type: 'assistant', session_id: sessionId,
    message: { content: [{ type: 'text', text: 'Revisé el log. ' }] } });
  emit({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use',
    id: 'tu_1', name: 'Bash', input: { command: 'tail -n 5 app.log' } }] } });
  emit({ type: 'user', session_id: sessionId, message: { content: [{ type: 'tool_result',
    tool_use_id: 'tu_1', content: 'ERROR timeout' }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId,
    result: `respuesta a: ${prompt.slice(0, 400)}`, num_turns: 2, total_cost_usd: 0.01, duration_ms: 900 });
}

main();
