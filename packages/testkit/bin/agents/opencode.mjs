#!/usr/bin/env node
/** Un `opencode run` falso: los registros que emite opencode 1.17 con --format json. */
const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1] ?? '';
const sessionIndex = argv.indexOf('--session');
const sessionID = sessionIndex !== -1 ? argv[sessionIndex + 1] : 'ses_new';
const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);

emit({ type: 'step_start', sessionID, part: { type: 'step-start' } });
emit({ type: 'text', sessionID, part: { type: 'text', text: `hecho: ${prompt.slice(0, 120)}` } });
emit({ type: 'step_finish', sessionID,
  part: { type: 'step-finish', reason: 'stop', tokens: { total: 10 }, cost: 0 } });
