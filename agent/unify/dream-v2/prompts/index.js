/**
 * dream-v2/prompts/index.js — load + render the four dream prompts.
 *
 * Prompts live as `.md` files in this directory. We read once and cache.
 * Rendering is plain `{{name}}` substitution; no nested logic, no escaping —
 * the prompts are inputs to an LLM and the templates are author-controlled.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FILES = {
  triagePass1: 'triage-pass1.md',
  triagePass2: 'triage-pass2.md',
  update: 'update.md',
  create: 'create.md',
  // H2.e — per-scope segment extraction prompts (one per scope family)
  extractUser: 'extract-user.md',
  extractVp: 'extract-vp.md',
  extractGroup: 'extract-group.md',
  extractFeature: 'extract-feature.md',
  extractTopic: 'extract-topic.md',
  // H2.e — per-scope summary compression
  summarizeScope: 'summarize-scope.md',
};

/**
 * Map a scope string (e.g. "user", "vp/alice", "topic/auth/jwt") to the
 * extraction template name. Unknown scopes fall back to `extractTopic`
 * (the most generic template) so we never throw at extraction time.
 *
 * @param {string} scope
 * @returns {keyof typeof FILES}
 */
export function extractTemplateForScope(scope) {
  if (!scope || typeof scope !== 'string') return 'extractTopic';
  if (scope === 'user') return 'extractUser';
  if (scope.startsWith('vp/')) return 'extractVp';
  if (scope.startsWith('group/')) return 'extractGroup';
  if (scope.startsWith('feature/')) return 'extractFeature';
  if (scope.startsWith('topic/')) return 'extractTopic';
  return 'extractTopic';
}

/** @type {Record<string, string>} */
const cache = {};

function load(name) {
  if (cache[name]) return cache[name];
  const file = FILES[name];
  if (!file) throw new Error(`prompts: unknown template ${name}`);
  const txt = readFileSync(join(__dirname, file), 'utf8');
  cache[name] = txt;
  return txt;
}

/**
 * Render a template with `{{name}}` substitution. Missing keys throw —
 * silent rendering of half-built prompts has bitten us before.
 *
 * @param {string} name
 * @param {Record<string, string>} vars
 */
export function render(name, vars) {
  const tpl = load(name);
  return tpl.replace(/\{\{(\w+)\}\}/g, (_m, key) => {
    if (!(key in vars)) throw new Error(`prompts.${name}: missing var ${key}`);
    return vars[key];
  });
}

/** Test-only: drop the in-memory cache so a fresh read re-loads from disk. */
export function _resetCache() {
  for (const k of Object.keys(cache)) delete cache[k];
}
