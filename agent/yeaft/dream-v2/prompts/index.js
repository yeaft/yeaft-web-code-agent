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
  extractSession: 'extract-session.md',
  extractTopic: 'extract-topic.md',
  // H2.e — per-scope summary compression
  summarizeScope: 'summarize-scope.md',
};

/**
 * Map a scope string (e.g. "user", "vp/alice", "topic/auth/jwt") to the
 * extraction template name. Unknown scopes fall back to `extractTopic`
 * (the most generic template) so we never throw at extraction time.
 *
 * (2026-05-13: `extractFeature` was removed along with the Feature
 * system; legacy `feature/*` scopes — if any remain in old data — fall
 * through to `extractTopic` here, which is harmless.)
 *
 * @param {string} scope
 * @returns {keyof typeof FILES}
 */
export function extractTemplateForScope(scope) {
  if (!scope || typeof scope !== 'string') return 'extractTopic';
  if (scope === 'user') return 'extractUser';
  // Nested group-isolated scopes must be matched BEFORE the bare `group/<g>`
  // branch so VPs/topics/features under a group don't get the group template.
  if (/^group\/[^/]+\/vp\//.test(scope)) return 'extractVp';
  if (/^group\/[^/]+\/topic\//.test(scope)) return 'extractTopic';
  if (/^group\/[^/]+\/user(?:\/|$)/.test(scope)) return 'extractUser';
  if (scope.startsWith('group/')) return 'extractSession';
  // Chat-isolated scopes: same template family as groups.
  if (/^chat\/[^/]+\/vp\//.test(scope)) return 'extractVp';
  if (scope.startsWith('chat/')) return 'extractSession';
  // Legacy top-level vp/topic scopes (archived to .legacy/ on boot — kept
  // here defensively in case something still constructs the old strings).
  if (scope.startsWith('vp/')) return 'extractVp';
  if (scope.startsWith('topic/')) return 'extractTopic';
  return 'extractTopic';
}

/** @type {Record<string, string>} */
const cache = {};

export function normalizePromptLanguage(language) {
  return String(language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function languageDirective(language) {
  return normalizePromptLanguage(language) === 'zh'
    ? '语言要求：请用中文生成所有自然语言内容，尤其是 memory_md 和 summary_md；工具名、scope、JSON key、schema 字段、代码标识符和枚举值必须保持英文。严格按要求输出 JSON 时，不要翻译 JSON key。'
    : 'Language requirement: write all natural-language memory content in English. Keep tool names, scopes, JSON keys, schema fields, code identifiers, and enum values in English. When strict JSON is required, do not rename JSON keys.';
}

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
 * @param {{ language?: string, includeLanguageDirective?: boolean }} [opts]
 */
export function render(name, vars, opts = {}) {
  const tpl = load(name);
  const body = tpl.replace(/\{\{(\w+)\}\}/g, (_m, key) => {
    if (!(key in vars)) throw new Error(`prompts.${name}: missing var ${key}`);
    return vars[key];
  });
  if (opts.includeLanguageDirective === false) return body;
  if (!opts.language) return body;
  return `${languageDirective(opts.language)}\n\n${body}`;
}

/** Test-only: drop the in-memory cache so a fresh read re-loads from disk. */
export function _resetCache() {
  for (const k of Object.keys(cache)) delete cache[k];
}
