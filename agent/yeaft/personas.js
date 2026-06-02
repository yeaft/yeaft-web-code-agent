/**
 * personas.js — Preset persona loader for sub-agents.
 *
 * A persona defines a sub-agent's role: which tools it can use, which
 * model tier it runs on, and what system prompt it carries.
 *
 * Presets live as markdown files with YAML frontmatter in
 * `agent/yeaft/templates/personas/*.md`.
 */

import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PERSONAS_DIR = join(__dirname, 'templates', 'personas');

/**
 * @typedef {Object} Persona
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {'fast'|'primary'} modelTier
 * @property {string[]} tools
 * @property {string} systemPrompt
 */

/** @type {Map<string, Persona>|null} */
let cached = null;

/**
 * Parse YAML frontmatter + body from a markdown file.
 * Minimal parser for the fields we use (no external dep).
 *
 * @param {string} source
 * @returns {{ meta: object, body: string }}
 */
export function parseFrontmatter(source) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: source };

  const [, yaml, body] = match;
  const meta = {};
  const lines = yaml.split('\n');
  let currentKey = null;
  let currentList = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    const listMatch = line.match(/^\s+-\s+(.+?)\s*$/);
    if (listMatch && currentList) {
      currentList.push(listMatch[1]);
      continue;
    }
    const kvMatch = line.match(/^([\w-]+):\s*(.*)$/);
    if (kvMatch) {
      const [, key, value] = kvMatch;
      if (!value.trim()) {
        currentList = [];
        meta[key] = currentList;
        currentKey = key;
      } else {
        meta[key] = value.trim();
        currentKey = key;
        currentList = null;
      }
    }
  }

  return { meta, body: body.trim() };
}

/**
 * Load all built-in personas from templates/personas/*.md.
 *
 * @param {{ dir?: string, fresh?: boolean }} [options]
 * @returns {Map<string, Persona>}
 */
export function loadPersonas(options = {}) {
  const { dir = PERSONAS_DIR, fresh = false } = options;
  if (!fresh && cached) return cached;

  const map = new Map();
  let files;
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.md'));
  } catch {
    if (!fresh) cached = map;
    return map;
  }

  for (const file of files) {
    try {
      const source = readFileSync(join(dir, file), 'utf-8');
      const { meta, body } = parseFrontmatter(source);
      if (!meta.id) continue;
      const persona = {
        id: String(meta.id),
        name: String(meta.name || meta.id),
        description: String(meta.description || ''),
        modelTier: meta.modelTier === 'primary' ? 'primary' : 'fast',
        tools: Array.isArray(meta.tools) ? meta.tools.map(String) : [],
        systemPrompt: body,
      };
      map.set(persona.id, persona);
    } catch {
      // skip bad files
    }
  }

  if (!fresh) cached = map;
  return map;
}

/**
 * Get a persona by id. Returns undefined if not found.
 * @param {string} id
 * @returns {Persona|undefined}
 */
export function getPersona(id) {
  if (!id) return undefined;
  return loadPersonas().get(id);
}

/** @returns {string[]} */
export function listPersonaIds() {
  return Array.from(loadPersonas().keys());
}

/** Clear cache (for tests). */
export function _resetPersonaCache() {
  cached = null;
}
