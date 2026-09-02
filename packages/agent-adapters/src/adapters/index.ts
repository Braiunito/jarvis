import type { Provider } from '@jarvis/contracts';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { opencodeAdapter } from './opencode.js';
import type { AgentAdapter } from './types.js';

export const ADAPTERS: Record<Provider, AgentAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  opencode: opencodeAdapter,
};

export function getAdapter(provider: Provider): AgentAdapter {
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new Error(`unsupported provider: ${provider}`);
  return adapter;
}

export * from './types.js';
export { claudeAdapter, codexAdapter, opencodeAdapter };
