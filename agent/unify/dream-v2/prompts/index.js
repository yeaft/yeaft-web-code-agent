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
};

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
