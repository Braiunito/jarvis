#!/usr/bin/env node
/** Un `codex exec` falso: el stream JSON que emite codex-cli 0.149. */
const argv = process.argv.slice(2);
const prompt = argv.find((value, index) => index > 0 && !value.startsWith('-')
  && argv[index - 1] !== 'resume' && argv[index - 1] !== '-c' && argv[index - 1] !== '-m') ?? '';
const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
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
