/**
 * Hard-coded known Copilot CLI model IDs. The CLI accepts `--model <id>` but
 * doesn't expose a list over ACP today, so we ship a curated set that maps
 * to what `copilot /model` shows in interactive mode. Add to this list as
 * Copilot publishes new models — no other code change required.
 */
export const COPILOT_MODELS = Object.freeze([
  { id: 'gpt-5', label: 'GPT-5' },
  { id: 'gpt-5-mini', label: 'GPT-5 Mini' },
  { id: 'claude-sonnet-4', label: 'Claude Sonnet 4' },
  { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
  { id: 'claude-opus-4', label: 'Claude Opus 4' },
  { id: 'gpt-4o', label: 'GPT-4o' },
  { id: 'o1', label: 'o1' },
]);

export const DEFAULT_COPILOT_MODEL = 'claude-sonnet-4.5';
