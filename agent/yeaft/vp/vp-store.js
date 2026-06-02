/**
 * vp-store.js — Virtual Person (VP) store.
 *
 * Scans `~/.yeaft/virtual-persons/<vp-name>/role.md` and produces VP records.
 * role.md is a Markdown file with YAML frontmatter:
 *
 *   ---
 *   id: alice
 *   name: Alice
 *   role: Product Manager
 *   modelHint: primary
 *   traits:
 *     - curious
 *     - pragmatic
 *   ---
 *   (body = VP persona / system-prompt-shaped description)
 *
 * Per task-334a spec hard constraint (a): this module does NOT import the
 * 334o storage layer. Memory bootstrap is `mkdir -p` only — no shard-store
 * touches.
 */

import { readFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';

/**
 * @typedef {Object} VP
 * @property {string} id              — VP id (default: dir name)
 * @property {string} name
 * @property {string} role
 * @property {string} area            — taxonomy bucket (e.g. 'philosophy', 'investing'); '' if absent.
 *                                       Optional, additive: no consumer is required to dispatch on it.
 *                                       Sidebar grouping by area is intentionally a future PR.
 * @property {string[]} traits
 * @property {'fast'|'primary'|undefined} modelHint
 * @property {string} persona         — markdown body (persona / system prompt seed)
 * @property {string} personaHash     — sha256(persona).slice(0,8); changes when persona body changes
 * @property {string} planInstruction — optional per-VP planning style (used by `StartPlan`
 *                                       tool); '' means "fall back to the default template".
 *                                       Frontmatter scalar key `planInstruction`.
 * @property {string} dir             — absolute path to VP dir
 * @property {string} memoryDir       — absolute path to VP memory dir
 * @property {number} mtimeMs         — role.md mtime (for hot-reload)
 */

export const DEFAULT_VP_LIB_DIR = join(homedir(), '.yeaft', 'virtual-persons');

/**
 * Hash a persona body to a short stable fingerprint. Single definition for
 * the project — anyone comparing two persona bodies (vp-store at load time,
 * seed-topup when stamping the ledger, web-bridge live-diff, etc.) must
 * route through this helper so the algorithm cannot silently diverge.
 *
 * Format: sha256(persona).slice(0,8) — short enough to log, long enough
 * that accidental collisions across <100 VPs are astronomically unlikely.
 *
 * @param {string} persona
 * @returns {string}
 */
export function personaHash(persona) {
  return createHash('sha256').update(String(persona || '')).digest('hex').slice(0, 8);
}

/**
 * Parse YAML frontmatter + body from role.md.
 * Minimal parser (scalars + bullet lists), same shape as personas.js.
 *
 * @param {string} source
 * @returns {{ meta: Record<string, any>, body: string }}
 */
export function parseRoleMd(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: source };

  const [, yaml, body] = match;
  /** @type {Record<string, any>} */
  const meta = {};
  const lines = yaml.split(/\r?\n/);
  let currentList = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    const listMatch = line.match(/^\s+-\s+(.+?)\s*$/);
    if (listMatch && currentList) {
      currentList.push(listMatch[1].replace(/^['"]|['"]$/g, ''));
      continue;
    }
    const kvMatch = line.match(/^([\w-]+):\s*(.*)$/);
    if (kvMatch) {
      const [, key, raw] = kvMatch;
      const value = raw.trim();
      if (!value) {
        currentList = [];
        meta[key] = currentList;
      } else {
        meta[key] = value.replace(/^['"]|['"]$/g, '');
        currentList = null;
      }
    }
  }

  return { meta, body: body.trim() };
}

/**
 * Load a single VP from an absolute VP directory.
 * Returns null if role.md is missing or has no usable id.
 *
 * Side effect: ensures `<dir>/memory/` exists (mkdir -p only — per hard
 * constraint (a), we do not touch shard-store).
 *
 * @param {string} dir
 * @returns {VP|null}
 */
export function loadVpFromDir(dir) {
  const rolePath = join(dir, 'role.md');
  let source;
  let st;
  try {
    source = readFileSync(rolePath, 'utf-8');
    st = statSync(rolePath);
  } catch {
    return null;
  }

  const { meta, body } = parseRoleMd(source);
  const dirName = dir.split(/[\\/]/).filter(Boolean).pop() || '';
  const id = String(meta.id || dirName).trim();
  if (!id) return null;

  const memoryDir = join(dir, 'memory');
  try {
    mkdirSync(memoryDir, { recursive: true });
  } catch {
    // best-effort; do not fail load on mkdir error
  }

  const modelHintRaw = typeof meta.modelHint === 'string' ? meta.modelHint : undefined;
  const modelHint = modelHintRaw === 'primary' || modelHintRaw === 'fast' ? modelHintRaw : undefined;

  // personaHash: sync sha256 of persona body, first 8 hex chars.
  // Computed at load time (not lazy) so downstream consumers (system prompt
  // builders, web-bridge live-diff in 334h) can compare cheaply.
  const personaHashValue = personaHash(body);

  /** @type {VP} */
  return {
    id,
    name: String(meta.name || id),
    // task-fix (5-bugs): optional localized names + pinyin aliases for
    // bilingual display + @-mention pinyin-prefix matching. Missing fields
    // degrade gracefully to [] / ''.
    nameZh: typeof meta.nameZh === 'string' ? String(meta.nameZh) : '',
    aliases: Array.isArray(meta.aliases)
      ? meta.aliases.map(String).map(s => s.trim()).filter(Boolean)
      : [],
    role: String(meta.role || ''),
    roleZh: typeof meta.roleZh === 'string' ? String(meta.roleZh) : '',
    // Taxonomy bucket for sidebar grouping / filtering. Absent for legacy
    // role.md files written before this field existed — consumers MUST
    // treat '' as "uncategorised", never as a default category.
    area: typeof meta.area === 'string' ? String(meta.area).trim() : '',
    traits: Array.isArray(meta.traits) ? meta.traits.map(String) : [],
    modelHint,
    persona: body,
    personaHash: personaHashValue,
    // Optional per-VP planning style for the `StartPlan` tool. Stored as a
    // raw scalar string in role.md frontmatter (`planInstruction: "..."`).
    // Empty / missing → the tool falls back to the default template. Kept
    // verbatim — the tool itself is responsible for any framing.
    planInstruction: typeof meta.planInstruction === 'string' ? String(meta.planInstruction) : '',
    dir,
    memoryDir,
    mtimeMs: st.mtimeMs,
  };
}

/**
 * Scan a VP library root (default `~/.yeaft/virtual-persons`).
 *
 * @param {{ dir?: string }} [options]
 * @returns {VP[]}
 */
export function scanVpLibrary(options = {}) {
  const { dir = DEFAULT_VP_LIB_DIR } = options;
  if (!existsSync(dir)) return [];

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const vps = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const vp = loadVpFromDir(join(dir, entry.name));
    if (vp) vps.push(vp);
  }
  return vps;
}

/**
 * Count VPs in the library without loading full records.
 * Cheap API for G1 empty-library fallback (acceptance #4).
 *
 * @param {{ dir?: string }} [options]
 * @returns {number}
 */
export function count(options = {}) {
  const { dir = DEFAULT_VP_LIB_DIR } = options;
  if (!existsSync(dir)) return 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let n = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const rolePath = join(dir, entry.name, 'role.md');
    if (existsSync(rolePath)) n++;
  }
  return n;
}
